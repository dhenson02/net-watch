# 00 — Foundation

The shared infrastructure every chart plan depends on.

## Goals

- Add ECharts to the client, with one React wrapper, one palette and one set
  of formatters.
- Add client-side routing with state kept in the URL, plus the page shells
  (Live, History, Process).
- Add a server-side **live hub**: one Redis stream reader that keeps a compact
  in-memory ring buffer and fans ticks out to browsers over SSE.
- Add ClickHouse query helpers: a range and resolution picker, parameter
  validation and 64-bit-safe output.

## Dependencies

```
npm i echarts
```

Nothing else is needed. The router is small enough to write in-house (below),
and SSE uses the raw Fastify reply, so no plugin is needed. Import ECharts
modularly (`echarts/core` plus the chart and component modules each chart
uses) to keep the bundle small. Register the modules once, in
`client/charts/echarts.ts`.

## Server

### New files

```
src/server/
  live/
    hub.ts            LiveHub: XREAD loop, ring buffer, subscriber fan-out
    compact.ts        snapshot JSON → CompactTick (below)
  ch/
    query.ts          chQuery<T>(sql, params, signal) wrapper; timing + logging
    range.ts          parseRange(query) → { from, to, step, table }
  routes/
    live.ts           /api/live/*
    history.ts        /api/history/*   (charts 05–08, 11–14, 16)
    process.ts        /api/process/*   (charts 09, 10, 14, 15, 17)
```

`index.ts` registers the new route modules the same way it registers
`healthRoutes(app, deps)`. Add `hub` to `deps`.

### Live hub (`live/hub.ts`)

Each tick's snapshot contains every process and every flow. Sending full
snapshots to every browser, or re-reading 3600 of them for a backfill, would
move megabytes. Instead the server reads the stream once and keeps compact
aggregates.

- **Dedicated connection.** `XREAD BLOCK` holds its connection, so create it
  with `redis.duplicate()`. The shared client has `disableOfflineQueue`, and
  blocking on it would stall `/api/health`.
- **Startup backfill.** Read `XREVRANGE netwatch:stream + - COUNT <n>` in pages
  of 300 and compact each entry. `n = LIVE_BACKFILL` (env, default 900 =
  15 min at 1 s). Loading the full 3600 ticks is possible but slow to parse,
  so it is opt-in.
- **Loop.** Run `XREAD BLOCK 5000 COUNT 50 STREAMS netwatch:stream <lastId>`,
  compact each entry and push it into the ring buffer (capacity =
  `LIVE_BACKFILL`), then notify subscribers.
  - If Redis drops, keep `lastId` and resume from it after reconnect.
  - If the gap is larger than the stream (`XINFO STREAM` first-entry-id >
    lastId), mark a gap in the buffer. Charts draw it as a break instead of a
    straight line.
- **Latest full snapshot.** Keep the last parsed snapshot (not only the
  compact form). `/api/live/snapshot` and the Sankey read it without another
  Redis round trip.

`CompactTick` (in `shared/api.ts`):

```ts
export interface CompactTick {
  ts: number;             // ts_ms
  intervalMs: number;
  drops: number;          // cumulative since collector start (see 04)
  nProcs: number;         // live processes in this tick
  nFlows: number;
  txKbps: number;         // sum over processes
  rxKbps: number;
  procs: { id: string; name: string; tx: number; rx: number }[]; // only procs with tx|rx > 0; kbps
  apps: Record<string, [tx: number, rx: number]>;                 // kbps by app label (from flows)
}
```

Build `id` as `${pid}:${start_ns}`. Take `start_ns` from the raw JSON text
(below) to keep precision.

### 64-bit IDs

`start_ns` is ns since boot. JavaScript numbers lose integer precision above
2^53 ns, which is **about 104 days of uptime**. On a long-running host,
`JSON.parse` silently rounds `start_ns`, and the ID then points to a Redis key
that does not exist.

