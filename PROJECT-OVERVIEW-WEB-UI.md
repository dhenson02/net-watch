# net-watch Web Dashboard: Architecture Overview

**Context**: This document describes the net-watch web dashboard's architecture as a reference for building an Android-native UI. It is **not** a direct port guide—the web stack (Node + React) does not target mobile, but the interaction patterns, visualizations, and data queries are worth understanding.

---

## Project Goals

**Role**: Real-time and historical network analytics dashboard for the net-watch collector.

**What it does**:
- **Live view**: Show processes and flows updating in real-time (1 s/tick), alerts on new top talkers
- **Historical analysis**: Query traffic patterns over days/weeks, compare periods, identify anomalies
- **Drill-down**: Trace a flow from "what was using bandwidth?" → specific process → specific destination
- **Deployment**: Runs on the monitored host (reads Redis/ClickHouse locally); access via SSH tunnel or local network

---

## Architecture: Client-Server

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser (SPA)                                                   │
│  React + Vite + ECharts                                         │
│  State: URL (no cookies/localStorage for tabs to share)        │
│  Charts: interactive Sankey (live flows), stacked area (history)│
│                                                                  │
│  Pages: /live, /history, /destinations, /process/:pid/:start    │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP /api/*
                       ↓
┌──────────────────────────────────────────────────────────────────┐
│ Node.js Server (Fastify)                                        │
│                                                                  │
│  /api/live/*                /api/history/*           /api/rdns  │
│    - LiveHub reader          - ClickHouse queries   - reverse   │
│    - SSE fan-out             - Time bucketing        DNS cache  │
│    - Redis snapshot           - Range parsing                   │
│                               - Query optimization               │
│  /api/process/:pid/:start                                       │
│    - One process instance state                                 │
│                                                                  │
│  Static hosting (dist/client)                                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ↓                         ↓
    ┌──────────────┐          ┌──────────────┐
    │ Redis        │          │ ClickHouse   │
    │ Realtime     │          │ History      │
    │ (localhost)  │          │ (localhost)  │
    └──────────────┘          └──────────────┘
```

---

## Data Sources

### Redis (Realtime, 1-60 s old)

**Connection**: One reader task per server instance follows `netwatch:stream` with blocking `XREAD`.

**Data**:
```
netwatch:snapshot       → Latest tick's full state (JSON)
netwatch:stream         → One entry per tick (for XREAD BLOCK consumers)
netwatch:meta           → ts_ms, interval_ms, drops
netwatch:alive          → Set of active process IDs
netwatch:ended          → Sorted set of ended process IDs (by end time)
netwatch:proc:*:*       → Hash per process (name, uid, rates, totals)
netwatch:proc:*:*:dests → Hash of per-destination summaries
```

**Retention**: Stream holds ~3600 ticks; processes stay in `ended` for 7 days.

### ClickHouse (History, 90 days stored)

**Tables**:

1. **`flows`**: One row per (process, destination, interval)
   - Dimensions: `pid`, `proc_start`, `name`, `uid`, `proto`, `app`, `raddr`, `rport`, `lport`
   - Metrics: `tx_bytes`, `rx_bytes`, `tx_calls`, `rx_calls`
   - Time: `ts` (DateTime64, 1 ms precision), `interval_ms`
   - Partitioned by date; TTL 90 days
   - Indexed: time (minmax) and remote address (bloom filter)
   - Order key: `(pid, proc_start, ts)` — optimized for single-process queries

2. **`flows_1m`**: Rollup of `flows` aggregated to 1-minute buckets
   - Filled by a materialized view
   - SummingMergeTree: sums `tx_bytes`, `rx_bytes`, `tx_calls`, `rx_calls` across inserts for the same key
   - Kept for 2 years
   - Used for queries spanning >2 hours (saves scanning millions of 1-second rows)

3. **`processes`**: Latest state of every process instance
   - Key: `(pid, proc_start)`
   - Columns: name, cmdline, uid, first_seen, last_seen, ended, tx_total, rx_total
   - ReplacingMergeTree with `version`: later inserts overwrite earlier ones; query with `FINAL` or `argMax()`
   - No TTL; keeps all process histories

**Query execution model**:
- Max execution time: 20 s (configurable)
- `readonly=2`: dashboard cannot write
- Queries parametrized (never string concat), parameters via `query_params`

---

## Server Architecture

### Modules (src/server/)

**`db/`**: Database clients
- `redis.ts`: Redis client, reconnect logic, health probe
- `clickhouse.ts`: ClickHouse HTTP client, query builder, result parsing
- `utils.ts`: IP/address parsing, scope classification (local, public, etc.)

**`live/`**:
- `hub.ts`: LiveHub—one background reader task following `netwatch:stream`
  - Keeps last `LIVE_BACKFILL` (default 900) ticks in compact form
  - Maintains latest full snapshot
  - Fans ticks out to browsers via SSE (Server-Sent Events)
  - Detects gaps (collector stopped, stream trimmed)
- `compact.ts`: Compact tick encoding (compress full snapshot to per-tick delta)

**`ch/`**: ClickHouse query builders and result processors
- `chQuery.ts`: Core query executor with cancellation, parametrization, client-gone detection
- `parseRange.ts`: Time range parsing (now, 1h ago, 2023-01-01, etc.), table selection (raw `flows` if ≤2h, else `flows_1m`)
- `sql.ts`: SQL fragments (DISPLAY_IP for IPv4/IPv6, BY_COLUMNS, filters, flowSource joins)
- `throughput.ts`: Query for rates over time + padding/rate conversion
- `lifecycle.ts`: Query for process start/end events in a range
- `lifetimes.ts`: Query for process instances overlapping a range
- `calls.ts`: Query for one process's bytes vs calls over time
- `burst.ts`: Query for per-tick rates, then p95/max computation
- `bytesPerCall.ts`: Histogram of bytes per call (log2 buckets)
- `scatter.ts`: Bytes sent vs received per process
- `heatmap.ts`: Average kbps per (weekday, hour) in a range
- `treemap.ts`: Bytes per user → name → app (nested)
- `beacons.ts`: Per-destination tick arrays, dot binning, periodicity analysis
- `newDests.ts`: New destination first-contact queries
- `geo.ts`, `asn.ts`: IP → ASN table integration

**`geo/`**: IP → ASN geolocation (optional, for enriching flows with network owner)
- `asn.ts`: IP2ASN table loader and binary-search lookups
- `ip.ts`: IP text ↔ u32/bigint conversion, address scope classification
- `rdns.ts`: Reverse DNS (PTR) lookups with LRU cache

**`routes/`**: API endpoints grouped by area
- `health.ts`: `/api/health` — Redis/ClickHouse status, geo table state
- `live.ts`: `/api/live/*` — series, events (SSE), snapshot, flows, meta
- `history.ts`: `/api/history/*` — all history queries (summary, throughput, lifecycle, etc.)
- `process.ts`: `/api/process/:pid/:start` — one instance
- `rdns.ts`: `/api/rdns?ips=a,b` — reverse DNS (if enabled)

**`users.ts`**: UID → username from `/etc/passwd` (read at startup, refreshed hourly)

### API Routes (by area)

#### Live (realtime, from Redis)

| Route | Purpose |
|-------|---------|
| `GET /api/live/series?seconds=900` | Last N seconds of compacted ticks, oldest first |
| `GET /api/live/events` | SSE: one tick per collector interval, keepalive every 15 s |
| `GET /api/live/snapshot` | Latest full snapshot (process list, no flows) |
| `GET /api/live/flows?seconds=10` | Flows of last N seconds grouped by (name, proto, app, ip, port) |
| `GET /api/live/meta` | Tick timestamp, interval, drops, process count |

#### History (from ClickHouse)

**Summary & trends**:
- `GET /api/history/summary?from&to` — Total bytes, process count over a range

**Flow analysis**:
- `GET /api/history/flows?from&to&limit=300` — Bytes per (name, proto, app, ip, port), largest first

**Rates over time**:
- `GET /api/history/throughput?from&to&step&by=app|name|proto|uid|dest` — kbps per bucket, stacked by category

**Process lifecycle**:
- `GET /api/history/lifecycle?from&to` — Processes that started or ended in range
- `GET /api/history/lifetimes?from&to` — Processes whose traffic overlaps range (Gantt view)

**Per-process stats**:
- `GET /api/history/scatter?from&to` — tx vs rx per process (scatter plot)
- `GET /api/history/burst?from&to&step` — Mean and p95/max per bucket (peak vs average band)

**Distribution analysis**:
- `GET /api/history/heatmap?from&to&metric=total|tx|rx` — Average kbps per (weekday, hour)
- `GET /api/history/treemap?from&to&dir` — Bytes per user → process → app
- `GET /api/history/bytes-per-call?from&to&dir&by` — Calls by log2-bucket of bytes/call

**Anomalies**:
- `GET /api/history/new-dests?from&to` — Destinations a process contacted for the first time
- `GET /api/history/beacons?name&from&to` — Periodic destination contacts (for each process instance)

**Geolocation**:
- `GET /api/history/asn?from&to` — Bytes per ASN (network owner)
- `GET /api/history/countries?from&to` — Bytes per country
- `GET /api/history/destinations?from&to` — Full destination table (ip:port with org, country, process instances)

#### Process Detail

| Route | Purpose |
|-------|---------|
| `GET /api/process/:pid/:start` | One process instance state |
| `GET /api/process/:pid/:start/calls?from&to&step` | Bytes and calls per bucket |
| `GET /api/process/:pid/:start/bytes-per-call?from&to&dir` | Bytes-per-call histogram |
| `GET /api/process/:pid/:start/beacons?from&to` | Periodic destinations (dots: ticks, rows: destinations) |

#### Utilities

| Route | Purpose |
|-------|---------|
| `GET /api/health` | Status of Redis, ClickHouse, geo table, reverse DNS |
| `GET /api/rdns?ips=a,b` | Reverse DNS lookups (if enabled; requires `RDNS=1`) |

---

## Client Architecture

### Framework & Setup

- **Bundler**: Vite (dev server with HMR, production build)
- **UI Library**: React 18 (functional components + hooks)
- **Charts**: Apache ECharts (registered modules only, optimized bundle)
- **Routing**: Custom `useRouter` (state in URL query params, shareable links)
- **TypeScript**: No `enum`, `namespace`; erasable syntax (Node type-stripping compatible)
- **Testing**: Vitest for unit tests of pure logic, no integration tests (server tests cover that)

### Pages & Sections

#### `/live` — Real-Time Dashboard

**Components**:
- **HealthStrip**: Redis/ClickHouse status, drop rate
- **LiveThroughput**: Stacked area chart of tx/rx by app or process name
- **TopTalkers**: Ranked table of processes by bytes
- **FlowSankey**: Interactive diagram showing processes → destinations (grouped by ASN if available)

**Interaction**:
- Refresh: auto-refresh SSE (no polling)
- Time window: 5m, 15m, or all buffered ticks
- Group by: process name or instance ID
- Sort: by tx, rx, or total
- Filters: by name, app, protocol, uid, destination

**Data**: SSE from `/api/live/events`, plus `/api/live/snapshot` and `/api/live/flows`.

#### `/history` — Historical Analysis

**Panels** (each a "section" with its own visibility toggle and drill-down):

1. **Throughput (default)**: stacked area of rates over time
   - Buttons: `by` (app, name, proto, uid, dest), `dir` (tx, rx, both), `top` (5..20)
   - Week-over-week ghost line (optional `compare=1d|1w`)
   - Peak vs average band (optional `band=1`)
   - Unknown-protocol share track (optional `unknown=1`)

2. **Lifecycle**: process start (▲) and end (●) markers under the throughput chart
   - Shows which processes drove the traffic spike

3. **Process Gantt**: one bar per instance, lanes per process name
   - Sort by: first start or total bytes
   - Tooltip: lifetime, whether it's a scheduled job (regular starts, CV < 0.1)

4. **Calls & Efficiency** (toggle): bytes/s, calls/s, bytes-per-call over time
   - Small multiples on shared x-axis
   - Shared zoom with throughput

5. **Bytes per Call**: heatmap of calls by log2-bucket of bytes per call
   - Rows: top apps (or process names)
   - Columns: [<1B, [1B-2B), [2B-4B), …, [1MB+]
   - Color: share of calls in that bucket (row normalized)
   - Marker: median bytes-per-call

6. **Activity Heatmap**: average kbps per (weekday, hour)
   - 168 cells (7 days × 24 hours)
   - Cells: log scale, null where no data
   - Legend: one grid per top-4 app (optional `heat_split=app`)
   - Click cell: zoom throughput to that hour across its occurrences

7. **Bandwidth Treemap/Sunburst**: bytes per user → name → app
   - Nested, largest first
   - Users named from /etc/passwd; containers shown as "uid N"
   - Click to drill in, breadcrumb to go back
   - Optional sunburst view (rings)

8. **TX vs RX Scatter**: sent vs received per process (log-log axes)
   - Size: total bytes
   - Color: app
   - Hover: process name, total bytes

9. **New Destinations**: ◆ marks where a process first contacted an address
   - Track under throughput chart
   - Toggle: include loopback, include first 24h, key by port
   - Panel: new destinations per day, stacked by program
   - Hover/click: filter history to that destination

10. **Beacons** (optional): dots under the throughput chart marking periodic connections
    - Rows: by (ip, port, app) of this process
    - Dots: ticks where a packet was sent/received (size: log bytes)
    - Period: median gap between burst starts

**Parameters** (all in URL):
```
/history
  ?from=<ms>&to=<ms>           # Default: last 24 h
  &by=app|name|proto|uid|dest  # Throughput grouping
  &dir=both|tx|rx|total        # Direction
  &top=5..20                   # Top N stacks
  &compare=1d|1w               # Ghost line
  &band=1                      # Peak vs average band
  &unknown=1                   # Unknown-protocol share
  &calls=1                     # Show calls panel
  &scatter_by=name|instance    # Scatter grouping
  &scatter_basis=range|lifetime
  &events=starts|all           # Lifecycle markers
  &heat_metric=tx|rx|total     # Heatmap metric
  &heat_split=app              # One heatmap per app
  &heat_weeks=4                # Heatmap window
  &tm=treemap|sunburst         # Tree view
  &tm_dir=tx|rx|total          # Tree metric
  &gantt_sort=bytes|start      # Gantt order
  &bpc_dir=tx|rx               # Bytes-per-call direction
  &bpc_by=app|name             # Bytes-per-call grouping
  &newdests=1                  # Show new destinations
  &nd_ports=1                  # Key by port
  &nd_lo=1                     # Include loopback
  &nd_warmup=1                 # Include first 24 h
  &filter.name=…               # Filter: exact match
  &filter.app=…
  &filter.proto=…
  &filter.uid=…
  &filter.dest=<ip:port>
```

#### `/destinations` — Geolocation & Networks

**Panels**:
1. **Summary**: total tx, rx, process count, time range (default 24 h)
2. **Top ASNs** (if geo table loaded): bar chart, top 20 by bytes
3. **World Map**: countries colored by traffic (log scale)
4. **Destination Table**: each (ip:port) with:
   - Bytes each direction
   - App and proto with most bytes
   - Process instances that used it
   - ASN and country
5. **Filtering**: by ASN, country, scope (public/local/matched/unmatched)

#### `/process/:pid/:start` — Process Detail

**Sections**:
1. **Header**: process name, cmdline (300 char), uid, lifetime bytes
2. **Instances Gantt**: all instances of the same process name in the last 7 days
   - This instance outlined
   - Bars colored by bytes, sized by lifetime
3. **Bytes vs Calls**: stacked area of bytes and line of calls per second
   - Raw flows from process start to end
4. **Bytes-per-Call Histogram**: 21 log2-buckets of bytes per call
   - Rows: filled (share of calls), outline (share of bytes), median dashed
5. **Beacons**: per destination, list of active ticks, periodicity score
   - "Periodic" badge if score ≥ 0.8
   - Table: destination, first contact, period, CV, burst count
6. **New Destinations** (optional): addresses contacted for first time in last 7 days
   - Newest first, first-hour bytes

**Interaction**:
- Beacon scope: name (merge all instances last 6 h) or instance (this one)
- Click row: filters history to that destination around first contact

---

## Visualization Approach

### Color Palette & Schemes

**Core philosophy**: Protocol/app colors are consistent across pages.
- TX (upload) = warm colors (red, orange, yellow)
- RX (download) = cool colors (blue, cyan, purple)
- App colors: fixed slots (HTTPS always color 1, SSH always color 2, etc.)

**Implementation**:
- `palette.ts`: defines app-to-color mappings (replaceable)
- `SlotAssigner` per page: assigns slots to top N series, wraps rest in "other"
- Dark mode: CSS custom properties, inverted in `prefers-color-scheme: dark`

### Charts (all ECharts)

1. **Stacked Area**: throughput over time, TX above zero, RX below
2. **Sankey Diagram**: process → destination flow (width ∝ bytes)
3. **Heatmap**: cells colored by value, log scale, interactive
4. **Treemap/Sunburst**: nested rectangles/rings by hierarchy
5. **Scatter**: (tx, rx) per point, log-log axes
6. **Bar**: top talkers, ASNs, categories
7. **World Map**: countries filled by traffic intensity

### Interaction Patterns

**Shared time axis across small multiples**: e.g., activity heatmap is 4 grids; hovering aligns all 4.

**Drill-down**: Click a series in throughput → set filter → refreshed all panels.

**Zoom memory**: History chart zoom state is NOT in URL (too verbose); shared by reference in React context.

**Link sharing**: All page state in URL; bookmarked link reproduces the exact view.

---

## Server Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `8787` | Server bind address |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `netwatch` / `netwatch` | Auth |
| `CLICKHOUSE_DATABASE` | `netwatch` | Default database |
| `LOG_LEVEL` | `info` | Logging (debug, info, warn, error) |
| `LIVE_BACKFILL` | `900` | Ticks kept in memory at startup (1 s each) |
| `GEOIP_FILE` | `data/ip2asn-combined.tsv.gz` | IP → ASN table (optional) |
| `RDNS` | `0` | Enable reverse DNS (if `1`) |

### Health Checks

`GET /api/health` returns:
```json
{
  "redis": {
    "ok": true,
    "ping_ms": 1.2,
    "latency_ms": 2.1
  },
  "clickhouse": {
    "ok": true,
    "ping_ms": 5.3,
    "version": "24.1"
  },
  "geo": {
    "loaded": true,
    "entries": 485000,
    "fileDate": "2024-01-15",
    "error": null
  },
  "rdns": {
    "enabled": false
  }
}
```

---

## Data & Query Optimization

### Compact Tick Format

Live ticks are too large to send per-client; instead:
1. Latest full snapshot is kept in memory
2. New ticks are sent as **deltas** (compact encoding)
   - Add: new processes/flows
   - Update: rate/total changes
   - Remove: disappeared processes/flows
3. Client reconstructs full snapshot on-demand
4. Disk (browser storage) not used for ticks; kept in server memory

### Table Selection

- **≤ 2 hours**: Query `flows` (1-second granularity)
- **> 2 hours**: Query `flows_1m` (1-minute granularity, faster, lower precision)

This is automatic in `parseRange()`.

### Query Cancellation

When a browser tab closes or navigates away, the fetch is aborted. The server detects this via `reply.raw.on('close')` and cancels the ClickHouse query (within 20 s timeout window).

### Geolocation Caching

IP → ASN lookups:
1. File (iptoasn TSV, ~500k ranges) loaded at startup
2. Every 10 min, checks mtime; reloads if changed
3. Queries use binary search (no DB calls)
4. Missing is fine; dashboard works without it (just no ASN labels)

### Reverse DNS Caching

When `RDNS=1`, PTR lookups:
- LRU cache: 10k entries, 1-hour TTL per entry
- Per-request budget: max 20 new lookups, 500 ms timeout
- Results returned immediately if cached; pending ones flagged for client poll

---

## Testing Strategy

### Server Tests (`npm test`)

- Unit tests of pure functions: `parseRange`, `throughputSeries`, `clusterMarkers`, `scatterPoints`, `bytesPerCall`, `heatmapCells`, `treemapData`, `periodicity`, `beaconStrip`, `newDests`, `geoView`
- No database mocks; tests use actual (small) fixtures

### Integration Tests (`npm run test:int`)

- Real Redis and ClickHouse (requires `docker compose up -d --wait`)
- Every `/api/*` endpoint
- Fixtures: sample data inserted, queries exercised, results validated
- Small test dataset: ~100 processes, ~500 flows, 7 days of history

---

## Performance Characteristics

### Response Times (on typical hardware with sample data)

| Endpoint | Time | Notes |
|----------|------|-------|
| `/api/live/snapshot` | <5 ms | In-memory |
| `/api/live/series` | <10 ms | Deserialize 900 compacted ticks |
| `/api/history/throughput?from=24h ago` | 100–500 ms | Scan ~86k rows of `flows` |
| `/api/history/throughput?from=7d ago` | 50–100 ms | Scan `flows_1m` (~10k rows), faster |
| `/api/history/destinations` | 200–400 ms | IP enrichment (geo lookups) |
| `/api/history/heatmap` | 100–200 ms | 168 cells, count operations |

### Latency Budget

- User expects <1 s response (rule of thumb)
- 20 s server timeout for long queries (bulk history scans)
- 15 s browser timeout (typical)
- Cancel on tab close (don't waste server work)

---

## Key Design Patterns

### URL-Based State

All UI state lives in the URL (query params):
```
?from=<ms>&to=<ms>&by=name&dir=tx&filter.app=unknown
```

Benefits:
- **Shareable**: send a link, recipient sees the exact view
- **Bookmarkable**: back button works intuitively
- **Stateless**: server doesn't track user state

### SSE Fan-Out

One server reader (LiveHub) follows `netwatch:stream`; all browser clients connect to `/api/live/events` and receive ticks broadcasted.
- One Redis connection (per server), many HTTP connections (clients)
- Clients never directly read Redis (easier to scale, debug, audit)

### One Real Source of Truth

Data consistency:
- **Realtime**: SSE fan-out guarantees all clients see the same tick order
- **History**: ClickHouse is the single source for retrospective analysis
- **Live buffering**: In-memory ring buffer is ephemeral; lost on server restart

### Pagination vs Streaming

- Small results: return all with one request
- Large results: paginated with `limit` and `truncated` flag
  - Max: 2000 rows per request (ClickHouse scan overhead)
  - Truncated result tells client "there's more; refine filters or use a smaller range"

---

## Android Portability

### What Can Translate

- **Query structure**: throughput bucketing, process grouping, filters → can port to local query engine (SQLite)
- **Visualizations**: all are ECharts → could use web view or native Android charts
- **Data models**: `FlowRec`, `ProcView`, aggregation logic → pure Kotlin/Java
- **Interaction patterns**: drill-down, time range, filtering → common mobile UX

### What Needs Adaptation

- **SSE**: Realtime updates via polling instead (background service, every 5–10 s)
- **Charts**: ECharts in WebView is heavyweight; better with native Jetpack Compose or React Native
- **Storage**: SQLite (local) instead of Redis (remote) + ClickHouse
- **Server**: Could be a service running on-device (local data, no network) or sync to cloud
- **Geolocation**: IP → ASN lookups work but require bundling the table

### Reasonable Mobile Equivalent

```
Android Service
  ↓
  Reads /proc/net/tcp*, PackageManager API
  ↓
  Stores in SQLite (local)
  ↓
  Android Activity (UI)
    ↓
    Queries SQLite, renders with Jetpack Compose or Flutter charts
    ↓
    Pages: Home (live top talkers), History (time range + drill-down), Per-app detail
```

**Simpler but lower-fidelity** than the Linux eBPF version—no protocol sniffing, no call counts, no payload bytes (only OS-reported totals), coarser time resolution.

