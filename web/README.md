# net-watch-web

Web dashboard for [net-watch](../README.md). It is a standalone app: one Node
process serves the React SPA and a small JSON API that reads Redis (realtime)
and ClickHouse (history). It shares no files with the Rust collector, only the
databases.

## Why a web server (and not Electron/Tauri)

The databases listen on `127.0.0.1` on the monitored host, which is usually
headless. A server that runs next to them needs no extra network exposure, and
any browser can reach it through an SSH tunnel. A desktop app would need a
display on that host, or the databases opened to the network.

## Run

Requires Node ≥ 22.18. TypeScript runs directly under Node's type stripping,
so the server needs no build step.

```sh
cd web
cp .env.example .env        # optional; the defaults match the compose stack
npm ci
npm run build               # bundles the SPA into dist/client
npm start                   # http://127.0.0.1:8787
```

From another machine: `ssh -L 8787:127.0.0.1:8787 <host>`, then open
http://localhost:8787.

## Develop

```sh
npm run dev         # API on :8787 (node --watch) + Vite on :5173 with HMR
npm run typecheck   # client and server tsconfigs
npm test            # unit tests (node --test): server, plus pure client modules (src/client/**/*.test.ts)
npm run test:int    # every endpoint against the compose stack (needs `docker compose up -d --wait`)
```

Open http://127.0.0.1:5173. Vite proxies `/api/*` to the API server.

## Configuration

Environment variables, or `web/.env` (real environment variables win):

| variable | default |
|---|---|
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `8787` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `netwatch` / `netwatch` |
| `CLICKHOUSE_DATABASE` | `netwatch` |
| `LOG_LEVEL` | `info` |
| `LIVE_BACKFILL` | `900`: ticks (1 s each) the live hub loads at startup and keeps in memory. The stream holds up to 3600; loading all of them is slower to parse. |

The API starts and stays up even when a database is down. Redis reconnects in
the background, and `/api/health` reports the state of each backend.

## API

