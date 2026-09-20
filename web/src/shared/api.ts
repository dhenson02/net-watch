// Response shapes shared by the API server and the browser client.

export interface BackendStatus {
  ok: boolean;
  /** host:port the server talks to (never includes credentials). */
  target: string;
  /** Round trip of the probe query, when it succeeded. */
  latencyMs: number | null;
  version: string | null;
  error: string | null;
}

export interface HealthResponse {
  serverTimeMs: number;
  uptimeS: number;
  redis: BackendStatus;
  clickhouse: BackendStatus;
  /** The local IP → ASN table (18); `loaded: false` without one. */
  geo: GeoStatus;
  /** Reverse DNS lookups are enabled (`RDNS=1`, 18). */
  rdns: boolean;
}

/** Error body of every non-2xx API response. */
export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------------------
// Live (Redis). Field names follow the collector's snapshot JSON.
//
// `start_ns` is ns since boot (u64). It exceeds 2^53 after ~104 days of uptime,
// so it is always a decimal string; `pid:start_ns` ids must never be parsed
// into a JS number.

export interface LiveProcess {
  pid: number;
  start_ns: string;
  start_ms: number;
  name: string;
  cmdline: string;
  uid: number;
  first_seen_ms: number;
  last_seen_ms: number;
  /** Set for processes that ended in the last 60 s. */
  ended_ms: number | null;
  tx_kbps: number;
  rx_kbps: number;
  tx_total: number;
  rx_total: number;
}

export interface LiveFlow {
  pid: number;
  start_ns: string;
  name: string;
  uid: number;
  proto: string;
  app: string;
  /** Plain IPv4 or IPv6 text. */
  raddr: string;
  rport: number;
  lport: number;
  tx_bytes: number;
  rx_bytes: number;
  tx_calls: number;
  rx_calls: number;
  tx_kbps: number;
  rx_kbps: number;
}

/** One collector tick: `netwatch:snapshot` / a `netwatch:stream` entry. */
export interface LiveSnapshot {
  ts_ms: number;
  interval_ms: number;
  /** Cumulative dropped events since the collector started. */
  drops: number;
  processes: LiveProcess[];
  flows: LiveFlow[];
}

/** A tick reduced to what the live charts need. Rates are kbps. */
export interface CompactTick {
  ts: number;
  intervalMs: number;
  drops: number;
  /** Live (not ended) processes in this tick. */
  nProcs: number;
  nFlows: number;
  txKbps: number;
  rxKbps: number;
  /** Only processes with tx or rx > 0. `id` is `pid:start_ns`. */
  procs: { id: string; name: string; tx: number; rx: number }[];
  /** kbps by application label, summed over flows. */
  apps: Record<string, [tx: number, rx: number]>;
  /** Ticks are missing right before this one: draw a break, not a line. */
  gap?: true;
}

/** One process in `/api/live/snapshot` (the top-talkers table). Rates are kbps. */
export interface LiveProcessRow {
  /** `pid:start_ns` */
  id: string;
  pid: number;
  startNs: string;
  name: string;
  /** Truncated to 300 chars; the full value is in `netwatch:proc:{id}`. */
  cmdline: string;
  uid: number;
  /** Username from the server's /etc/passwd, null when the uid has none. */
  user: string | null;
  startMs: number;
  firstSeenMs: number;
  lastSeenMs: number;
  /** Set for processes that ended in the last 60 s. */
  endedMs: number | null;
  txKbps: number;
  rxKbps: number;
  txTotal: number;
  rxTotal: number;
  /** This tick's flows of this process. */
  nFlows: number;
}

/** The hub's latest snapshot reduced to its process list. */
export interface LiveSnapshotResponse {
  /** The API server's clock when it answered, to correct for browser clock skew. */
  serverTimeMs: number;
  ts: number;
  intervalMs: number;
  processes: LiveProcessRow[];
}