- **Server.** Parse snapshots with a reviver that uses the `context.source`
  argument (Node ≥ 21 supports the JSON.parse source text access proposal) to
  keep `start_ns` as a string: `(k, v, ctx) => k === 'start_ns' ? ctx.source : v`.
  Add a unit test with `start_ns = 18446744073709551000`.
- **ClickHouse.** The client returns UInt64 as JSON strings by default
  (`output_format_json_quote_64bit_integers=1`). Keep that default and type
  those fields as `string`. Byte sums are also UInt64. Convert them with
  `Number()` after aggregation. Summed byte counts stay far below 2^53.

### SSE endpoint

`GET /api/live/events` with `Content-Type: text/event-stream`:

- On connect, send `event: hello` with `{ latestTs }`. The client already has
  the history from `/api/live/series`.
- On each tick, send `event: tick` with `data: <CompactTick JSON>`.
- Send a `:keepalive` comment every 15 s.
- Remove the subscriber on `req.raw.on('close')`.
- Set `logLevel: 'warn'` on the route, like `/api/health`.
- Set `reply.raw.setHeader('X-Accel-Buffering','no')` in case a proxy ever
  sits in front.
- Call `reply.hijack()` so Fastify does not try to serialize a response.

`GET /api/live/series?seconds=900` returns `CompactTick[]` from the ring
buffer, oldest first.

### ClickHouse helpers

`ch/range.ts`: every history endpoint accepts `from`, `to` (ms) and an
optional `step` (s):

| span | default step | table |
|---|---|---|
| ≤ 2 h | 10 s | `flows` (raw) |
| ≤ 3 d | 60 s | `flows_1m` |
| ≤ 30 d | 15 min | `flows_1m` |
| > 30 d | 1 h | `flows_1m` |

- Clamp `to - from` to 2 years and the point count to about 1500.
- Reject non-integer or reversed ranges with 400.
- Queries use `toStartOfInterval(<col>, INTERVAL {step:UInt32} SECOND)`.
- `<col>` is `ts` or `minute`, chosen from a fixed whitelist, never taken
  from user input.

`ch/query.ts`: wraps `client.query({ format: 'JSONEachRow', query_params, abort_signal })`.

- Pass the request's abort signal so that closing the browser tab cancels the
  query. Hook it up through `req.raw.on('close')`.
- Log the elapsed ms at debug level.
- Map ClickHouse errors to 502 with the message.

**Query-shape rules (every plan follows these):**

- `flows_1m` is a SummingMergeTree. Always `sum()` with `GROUP BY`, even for
  one key, because unmerged parts hold duplicate keys.
- `processes` is a ReplacingMergeTree. Use `FINAL`, or `argMax(col, version)`
  grouped by `(pid, proc_start)`.
- `flows` is ordered by `(pid, proc_start, ts)`. Queries across all processes
  over a time range rely on partition pruning (`toDate(ts)`) and the
  `ts_minmax` skip index, so keep raw-table windows ≤ 6 h unless the query
  also filters by pid.
- Convert rates for the wire: `kbps = bytes * 8 / 1000 / step_seconds`. On
  raw `flows`, divide by `interval_ms` instead of assuming 1 s.
- Render IPs with one SQL snippet constant so they match Redis's plain-IPv4
  display: `DISPLAY_IP = "replaceRegexpOne(IPv6NumToString(raddr), '^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$', '\\1')"`.
  For filters going the other way (user types `1.2.3.4`), use
  `toIPv6({ip:String})`, which maps IPv4 input to `::ffff:…`. Check this
  against the running ClickHouse version in the integration script.
- Set a per-query `max_execution_time` of 20 s. `readonly=2` allows it.

### Timezone

Endpoints that bucket by hour or day accept `tz`, an IANA name from
`Intl.DateTimeFormat().resolvedOptions().timeZone`. Validate it against
`SELECT count() FROM system.time_zones WHERE time_zone = {tz:String}` and
cache the result. Pass it to `toHour(minute, {tz:String})` and similar
functions.

