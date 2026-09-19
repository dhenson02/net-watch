// Beaconing strip (15): every active tick per destination, of one process
// instance or of every instance of a name, with each destination's
// periodicity. Pure, so node --test covers it.
import { type BeaconDest, type BeaconScope, type BeaconsResponse } from '../../shared/api.ts';
import { burstGaps, periodicity } from '../analysis/periodicity.ts';
import { DISPLAY_IP } from './sql.ts';

/** Dots sent over all destinations; past it, a destination's ticks are merged into bins. */
export const BEACON_POINT_BUDGET = 60_000;
/** A destination always keeps at least this many dots. */
export const BEACON_MIN_POINTS = 1_000;
/** When a row has no interval (it always has one), assume the collector's default. */
const DEFAULT_INTERVAL_MS = 1000;

const TIME = 'ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})';

/**
 * Cuts `[from, to)` to its last `maxMs`. The strip's value is in recent,
 * dense data, and the cap keeps a query to one or a few days' partitions.
 */
export function capSpan(r: { from: number; to: number }, maxMs: number): { from: number; to: number; capped: boolean } {
  return r.to - r.from > maxMs ? { from: r.to - maxMs, to: r.to, capped: true } : { ...r, capped: false };
}

/**
 * An instance's whole networked lifetime (first to last network I/O, or its
 * end), never past `now`; `to` is exclusive, so it is padded by a second.
 */
export function lifetimeRange(p: { first_seen_ms: number; last_seen_ms: number; ended_ms: number | null }, now: number): { from: number; to: number } {
  const end = Math.max(p.first_seen_ms, p.ended_ms ?? p.last_seen_ms);
  const to = Math.min(now, end + 1000);
  return { from: Math.min(p.first_seen_ms, to - 1000), to };
}

/**
 * Active ticks per destination, the most active first: one row per tick
 * (several local ports, or several instances in name scope, summed), then
 * one array pair per destination. Times and bytes are Float64 so the arrays
 * arrive as JSON numbers (exact up to 2^53).
 *
 * Instance scope reads by the primary key (pid, proc_start, ts) and keeps
 * proto and app apart, as `flows` rows do; name scope scans the range and
 * groups by (raddr, rport), labelled with the proto and app with the most bytes.
 */
export function beaconsQuery(
  q: { scope: 'instance'; pid: number; start: string; from: number; to: number; limit: number } | { scope: 'name'; name: string; from: number; to: number; limit: number },
): { sql: string; params: Record<string, unknown> } {
  const outer = `${DISPLAY_IP} AS ip, rport,
           groupArray(t) AS ts_ms, groupArray(b) AS bytes, median(iv) AS interval_ms`;
  const tick = `toFloat64(toUnixTimestamp64Milli(ts)) AS t, toFloat64(sum(tx_bytes + rx_bytes)) AS b, max(interval_ms) AS iv`;
  const sql =
    q.scope === 'instance'
      ? `SELECT ${outer}, proto, app
    FROM (
      SELECT raddr, rport, proto, app, ${tick}
      FROM flows
      WHERE pid = {pid:UInt32} AND proc_start = {start:UInt64} AND ${TIME}
      GROUP BY raddr, rport, proto, app, ts
    )
    GROUP BY raddr, rport, proto, app
    ORDER BY length(ts_ms) DESC, ip, rport, proto, app
    LIMIT {limit:UInt32}`
      : `SELECT ${outer}, topKWeighted(1)(tproto, toUInt64(b) + 1)[1] AS proto, topKWeighted(1)(tapp, toUInt64(b) + 1)[1] AS app
    FROM (
      SELECT raddr, rport, argMax(proto, tx_bytes + rx_bytes) AS tproto, argMax(app, tx_bytes + rx_bytes) AS tapp, ${tick}
      FROM flows
      WHERE name = {name:String} AND ${TIME}
      GROUP BY raddr, rport, ts
    )
    GROUP BY raddr, rport
    ORDER BY length(ts_ms) DESC, ip, rport
    LIMIT {limit:UInt32}`;
  const { scope: _scope, ...params } = q;
  return { sql, params };
}