/** `netwatch:meta` plus the process set sizes, for the health strip. */
export interface LiveMeta {
  /** The API server's clock when it answered, to correct for browser clock skew. */
  serverTimeMs: number;
  /** Null until the collector has written its first tick. */
  lastTickMs: number | null;
  intervalMs: number | null;
  /** Cumulative dropped events since the collector started; resets on restart. */
  drops: number | null;
  /** `SCARD netwatch:alive` */
  alive: number;
  /** `ZCARD netwatch:ended` (kept for `--ended-ttl-secs`) */
  ended: number;
}

/** First SSE event on every (re)connect of /api/live/events. */
export interface LiveHello {
  latestTs: number | null;
}

// ---------------------------------------------------------------------------
// History (ClickHouse)

/** The resolved range a history response was computed for. */
export interface RangeInfo {
  from: number;
  to: number;
  /** Bucket width in seconds. */
  step: number;
  table: 'flows' | 'flows_1m';
}

export interface HistorySummary {
  range: RangeInfo;
  txBytes: number;
  rxBytes: number;
  /** Distinct process instances with traffic in the range. */
  processes: number;
}

/** Whether the collector's ClickHouse sink is keeping up. */
export interface HistoryIngest {
  /** The API server's clock when it answered. */
  serverTimeMs: number;
  /** Newest `flows.ts`, or null when there is no row in the last 10 min. */
  lastTsMs: number | null;
  /** `flows` rows with `ts` in the last minute. */
  rows1m: number;
}

/** A process instance from the `processes` table. */
export interface ProcessInfo {
  pid: number;
  start_ns: string;
  start_ms: number;
  name: string;
  cmdline: string;
  uid: number;
  first_seen_ms: number;
  last_seen_ms: number;
  ended_ms: number | null;
  tx_total: number;
  rx_total: number;
}

// ---------------------------------------------------------------------------
// Flows (the process → app → destination Sankey)

/**
 * Traffic of one (process name, proto, app, remote ip, remote port). `tx`/`rx`
 * are mean kbps in live mode and bytes in history mode.
 */
export interface FlowAgg {
  name: string;
  proto: string;
  app: string;
  /** Plain IPv4 or IPv6 text; an unspecified address with port 0 is an unknown peer. */
  ip: string;
  rport: number;
  tx: number;
  rx: number;
  /** `pid:start_ns` of this row's busiest instance of `name`, for click-through. */
  id: string;
  /** ASN, org and country of `ip` (18); absent without a geo table or for local addresses. */
  geo?: Geo;
}

/** `/api/live/flows`: flows averaged over the hub's last ticks. */
export interface LiveFlowsResponse {
  /** Newest tick averaged, null before the first one. */
  ts: number | null;
  /** Ticks averaged over. */
  ticks: number;
  /** `tx`/`rx` are mean kbps over those ticks. */
  flows: FlowAgg[];
}

