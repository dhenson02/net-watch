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
| `GET /api/history/throughput?from&to&step&by=app&dir=both&top=8&<filters>` | kbps per bucket stacked by `by` (`app`, `name`, `proto`, `uid`, `dest`): the top `top` (5..20) keys over the whole range, ranked by `dir` (`both`/`total`: tx + rx, `tx`, `rx`), plus `__other` (`ThroughputResponse`, column-oriented, every key zero-padded to every bucket). `from` is rounded down to a bucket start; a bucket cut short by `to` is divided by the time it covers. `labels` names uids (`jay (1000)`) |
| `GET /api/history/ingest` | newest `flows.ts` and the row count of the last minute, to show whether the collector's ClickHouse sink keeps up |
| `GET /api/process/:pid/:start` | one process instance from `processes`; 404 if unknown |

`<filters>` are optional exact matches, all ANDed: `name`, `app`, `proto`,
`uid`, and `dest=ip:port` (IPv6 as `[addr]:port`). `flows_1m` has no uid
column, so grouping or filtering it by uid joins `processes`; rows whose
process is unknown there get uid 4294967295 ("unknown uid").

Errors are `{ "error": "…" }` with a 4xx/5xx status; ClickHouse failures are
502. History endpoints take `from`/`to` in ms (default: the last hour) and an
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
               query and its padding/rate conversion (throughput.ts), timezone check
  routes/      one module per API area (health, live, history, process)
  users.ts     uid → username from /etc/passwd (read at startup, refreshed hourly)
src/client/    React SPA (Vite root)
  router.ts    usePath / navigate / useSearchParam / Link; all page state is in the URL
  pages/       Live, History, Process
  charts/      ECharts registration, <EChart>, palette (incl. fixed app hues), formatters, themes,
               FlowSankey (Live + History panels) and its pure graph builder buildSankey,
               mirroredStack (the stacked tx/rx area chart option shared by Live and History throughput)
  history/     History page sections: ThroughputChart (05), useThroughput (URL state + query) and its pure
               series/drill-down logic throughputSeries.ts
  live/        Live page sections (HealthStrip, LiveThroughput + its pure series builder useLiveThroughput,
               TopTalkers + its pure row logic topTalkers.ts, useSnapshot)
  components/  Panel, StatTile, Sparkline (inline SVG), RangePicker, SegmentedControl, Toggle, StatusPill
  hooks/       useQuery (fetch + abort + stale-while-revalidate), usePoll, useLive, useNow, useTimeRange
src/shared/    API response types, imported by both sides
```

Routes: `/` → `/live` (`?live_win=5m|15m|max&live_by=name|id&sort=[-]key&q=filter&idle=show&flow_dir=tx|rx`), `/history?from&to&by=app|name|proto|uid|dest&dir=both|tx|rx|total&top=5..20&filter.name|app|proto|uid|dest=…&flow_dir=tx|rx` (default range: the last 24 h; the `filter.*` params apply to the totals, the throughput chart and the flow diagram), `/process/:pid/:start`.

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