## Client

### New files

```
src/client/
  router.ts               usePath(), navigate(), useSearchParam(name, default)
  pages/
    LivePage.tsx
    HistoryPage.tsx
    ProcessPage.tsx
  charts/
    echarts.ts            modular registration (use/…)
    EChart.tsx            <EChart option={…} onEvents={…} group?="…"/>, ResizeObserver, theme switch
    palette.ts            categorical slots + "other" grey + tx/rx pair; light/dark
    format.ts             fmtBytes, fmtRate (kbps→Mbps/Gbps), fmtDuration, fmtTime(tz)
    theme.ts              ECharts theme objects built from CSS vars
  components/
    Panel.tsx             titled card, subtitle, loading/error/empty states, footnote slot
    RangePicker.tsx       presets (15m,1h,6h,24h,7d,30d) + custom; writes ?from&to
    SegmentedControl.tsx  group-by and mode toggles
    Toggle.tsx
  hooks/
    useQuery.ts           fetch with AbortController, keyed by URL, stale-while-revalidate
    useLive.ts            loads /api/live/series then EventSource /api/live/events; returns ring buffer
  api.ts                  (existing) + typed endpoint helpers
```

### Router

The server already falls back to `index.html`, so add no router dependency.

- `usePath()` subscribes to `popstate`.
- `navigate(url)` calls `history.pushState` and then dispatches `popstate`.
- `App.tsx` switches on a small route table.
- Links are `<a href>` with an `onClick` that calls `navigate` for plain left
  clicks, so middle-click still works.

### `<EChart>` wrapper

- Initialize on mount, call `setOption(option, { notMerge: false, lazyUpdate: true })`
  on change, and dispose on unmount.
- Watch the container size with a `ResizeObserver`.
- Watch `matchMedia('(prefers-color-scheme: dark)')`. On change, dispose and
  re-init with the other theme, because ECharts cannot switch themes in place.
- For live charts, do not rebuild the whole option each tick. Call
  `chart.setOption({ series: [{ id, data }] })` with only the new data through
  a ref (`useEChartRef`).
- Pass `group` to call `echarts.connect(group)` for linked cursors (charts 05,
  14 and the overlays).

### Palette and color stability

Load the `dataviz` skill before writing `palette.ts`.

- Use 8 categorical slots plus a neutral grey for "other".
- tx and rx get a fixed pair used everywhere (tx = warm, rx = cool). Every
  chart must use the same sign convention: **tx is drawn above zero, rx below.**
- Series colors must not reshuffle when the top-N ranking changes. Keep a
  `Map<name, slot>` per page session.
  - Assign the lowest free slot on first appearance.
  - Free a slot only after its series has been gone for 60 s.

### Formatting

- Rates are **kbps** on the wire. Display them with SI prefixes
  (`fmtRate(12_400) → "12.4 Mbps"`).
- Byte totals use IEC units (`KiB`/`MiB`), matching `formatReadableSize` in
  the README.
- Every chart subtitle says **"application payload (excludes headers and
  retransmits)"**, or the Panel footnote does.

## Testing

- Server unit tests use `node --test`. Add `"test": "node --test src/server/**/*.test.ts"`.
  - `compact.ts` against a fixture snapshot. Copy the JSON produced by the
    Rust `sample_tick()` into `src/server/live/fixtures/`.
  - The reviver's precision for 64-bit `start_ns`.
  - `parseRange` edge cases.
- One ignored-by-default integration script (`npm run test:int`) that hits
  every endpoint against the compose stack and checks the response shapes.
- `npm run typecheck` must pass.

## Docs

- Update `web/README.md`: add the API table rows as endpoints land, the new
  env vars (`LIVE_BACKFILL`) and the client layout tree.
- Update `web/CLAUDE.md`: add the 64-bit ID rule and the "one SSE hub, not
  per-client XREAD" rule.