/** `/api/history/flows`: byte totals over a range, largest first. */
export interface HistoryFlowsResponse {
  range: RangeInfo;
  /** `tx`/`rx` are bytes. */
  flows: FlowAgg[];
  /** More rows matched than `limit`; the smallest were left out. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// History throughput (05): stacked by one dimension

/** What the History throughput chart stacks by. `dest` is `ip:port` (IPv6 in brackets). */
export type ThroughputBy = 'app' | 'name' | 'proto' | 'uid' | 'dest';
/** `both` mirrors rx below tx; `total` stacks tx + rx. The top N is ranked by the same direction. */
export type ThroughputDir = 'both' | 'tx' | 'rx' | 'total';

/** Series key of the remainder: every key outside the top N. */
export const THROUGHPUT_OTHER = '__other';

/** `/api/history/throughput`: kbps per bucket for the top keys plus the rest. */
export interface ThroughputResponse {
  /** Bucket width in seconds. */
  step: number;
  /** First bucket start (the requested `from` rounded down to `step`), ms. */
  from: number;
  /** The requested end, ms (exclusive). */
  to: number;
  table: 'flows' | 'flows_1m';
  /** Largest first by the requested direction; THROUGHPUT_OTHER last when present. */
  keys: string[];
  /** Display names where they differ from the key (`uid` → username). */
  labels: Record<string, string>;
  /** Bucket starts (ms). Every bucket is present, zero-filled. */
  t: number[];
  /** kbps, aligned with `t`. A bucket cut short by `to` is divided by the time it covers. */
  tx: Record<string, number[]>;
  rx: Record<string, number[]>;
  /**
   * Present when `compare` was requested (11): the same window one day or
   * week earlier, totals only, shifted forward onto this range's times. Null
   * when the earlier window predates all the data.
   */
  compare?: ThroughputCompare | null;
  /** Present when `unknown=1` was requested (16): the classifier's unlabelled share. */
  unknown?: ThroughputUnknown;
  /** Present when `calls=1` was requested (14): call rates over every key, filtered alike. */
  calls?: ThroughputCalls;
  /**
   * With `by=dest` and a geo table (18): the ASN, org and country of each key
   * the table knows. Those keys also get a `labels` entry, `org (ip:port)`.
   */
  geo?: Record<string, Geo>;
}

/**
 * Send and receive calls per second (14), totals over every key, aligned with
 * a throughput answer's `t`. A call is one hooked send or receive (e.g. one
 * `tcp_sendmsg`) that moved payload; a bucket cut short by `to` is divided by
 * the time it covers, like the bytes.
 */
export interface ThroughputCalls {
  tx: number[];
  rx: number[];
}

/**
 * `/api/process/:pid/:start/calls` (14): one process instance's bytes and
 * calls per bucket, from raw `flows` (keyed by pid, proc_start).
 */
export interface ProcessCallsResponse {
  /** Bucket width in seconds. */
  step: number;
  /** First bucket start (the requested `from` rounded down to `step`), ms. */
  from: number;
  to: number;
  /** Bucket starts (ms), every bucket present, zero-filled. */
  t: number[];
  /** kbps, aligned with `t`. */
  tx: number[];
  rx: number[];
  /** Calls per second, aligned with `t`. */
  calls: ThroughputCalls;
}

/**
 * Per bucket of a throughput answer (aligned with its `t`), the bytes (tx +
 * rx, whatever `dir` is) the classifier labelled `unknown`, with the page's
 * filters applied.
 */
export interface ThroughputUnknown {
  /** unknown / total, 0..1; null where the bucket had no traffic at all. */
  share: (number | null)[];
  /** Bytes labelled unknown. */
  bytes: number[];
  /** All bytes, for "220 MiB of 1.5 GiB". */
  total: number[];
}

/** `compare=` values: the offset of the ghost window. */
export type CompareOffset = '1d' | '1w';
export const COMPARE_OFFSET_MS: Record<CompareOffset, number> = { '1d': 86_400_000, '1w': 7 * 86_400_000 };

/** The earlier window of a throughput answer, always from `flows_1m`. */
export interface ThroughputCompare {
  /** How far back it was taken, ms. `t` is already shifted forward by it. */
  offset: number;
  /** Bucket width in seconds, a whole number of minutes (may differ from the answer's). */
  step: number;
  /**
   * Shifted time the earlier data starts at: the window's start, or later
   * when the table's data begins inside it. Buckets before it are null.
   */
  since: number;
  /** Shifted bucket starts (ms), every bucket present. */
  t: number[];
  /** kbps totals over every key, aligned with `t`; null before `since`. */
  tx: (number | null)[];
  rx: (number | null)[];
}

// ---------------------------------------------------------------------------
// Peak vs average band (13): an overlay on the History throughput

/** `/api/history/burst` `dir`: `both` answers tx and rx in one scan (the mirrored chart). */
export type BurstDir = 'both' | 'tx' | 'rx' | 'total';
export type BurstSide = 'tx' | 'rx' | 'total';

/** Longest range the band scans raw `flows` for over all processes (one instance is exempt). */
export const BURST_MAX_SPAN_MS = 24 * 3_600_000;

/** Per bucket, kbps, aligned with the answer's `t`; zero where nothing moved. */
export interface BurstStats {
  /** Bytes over the whole bucket (idle seconds count). */
  mean: number[];
  /** Nearest-rank p95 of the per-tick rates, idle ticks counted as 0. */
  p95: number[];
  /** Busiest tick. */
  max: number[];
}

/** `/api/history/burst`: per-tick peaks against the bucket mean, from raw `flows`. */
export interface BurstResponse {
  /** Bucket width in seconds (the throughput answer's for the same range). */
  step: number;
  /** First bucket start (`from` rounded down to `step`), ms. */
  from: number;
  to: number;
  dir: BurstDir;
  /** Bucket starts (ms), every bucket present. */
  t: number[];
  /** The sides `dir` asks for: tx and rx for `both`, else that one. */
  tx?: BurstStats;
  rx?: BurstStats;
  total?: BurstStats;
}

// ---------------------------------------------------------------------------
// Process start/end markers (12): a track under the History throughput

/** A process instance that started talking or ended inside a range. */
export interface LifecycleProc {
  /** `pid:start_ns`, for the process page. */
  id: string;
  pid: number;
  name: string;
  /** The start of the command line (at most 120 chars). */
  cmdline: string;
  /** First network I/O (not the exec time), ms. */
  firstSeenMs: number;
  endedMs: number | null;
  /** tx + rx over the whole lifetime. */
  bytes: number;
}

/**
 * `/api/history/lifecycle`: processes whose first network I/O or end falls in
 * the range, largest first. The other event may lie outside the range; the
 * client draws only the ones inside.
 */
export interface LifecycleResponse {
  from: number;
  to: number;
  procs: LifecycleProc[];
  /** More processes matched than `limit`; the smallest were left out. */
  truncated: boolean;
}

/** `/api/history/scatter`: one point per process instance, or per process name. */
export type ScatterGroup = 'instance' | 'name';
/** `lifetime`: the processes' lifetime totals; `range`: bytes within the range. */
export type ScatterBasis = 'lifetime' | 'range';

export interface ScatterPoint {
  /** `pid:start_ns`; for a name, its busiest instance (click-through). */
  id: string;
  /** The instance's pid; for a name, the busiest instance's. */
  pid: number;
  name: string;
  /** The start of the command line (at most 300 chars); for a name, the busiest instance's. */
  cmdline: string;
  /** 4294967295 when the process is unknown (range basis only). */
  uid: number;
  /** Username of `uid`, null if unknown. */
  user: string | null;
  /** Bytes sent and received (lifetime or within the range, see `basis`). */
  tx: number;
  rx: number;
  /** Process instances in the point (1 for `group=instance`). */
  instances: number;
  /** Process start (exec), ms; for a name, the earliest. Null if the process is unknown. */
  startMs: number | null;
  /** End, ms; null while running (for a name: while any instance runs). */
  endedMs: number | null;
  /** Last network I/O, ms; for a name, the latest. */
  lastSeenMs: number | null;
}

export interface ScatterResponse {
  from: number;
  to: number;
  group: ScatterGroup;
  basis: ScatterBasis;
  /** The flow table the range and the filters are read from (raw flows up to 2 h, else the rollup). */
  table: 'flows' | 'flows_1m';
  /** Largest (tx + rx) first. */
  points: ScatterPoint[];
  /** More points matched than `limit`; the smallest were left out. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Process lifetimes (09, the Gantt on the History and Process pages)

/** One process instance's lifetime. */
export interface LifetimeBar {
  /** `pid:start_ns`, for the process page. */
  id: string;
  pid: number;
  name: string;
  /** The start of the command line (at most 120 chars). */
  cmdline: string;
  uid: number;
  /** Process start (exec), ms. */
  startMs: number;
  /** First network I/O, ms; the bar is thin (hatched) from `startMs` to here. */
  firstSeenMs: number;
  /** Last network I/O, ms. */
  lastSeenMs: number;
  /** End, ms; null while running (or since the collector stopped). */
  endedMs: number | null;
  /** Lifetime totals. */
  tx: number;
  rx: number;
}

/**
 * `/api/history/lifetimes`: process instances whose lifetime overlaps the
 * range (started before `to`, not ended before `from`), latest start first.
 */
export interface LifetimesResponse {
  from: number;
  to: number;
  bars: LifetimeBar[];
  /** More instances matched than `limit`; the earliest starts were left out. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Hour-of-day × weekday heatmap (06)

/** Bytes the cells count: tx + rx, sent or received. */
export type HeatmapMetric = 'total' | 'tx' | 'rx';
/** `app`: one grid per top-4 app instead of one for all traffic. */
export type HeatmapSplit = 'none' | 'app';

/** 7 weekdays × 24 hours; cell `dow * 24 + hour`, dow 0 = Monday, in the response's `tz`. */
export const HEATMAP_CELLS = 168;

export interface HeatmapGrid {
  /** The app (`split=app`), else null. */
  key: string | null;
  /** Bytes of the grid over the range. */
  bytes: number;
  /** Per cell: average kbps over that hour (bytes / samples as a rate), null where the range holds no sample. */
  kbps: (number | null)[];
  /** Per cell: dates with any traffic in it, to tell a steady hour from one busy day. */
  active: number[];
}

export interface HeatmapResponse {
  from: number;
  to: number;
  tz: string;
  metric: HeatmapMetric;
  split: HeatmapSplit;
  /**
   * Start of the part of the range the rollup has data for (its first minute
   * when that is after `from`); the samples count from here. Null when the
   * rollup is empty.
   */
  coveredFrom: number | null;
  /** Per cell: how many times that weekday-hour occurs in the covered range (the averages' divisor). */
  samples: number[];
  /** Largest `bytes` first; empty without traffic. */
  grids: HeatmapGrid[];
}

// ---------------------------------------------------------------------------
// uid → process → app treemap (07)

/** Bytes a treemap sums: tx + rx, sent or received. */
export type TreemapDir = 'total' | 'tx' | 'rx';

export interface TreemapApp {
  /** App label as the collector classified it (`HTTPS`, `DNS/UDP`, `unknown`). */
  name: string;
  value: number;
}

export interface TreemapProc {
  /** Process name, or `other (N processes)` for the folded rest. */
  name: string;
  value: number;
  /** Set on the "other" node: how many processes it sums. */
  folded?: number;
  children: TreemapApp[];
}

export interface TreemapUser {
  /** Username from /etc/passwd, `uid N` when it has none, `unknown uid` when the process is unknown. */
  name: string;
  /** 4294967295 when the rollup row's process is missing from `processes`. */
  uid: number;
  value: number;
  children: TreemapProc[];
}

export interface TreemapResponse {
  from: number;
  to: number;
  /** Raw `flows` up to 2 h, else `flows_1m`. */
  table: 'flows' | 'flows_1m';
  dir: TreemapDir;
  /** Sum of every user's value. */
  total: number;
  /** Processes kept per user before the rest are folded. */
  top: number;
  /** Largest first at every level. */
  users: TreemapUser[];
  /** More (uid, name, app) rows matched than the server reads; the smallest were left out. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Bytes-per-call distribution (10)

/** Which calls a bytes-per-call histogram counts: sends or receives. */
export type BytesPerCallDir = 'tx' | 'rx';
/** Rows of the History heatmap: apps or process names. */
export type BytesPerCallBy = 'app' | 'name';

/**
 * log2 buckets of bytes per call: bucket `b` holds means in `[2^b, 2^(b+1))`
 * bytes, bucket 0 also those under 1 B, and the last (20) everything from
 * 1 MiB up.
 */
export const BPC_BUCKETS = 21;

export interface BytesPerCallRow {
  /** The app or process name; null for the folded rest (`folded` keys). */
  key: string | null;
  /** Calls per bucket (BPC_BUCKETS long), the histogram's weight. */
  calls: number[];
  /** Bytes per bucket, for the share of bytes next to the share of calls. */
  bytes: number[];
  totalCalls: number;
  totalBytes: number;
}

/**
 * `/api/history/bytes-per-call` and `/api/process/:pid/:start/bytes-per-call`
 * (10): calls bucketed by bytes per call. Each source row (one flow over one
 * tick in raw `flows`, over one minute in `flows_1m`) contributes its mean,
 * bytes / calls, weighted by its calls: the histogram is a distribution of
 * per-flow-tick or per-flow-minute means, not of single calls.
 */
export interface BytesPerCallResponse {
  from: number;
  to: number;
  /** Raw `flows` (per-tick means) up to 2 h and for one process, else `flows_1m` (per-minute means). */
  table: 'flows' | 'flows_1m';
  dir: BytesPerCallDir;
  by: BytesPerCallBy;
  /** Every key summed. */
  total: BytesPerCallRow;
  /** The top keys by calls, most first, then the rest folded into one row (key null), if any. */
  rows: BytesPerCallRow[];
  /** How many keys the null row sums; 0 without one. */
  folded: number;
}

// ---------------------------------------------------------------------------
// Beaconing strip + periodicity score (15)

/** One instance (`/api/process/:pid/:start/beacons`) or every instance of a name (`/api/history/beacons`). */
export type BeaconScope = 'instance' | 'name';

/** At most this many destinations, the most active ticks first. */
export const BEACON_DEST_LIMIT = 100;
/** A periodicity score above this marks a destination as periodic. */
export const BEACON_PERIODIC_SCORE = 0.8;
/** The longest range per scope: one instance reads by its primary key, a name scans by time. */
export const BEACON_MAX_SPAN_MS: Record<BeaconScope, number> = { instance: 24 * 3_600_000, name: 6 * 3_600_000 };

/**
 * One destination's active ticks and their periodicity. A burst is a run of
 * consecutive active ticks (gaps up to 1.5 collector intervals); the stats
 * are over the gaps between burst starts.
 */
export interface BeaconDest {
  /** `ip:port`, IPv6 as `[addr]:port`: the History `filter.dest` value. */
  dest: string;
  ip: string;
  rport: number;
  /** ASN, org and country of `ip` (18), when known. */
  geo?: Geo;
  /** TCP/UDP; in name scope the one with the most bytes. */
  proto: string;
  /** The app label; in name scope the one with the most bytes. */
  app: string;
  /** Active ticks (instances merged per tick in name scope). */
  ticks: number;
  /** Payload bytes both ways over the range. */
  bytes: number;
  /** The collector interval of these rows (median), ms. */
  interval_ms: number;
  /** Median gap between burst starts, s; null with fewer than 2 bursts. */
  period_s: number | null;
  /** Coefficient of variation of the gaps between burst starts; null with fewer than 3 bursts. */
  cv: number | null;
  bursts: number;
  /** 1 - cv with at least 6 bursts and cv < 0.15, else 0. */
  score: number;
  /**
   * Dots, oldest first: tick time (ms), bytes (tx + rx) and the gap (ms)
   * since the previous burst's start: 0 for a tick that continues a burst,
   * null for the first burst.
   */
  t: number[];
  b: number[];
  gap: (number | null)[];
  /** When the ticks were too many to send, dots are merged into bins this wide (ms); null otherwise. */
  binned_ms: number | null;
}

/** `/api/process/:pid/:start/beacons` and `/api/history/beacons` (15). */
export interface BeaconsResponse {
  from: number;
  to: number;
  scope: BeaconScope;
  /** Highest score first, then most active ticks. */
  dests: BeaconDest[];
  /** More destinations had traffic than BEACON_DEST_LIMIT; the least active were left out. */
  truncated: boolean;
  /** The range was longer than BEACON_MAX_SPAN_MS allows and was cut to its last part. */
  capped: boolean;
}

// ---------------------------------------------------------------------------
// New-destination markers (17): a program's first contact with an address

/**
 * A destination first contacted by a program (by name, not instance) in the
 * range: no earlier row of (name, ip) anywhere in `flows_1m`, or of
 * (name, ip, port) when keyed by port.
 */
export interface NewDest {
  name: string;
  /** Plain IPv4, or IPv6. */
  ip: string;
  /** ASN, org and country of `ip` (18), when known. */
  geo?: Geo;
  /** The key's port when keyed by port; else the port of the first contact. */
  port: number;
  /** `ip:port`, IPv6 as `[addr]:port`: the History `filter.dest` value. */
  dest: string;
  /** App and proto of the first contact. */
  app: string;
  proto: string;
  /** The first contact's minute (ms): `flows_1m` has minute resolution. */
  firstMs: number;
  /** tx + rx to the destination in [firstMs, firstMs + 1 h), every instance of the name. */
  firstHourBytes: number;
  /** `pid:start_ns` of the instance that made the first contact, for the process page. */
  id: string;
  pid: number;
  /** 127.0.0.0/8 or ::1 (only returned with `loopback=1`). */
  loopback: boolean;
  /** First seen within 24 h of the table's first minute (only returned with `warmup=1`). */
  warmup: boolean;
}

/** `/api/history/new-dests`: first contacts in the range, oldest first. */
export interface NewDestsResponse {
  from: number;
  to: number;
  /** Keyed by (name, ip, port) rather than (name, ip). */
  ports: boolean;
  dests: NewDest[];
  /** More matched than `limit`; the latest were left out. */
  truncated: boolean;
  /** First contacts in the range left out by the loopback and warm-up exclusions. */
  hidden: { loopback: number; warmup: number };
  /** The end of the warm-up (the table's first minute + 24 h), ms; null while the table is empty. */
  warmupUntil: number | null;
}

// ---------------------------------------------------------------------------
// Geo / ASN enrichment (18): a local iptoasn.com table, looked up by the server

/** What the geo table says about a public address. */
export interface Geo {
  asn: number;
  /** The org part of the AS description ("Amazon.com, Inc."), or the AS name ("GOOGLE"). */
  org: string;
  /** ISO 3166 alpha-2 of the range's registration; '' when the table has none. */
  cc: string;
}

/** `/api/health`'s `geo`. */
export interface GeoStatus {
  loaded: boolean;
  /** IPv4 + IPv6 ranges. */
  entries: number;
  /** The file's modification time (ms), to spot a stale table; null when none is loaded. */
  fileDate: number | null;
  /** Why no table is loaded (file missing, unreadable); null when fine. */
  error: string | null;
}

/** The ASN and country views rank and sum by this: tx + rx, or one direction. */
export type GeoDir = 'total' | 'tx' | 'rx';

/** The ASN and country views group the per-IP sums of at most this many IPs (the largest). */
export const GEO_IP_LIMIT = 5000;

/** Bytes and distinct IPs of a group of addresses. */
export interface GeoSum {
  tx: number;
  rx: number;
  /** tx + rx, or one of them, as `dir` says. */
  bytes: number;
  ips: number;
}

/** Shared by `/api/history/asn` and `/api/history/countries`. */
export interface GeoBreakdown {
  from: number;
  to: number;
  table: 'flows' | 'flows_1m';
  dir: GeoDir;
  /** A geo table is loaded; without one `rows` is empty and every public byte is `unmatched`. */
  geo: boolean;
  /**
   * The grouping runs in the server over the GEO_IP_LIMIT largest IPs:
   * `ips` of `totalIps` distinct addresses, carrying `bytes` of `totalBytes`.
   */
  coverage: { ips: number; totalIps: number; bytes: number; totalBytes: number };
  /** Private, loopback, link-local, multicast/broadcast and unspecified addresses: never on the map. */
  local: GeoSum;
  /** Public addresses the table does not know. */
  unmatched: GeoSum;
}

export interface AsnRow extends GeoSum {
  asn: number;
  org: string;
  /** The country with the most of this ASN's bytes here. */
  country: string;
}

/** `/api/history/asn`: bytes per ASN, largest first. */
export interface AsnResponse extends GeoBreakdown {
  rows: AsnRow[];
}

export interface CountryRow extends GeoSum {
  /** ISO 3166 alpha-2 of the address range's registration. */
  country: string;
}

/** `/api/history/countries`: bytes per country, largest first. */
export interface CountriesResponse extends GeoBreakdown {
  rows: CountryRow[];
}

/** The destination table narrows to one of these (`scope`). */
export type DestScope = 'all' | 'public' | 'local' | 'unmatched';

/** One (ip, port) of the destination table. */
export interface DestRow {
  ip: string;
  port: number;
  /** `ip:port`, IPv6 as `[addr]:port`: the History `filter.dest` value. */
  dest: string;
  geo?: Geo;
  /** Not a public address (see GeoBreakdown.local). */
  local: boolean;
  /** App and proto with the most bytes. */
  app: string;
  proto: string;
  tx: number;
  rx: number;
  /** Process instances (pid, start) that used it. */
  procs: number;
  /** Up to 5 of their names. */
  names: string[];
}

/** `/api/history/destinations`: (ip, port) pairs over a range, largest first. */
export interface DestinationsResponse {
  from: number;
  to: number;
  table: 'flows' | 'flows_1m';
  dir: GeoDir;
  geo: boolean;
  /** Reverse DNS is enabled (`/api/rdns`). */
  rdns: boolean;
  rows: DestRow[];
  /** Examined pairs that matched `asn`/`cc`/`scope` (rows is cut to `limit`). */
  matched: number;
  /** More (ip, port) pairs had traffic than the GEO_IP_LIMIT examined; the smallest were left out. */
  truncated: boolean;
}

/** `/api/rdns`: PTR names; null where there is none (or the lookup failed or ran out of time). */
export interface RdnsResponse {
  enabled: boolean;
  names: Record<string, string | null>;
  /** Addresses not looked up this time (over the per-request budget); ask again. */
  pending: string[];
}

/** One line of the Storage page: a partition (ClickHouse) or a day / fixed key group (Redis). */
export interface StorageRow {
  /** What a delete request names: the partition id, or a `YYYY-MM-DD` day. */
  key: string;
  label: string;
  bytes: number;
  /** ClickHouse rows, or Redis process instances. */
  count: number;
  /** ClickHouse: bytes before compression. */
  rawBytes?: number;
  deletable: boolean;
  /** Finer rows (Redis hours of a day), already in the response. Not deletable on their own. */
  children?: StorageRow[];
  /** ClickHouse: finer rows load from `/api/storage/breakdown` (`table`, this `key`). */
  expandable?: boolean;
  /** The size is the parent's bytes shared out by row count, not measured. */
  estimated?: boolean;
}

export interface StorageTable {
  table: string;
  bytes: number;
  count: number;
  /** How the table is partitioned, in words. */
  by: string;
  /** Whether its partitions can be dropped here. */
  deletable: boolean;
  /** Newest first. */
  rows: StorageRow[];
}

export interface ClickHouseStorage {
  bytes: number;
  tables: StorageTable[];
}

export interface RedisStorage {
  /** `used_memory`: what the dataset holds in RAM. */
  usedMemory: number;
  maxMemory: number;
  /** Size of the append-only file on disk; null when AOF is off. */
  aofBytes: number | null;
  keys: number;
  /** Keys that are not per-day: the snapshot, the stream, live processes, and the remainder (overhead). */
  fixed: StorageRow[];
  /** Ended processes grouped by the day they ended, newest first. Sizes are MEMORY USAGE estimates. */
  days: StorageRow[];
  /** ms; the scan is cached for a short while. */
  scannedAt: number;
}

/** `/api/storage`: each store fails on its own, so one being down still shows the other. */
export interface StorageResponse {
  /** Deleting needs STORAGE_ADMIN_PASSWORD on the server. */
  deleteEnabled: boolean;
  /** The browser's timezone (`tz`): Redis days and every hour row use it. */
  timezone: string;
  /** ClickHouse's own: its partitions are days in this zone, whatever the browser's. */
  clickhouseTimezone: string;
  clickhouse: ClickHouseStorage | null;
  clickhouseError: string | null;
  redis: RedisStorage | null;
  redisError: string | null;
}

/** POST `/api/storage/delete`. */
export interface StorageDeleteRequest {
  store: 'clickhouse' | 'redis';
  /** ClickHouse only: `flows` or `flows_1m`. */
  table?: string;
  /** Partition ids (ClickHouse) or `YYYY-MM-DD` days (Redis). */
  keys: string[];
  password: string;
  /** Redis: the timezone the `YYYY-MM-DD` days are in (the browser's). */
  tz?: string;
}

export interface StorageDeleteResponse {
  deleted: number;
  /** Redis: an AOF rewrite was started so the file shrinks. */
  aofRewrite: boolean;
}

/** `/api/storage/breakdown`: a ClickHouse day split by hour, or a `flows_1m` month split by day (each expandable to hours). */
export interface StorageBreakdownResponse {
  rows: StorageRow[];
}