export type BeaconRow = {
  ip: string;
  rport: number;
  proto: string;
  app: string;
  ts_ms: (number | string)[];
  bytes: (number | string)[];
  interval_ms: number | string;
};

/** `ip:port`, IPv6 in brackets: the text `parseDest` reads back (History `filter.dest`). */
export const destText = (ip: string, port: number) => (ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`);

/**
 * Merges dots into bins `binMs` wide from `from`: a bin's first tick time and
 * gap, and its summed bytes.
 */
export function binDots(d: { t: number[]; b: number[]; gap: (number | null)[] }, from: number, binMs: number): { t: number[]; b: number[]; gap: (number | null)[] } {
  const out = { t: [] as number[], b: [] as number[], gap: [] as (number | null)[] };
  let bin = NaN;
  for (let i = 0; i < d.t.length; i++) {
    const k = Math.floor((d.t[i]! - from) / binMs);
    if (k === bin) {
      out.b[out.b.length - 1]! += d.b[i]!;
      continue;
    }
    bin = k;
    out.t.push(d.t[i]!);
    out.b.push(d.b[i]!);
    out.gap.push(d.gap[i]!);
  }
  return out;
}

/** One destination from its row: ticks sorted (duplicate times summed), stats, dots within `maxDots`. */
export function toBeaconDest(row: BeaconRow, r: { from: number; to: number }, maxDots: number): BeaconDest {
  const pairs = row.ts_ms.map((t, i) => [Number(t), Number(row.bytes[i] ?? 0)] as const).sort((a, b) => a[0] - b[0]);
  const t: number[] = [];
  const b: number[] = [];
  for (const [ti, bi] of pairs) {
    if (t.length && t[t.length - 1] === ti) b[b.length - 1]! += bi;
    else {
      t.push(ti);
      b.push(bi);
    }
  }
  const interval = Number(row.interval_ms) || DEFAULT_INTERVAL_MS;
  const stats = periodicity(t, interval);
  let dots = { t, b, gap: burstGaps(t, interval) };
  let binned_ms: number | null = null;
  if (t.length > maxDots) {
    // Whole seconds, wide enough for maxDots bins over the range.
    binned_ms = Math.ceil((r.to - r.from) / maxDots / 1000) * 1000;
    dots = binDots(dots, r.from, binned_ms);
  }
  return {
    dest: destText(row.ip, row.rport),
    ip: row.ip,
    rport: row.rport,
    proto: row.proto,
    app: row.app,
    ticks: t.length,
    bytes: b.reduce((a, x) => a + x, 0),
    interval_ms: interval,
    ...stats,
    ...dots,
    binned_ms,
  };
}

/** Highest score first, then most active ticks, then by destination (stable across refreshes). */
export function compareDests(a: BeaconDest, b: BeaconDest): number {
  return b.score - a.score || b.ticks - a.ticks || a.dest.localeCompare(b.dest) || a.app.localeCompare(b.app) || a.proto.localeCompare(b.proto);
}

/** Rows (at most `limit` + 1, to detect truncation) → the response. */
export function buildBeacons(
  rows: readonly BeaconRow[],
  r: { from: number; to: number; scope: BeaconScope; capped: boolean },
  limit: number,
): BeaconsResponse {
  const kept = rows.slice(0, limit);
  const maxDots = Math.max(BEACON_MIN_POINTS, Math.floor(BEACON_POINT_BUDGET / Math.max(1, kept.length)));
  const dests = kept.map((row) => toBeaconDest(row, r, maxDots)).sort(compareDests);
  return { from: r.from, to: r.to, scope: r.scope, dests, truncated: rows.length > limit, capped: r.capped };
}
