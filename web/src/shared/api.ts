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