| route | |
|---|---|
| `GET /api/health` | status, latency and version of Redis and ClickHouse (always 200 while the API is up) |
| `GET /api/live/series?seconds=900` | `CompactTick[]` from the hub's ring buffer, oldest first (`seconds` 1..86400) |
| `GET /api/live/events` | SSE: `hello` `{latestTs}` on connect, then one `tick` (a `CompactTick`) per collector tick, `:keepalive` every 15 s |
| `GET /api/live/snapshot` | the latest snapshot's process list (`LiveSnapshotResponse`: rates, totals, flow count, username; cmdline cut to 300 chars) from memory; 503 until the first tick |
| `GET /api/live/flows?seconds=10` | flows of the hub's last ticks (`seconds` 1..30; the hub keeps the full `flows` of 30 ticks) grouped by process name, proto, app, remote ip and port: mean kbps per tick, largest first (`LiveFlowsResponse`); the live Sankey |
| `GET /api/live/meta` | `netwatch:meta` (last tick, interval, drops) plus the sizes of `netwatch:alive` and `netwatch:ended`; 503 while Redis is down |
| `GET /api/history/summary?from&to&<filters>` | payload bytes and process count over a range |
| `GET /api/history/flows?from&to&limit=300&<filters>` | bytes per (process name, proto, app, ip, port) over a range, largest first, `limit` 1..2000 (`truncated` says whether more matched). Raw `flows` up to 2 h, else `flows_1m` from the minute `from` falls in. Each row's `id` is the busiest instance of the name, for click-through |
| `GET /api/history/throughput?from&to&step&by=app&dir=both&top=8&compare=1d\|1w&unknown=1&calls=1&<filters>` | kbps per bucket stacked by `by` (`app`, `name`, `proto`, `uid`, `dest`): the top `top` (5..20) keys over the whole range, ranked by `dir` (`both`/`total`: tx + rx, `tx`, `rx`), plus `__other` (`ThroughputResponse`, column-oriented, every key zero-padded to every bucket). `from` is rounded down to a bucket start; a bucket cut short by `to` is divided by the time it covers. `labels` names uids (`jay (1000)`). `compare` adds `compare`: the same window one day or week earlier, totals only (tx, rx kbps, no per-key split), always from `flows_1m` in whole-minute buckets, filtered alike and shifted forward onto this range's times; buckets before the table's first minute are null (`since`), and `compare` is null when the whole earlier window predates the data. `unknown=1` adds `unknown`: per bucket (aligned with `t`, same table), the tx + rx bytes with `app = 'unknown'`, all bytes, and their `share` (0..1, null where the bucket had no traffic), filtered alike. `calls=1` adds `calls`: send and receive calls per second per bucket (aligned with `t`, same table and filters), totals only, not per key. The queries run in parallel |
| `GET /api/history/burst?from&to&step&dir=total&<filters>` (or `&pid&start`) | the peak vs average band (13): per bucket of the same aligned range and step as `/api/history/throughput`, `mean` (kbps: the bucket's bytes over all the time it covers, idle seconds included) and the nearest-rank `p95` and `max` of the per-tick kbps (`BurstResponse`). Always raw `flows`: first summed per tick (`ts`) over the matching flows, then per bucket; idle ticks write no rows, so the per-tick samples are padded with zeros up to covered time / tick interval before the p95 and max. `dir` is `total` (default), `tx`, `rx` or `both` (tx and rx in one scan, for the mirrored chart). Over all processes the range must be ≤ 24 h (400 `band needs ≤ 24 h range`), since the scan is by time; `pid` + `start` read one instance by the primary key, any range. A query over the time limit is a 504 suggesting a shorter range |
| `GET /api/history/lifecycle?from&to&names=a,b&uid&limit=200` | process instances whose first network I/O (`first_seen`, not the exec time) or end falls in the range, largest lifetime total (tx + rx) first, `limit` 1..1000 (`LifecycleResponse`: `id`, pid, name, the first 120 chars of the cmdline, `firstSeenMs`, `endedMs`, `bytes`; `truncated` says whether more matched). `names` (comma-separated, at most 50) and `uid` narrow it; the History page's start/end marker track |
| `GET /api/history/lifetimes?from&to&name&uid&limit=500` | process instances whose lifetime overlaps the range (started before `to`, not ended before `from`; a missing end counts as running), latest start first, `limit` 1..2000 (`LifetimesResponse`: `id`, pid, name, the first 120 chars of the cmdline, uid, `startMs` (exec), `firstSeenMs`/`lastSeenMs` (network I/O), `endedMs` (null while running), lifetime `tx`/`rx`; `truncated` says whether earlier starts were left out). `name` and `uid` are exact matches; the History page's process lifetime Gantt and the Process page's instances of the same name |
| `GET /api/history/scatter?from&to&group=instance&basis=lifetime&limit=2000&<filters>` | bytes sent and received per process instance (`group=instance`) or per name (`name`: summed, with the instance count and the busiest instance's `id`), largest first, `limit` 1..5000 (`ScatterResponse`; `truncated` says whether more matched). `basis=lifetime` takes `processes`' lifetime totals of the instances whose lifetime overlaps the range; `basis=range` sums the bytes within the range (raw `flows` up to 2 h, else `flows_1m`). With `<filters>`, only instances with matching traffic in the range; the History page's tx vs rx scatter |
| `GET /api/history/heatmap?from&to&tz&metric=total\|tx\|rx&split=app&<filters>` | average kbps per (weekday, hour) in `tz` (IANA, default UTC) over the range (default: the last 28 days, at most 366), from `flows_1m` (`HeatmapResponse`: 168 cells, `dow * 24 + hour`, Monday first). A cell is its bytes divided by how often that weekday-hour occurs in the part of the range the rollup covers (`coveredFrom`: its first minute when later than `from`), counted on the server (`samples`), so an hour without traffic still counts; null where there is no sample. `active` counts the dates with traffic per cell. `split=app` gives one grid per top-4 app (by the metric); the History page's activity heatmap |
| `GET /api/history/treemap?from&to&dir=total\|tx\|rx&<filters>` | bytes per user → process name → app over the range, nested and largest first at every level (`TreemapResponse`: `users[]` of `{ name, uid, value, children: [{ name, value, folded?, children: [{ name: app, value }] }] }`, `total`). Raw `flows` up to 2 h (it has `uid`), else `flows_1m` with uid joined from `processes` (`flowSource`); the same range condition as `/summary`, so `total` matches it. Each user keeps its 30 largest processes and sums the rest into `other (N processes)` (`folded: N`). Users are named from /etc/passwd, `uid N` without an entry (containers), `unknown uid` for 4294967295; the History page's bandwidth treemap |
| `GET /api/history/bytes-per-call?from&to&dir=tx\|rx&by=app\|name&pid&start&<filters>` | calls per log2 bucket of bytes per call (21 buckets: bucket `b` is `[2^b, 2^(b+1))` bytes, 0 also takes under 1 B, 20 is 1 MiB and up) with their bytes, per app or process name (`BytesPerCallResponse`: `total`, then `rows`, the 10 keys with the most calls and the rest folded into a `key: null` row, `folded` keys). `dir` picks send (default) or receive calls. Each source row adds its mean, bytes / calls, weighted by its calls, so a histogram is a distribution of per-flow-tick means (raw `flows`, up to 2 h) or per-flow-minute means (`flows_1m`, summed per flow-minute first), not of single calls. `pid` + `start` (together) narrow it to one instance, always from raw flows. The History page's bytes-per-call heatmap |
| `GET /api/history/beacons?name&from&to` | the beaconing strip (15) over every instance of process `name` (required, exact): ticks merged per (ip, port) across instances, labelled with the proto and app with the most bytes; otherwise as `/api/process/:pid/:start/beacons`. It scans raw `flows` by time, so the range (default: the last hour) is cut to its last 6 h (`capped`) |
| `GET /api/history/ingest` | newest `flows.ts` and the row count of the last minute, to show whether the collector's ClickHouse sink keeps up |
| `GET /api/process/:pid/:start` | one process instance from `processes`; 404 if unknown |
| `GET /api/process/:pid/:start/calls?from&to&step` | one instance's kbps and calls per second per bucket (`ProcessCallsResponse`, zero-filled, ~1500 buckets at most), always from raw `flows` (its key starts with pid, proc_start), whatever the span; an unknown instance gives zeros. The Process page's bytes vs calls panel |
| `GET /api/process/:pid/:start/bytes-per-call?from&to&dir=tx\|rx&by` | one instance's bytes-per-call histogram, from raw `flows` whatever the span: the same answer as `/api/history/bytes-per-call?pid&start`; an unknown instance gives an empty one. The Process page's bytes-per-call histogram |
| `GET /api/process/:pid/:start/beacons?from&to` | the beaconing strip (15): this instance's active ticks per destination (ip, port, proto, app), the 100 with the most ticks, each with its periodicity (`BeaconsResponse`). Ticks are merged into bursts (runs no more than 1.5 collector intervals apart); `period_s` is the median gap between burst starts, `cv` their stddev / mean, `score` = 1 − cv with ≥ 6 bursts and cv < 0.15, else 0. Destinations sorted by score, then ticks. Each dot carries its bytes and the gap since the previous burst; past 60k dots in all, busy rows are merged into whole-second bins (`binned_ms`). `from`/`to` default to the instance's networked lifetime; the range is cut to its last 24 h (`capped`). Raw `flows` by its primary key; an unknown instance gives no rows |

`<filters>` are optional exact matches, all ANDed: `name`, `app`, `proto`,
`uid`, and `dest=ip:port` (IPv6 as `[addr]:port`). `flows_1m` has no uid
column, so grouping or filtering it by uid joins `processes`; rows whose
process is unknown there get uid 4294967295 ("unknown uid").

Errors are `{ "error": "…" }` with a 4xx/5xx status; ClickHouse failures are
502, and a query stopped by the 20 s `max_execution_time` is 504. History endpoints take `from`/`to` in ms (default: the last hour) and an
optional `step` in s. The server picks the table and step: raw `flows` up to
2 h, `flows_1m` beyond, at most ~1500 buckets. A request cancelled by the
browser cancels its ClickHouse query.

### Live hub

One server-side reader follows `netwatch:stream` on its own Redis connection
(`XREAD BLOCK`), keeps the last `LIVE_BACKFILL` ticks in a compact form plus the
latest full snapshot, and fans ticks out to browsers over SSE. Browsers never
read the stream themselves. After an outage it resumes from the last id it
read; ticks lost meanwhile (stream trimmed, collector stopped) are flagged with
`gap: true` on the next tick so charts draw a break.

## Layout

```
src/server/    Fastify API + static hosting of dist/client (SPA fallback)
  db/          Redis and ClickHouse clients and their health probes
  live/        LiveHub (stream reader, ring buffer, SSE fan-out), snapshot compaction
  ch/          chQuery, parseRange, SQL fragments (DISPLAY_IP, BY_COLUMNS, filters, flowSource), the throughput
               query and its padding/rate conversion (throughput.ts), the process lifecycle query
               (lifecycle.ts), the process lifetimes query (lifetimes.ts), one instance's bytes and calls (calls.ts), the burst band's per-tick query and p95/max padding (burst.ts), the bytes-per-call histogram query and its top-10 folding (bytesPerCall.ts), the tx vs rx scatter query (scatter.ts), the hour × weekday heatmap query and its per-cell sample count (heatmap.ts), the uid → process → app
               treemap query and its nesting (treemap.ts), the beaconing strip's per-destination tick arrays,
               dot binning and range caps (beacons.ts), timezone check
  analysis/    pure analyses of query results: periodicity.ts (bursts, period, cv, score; 15)
  routes/      one module per API area (health, live, history, process)
  users.ts     uid → username from /etc/passwd (read at startup, refreshed hourly)
src/client/    React SPA (Vite root)
  router.ts    usePath / navigate / useSearchParam / Link; all page state is in the URL
  pages/       Live, History, Process (a header panel, then one wide panel per section: 09 instances of the same name, 14 bytes vs calls, 10 bytes per call, …)
  charts/      ECharts registration, <EChart>, palette (incl. fixed app hues), formatters, themes,
               FlowSankey (Live + History panels) and its pure graph builder buildSankey,
               mirroredStack (the stacked tx/rx area chart option shared by Live and History throughput),
               SmallMultiples + smallMultiples.ts (N grids on one shared time axis: linked cursor, one zoom)
  history/     History page sections: ThroughputChart (05), useThroughput (URL state + query) and its pure
               series/drill-down logic throughputSeries.ts; LifecycleTrack (12, process start/end markers
               under the throughput chart) and its pure event/clustering logic clusterMarkers.ts;
               TxRxScatter (08, sent vs received per process, log-log) and its pure logic scatterPoints.ts;
               ghost.ts (11, the week-over-week ghost lines, tooltip lookup and deviation shading);
               burst.ts (13, the peak vs average band series and its tooltip lookup);
               ActivityHeatmap (06, average rate per hour × weekday, log color scale, small multiples per app) and
               its pure logic heatmapCells.ts (own window, log values, the latest occurrence of a cell);
               BandwidthTreemap (07, bytes per user → process → app as a treemap or sunburst, root in red) and
               its pure logic treemapData.ts (user colors, series data, tooltip text);
               UnknownShareTrack (16, the unknown-protocol share under the throughput chart) and its pure
               logic unknownShare.ts; useFollowZoom (a track under the chart follows its zoom);
               ProcessGantt (09, one bar per process instance, lanes per name, colored by bytes; also on the
               Process page) and its pure lane packing and lane statistics packLanes.ts;
               CallsPanel (14, bytes/s, calls/s and bytes per call as small multiples on one time axis; History and
               Process page) and its pure logic callsSeries.ts;
               BytesPerCall (10, calls by log2 bucket of bytes per call: a row-normalized heatmap on History,
               a bar histogram with the median on the Process page) and its pure logic bytesPerCall.ts
  process/     Process page sections: BeaconStrip (15, a dot per active tick per destination with each row's
               period and cv, plus the periodic-connections table) and its pure logic beaconStrip.ts
  live/        Live page sections (HealthStrip, LiveThroughput + its pure series builder useLiveThroughput,
               TopTalkers + its pure row logic topTalkers.ts, useSnapshot)
  components/  Panel, StatTile, Sparkline (inline SVG), RangePicker, SegmentedControl, Toggle, StatusPill
  hooks/       useQuery (fetch + abort + stale-while-revalidate), usePoll, useLive, useNow, useTimeRange
src/shared/    API response types, imported by both sides
```

Routes: `/` → `/live` (`?live_win=5m|15m|max&live_by=name|id&sort=[-]key&q=filter&idle=show&flow_dir=tx|rx`), `/history?from&to&by=app|name|proto|uid|dest&dir=both|tx|rx|total&top=5..20&filter.name|app|proto|uid|dest=…&flow_dir=tx|rx&events=starts|all&compare=1d|1w&band=1&unknown=1&scatter_by=name&scatter_basis=range&heat_metric=tx|rx&heat_split=app&heat_weeks=1|12&tm=sunburst&tm_dir=tx|rx&gantt_sort=bytes&calls=1&bpc_dir=rx&bpc_by=name` (default range: the last 24 h; the `filter.*` params apply to the totals, the throughput chart, the calls panel, the bytes per call, the activity heatmap, the bandwidth treemap, the scatter and the flow diagram, and `filter.name`/`filter.uid` to the process lifetimes; `scatter_by`/`scatter_basis` pick the scatter's point (instance by default) and totals (lifetime by default); `events` shows process start, or start and end, markers under the throughput chart, off by default; `compare` draws the same window one day or week earlier as a dashed line behind the throughput stack, shading runs of 3+ minutes above twice it; `band=1` (the "Burst band" toggle, disabled beyond 24 h) shades each bucket from its mean (the stack's top) up to the p95 of its per-tick rates and dots its busiest tick, per side when mirrored, with a "per tick" tooltip row (mean · p95 · max · burst ratio = p95 / mean); `unknown=1` adds a track under the throughput chart with the share of bytes the collector labelled `unknown`, dashed at the range's median; clicking it sets `filter.app=unknown&by=dest`; the activity heatmap has its own window, `heat_weeks` whole weeks (default 4) up to the hour the page was opened, in the browser's timezone, and ignores `from`/`to`: clicking a cell sets `from`/`to` to the latest whole occurrence of that weekday-hour and scrolls to the throughput chart; `heat_metric` picks sent or received bytes instead of both, `heat_split=app` one heatmap per top-4 app, each with its own scale; the bandwidth treemap sums sent + received bytes over the page range, `tm_dir` sent or received only, and `tm=sunburst` draws the same tree as rings; clicking a node drills in, the breadcrumb (or the sunburst's centre) goes back out; the process lifetime Gantt has one lane per process name (overlapping instances get sub-rows), lanes by first start or, with `gantt_sort=bytes`, by total bytes; its lane tooltip gives the median lifetime and flags regular starts (n ≥ 5, start-gap CV < 0.1) as a likely scheduled job; clicking a bar opens the process; `calls=1` opens the "Calls & efficiency" panel under the throughput chart (closed by default): bytes/s, calls/s and bytes per call (log) as three panels on one time axis, sharing the throughput chart's cursor and zoom; the "Bytes per call" heatmap under it has one row per app (`bpc_by=name`: process name), the top 10 by calls plus the rest and an "all" row, columns log2 buckets of bytes per call, colored by the share of the row's calls (each row 100 %), a ◆ at each row's calls-weighted median; its tooltip gives the share of calls next to the share of bytes; `bpc_dir=rx` counts receive calls instead of sends), `/process/:pid/:start?bpc_dir=rx&beacon_scope=name` (the process header, then every instance of the same name over the last 7 days in the same Gantt, this one outlined, zoomed to the instances, then this instance's bytes vs calls over its traffic window, from raw flows, then its bytes-per-call histogram over the same window: share of calls filled, share of bytes outlined, median dashed, then the beaconing strip: one row per destination with a dot per active tick (size: log bytes), the median gap between bursts and its cv on the right, a "periodic" badge above score 0.8; `beacon_scope=name` merges every instance of the name over the last 6 h of the window; clicking a dot or row opens History for that `filter.dest` over the same range; under it the "Periodic connections" table, periodic destinations first, labelled a heuristic).

Conventions:

- Server code must be erasable TypeScript (no `enum`, `namespace` or parameter
  properties) because Node strips types rather than compiling them.
  `tsconfig.server.json` enforces this with `erasableSyntaxOnly`. Relative
  imports keep their `.ts` extension.
- ClickHouse queries run with `readonly=2`, so the dashboard cannot write.
  Pass user input as query parameters (`{name:Type}` + `query_params`), never
  by string concatenation.
- Charts use Apache ECharts through `<EChart>` (`src/client/charts/`). Import
  `echarts` from `charts/echarts.ts`, which registers only the modules in use;
  add a chart type there when a chart needs one. Colors come from
  `charts/palette.ts`: tx is warm and drawn above zero, rx is cool and drawn
  below, and series keep their color slot while rankings change
  (`SlotAssigner`, one per page).
- Rates are kbps on the wire, shown with SI prefixes (`fmtRate`); byte totals
  use IEC units (`fmtBytes`). Traffic charts carry the note "application
  payload (excludes headers and retransmits)" (the `Panel` default footnote).
