// History throughput (05): the two-pass top-N query and the conversion of its
// rows into zero-padded, column-oriented kbps series. Pure, so node --test
// covers it; the route only runs the query.
import {
  COMPARE_OFFSET_MS,
  THROUGHPUT_OTHER,
  type CompareOffset,
  type ThroughputBy,
  type ThroughputCompare,
  type ThroughputDir,
  type ThroughputResponse,
} from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';
import { bucketSeconds, rangeParams, timeFilter, type Range } from './range.ts';
import { BY_COLUMNS, filterSql, flowSource, type Filters } from './sql.ts';

export const DIRS: readonly ThroughputDir[] = ['both', 'tx', 'rx', 'total'];

export function parseDir(raw: unknown): ThroughputDir {
  if (raw === undefined || raw === '') return 'both';
  if (typeof raw === 'string' && (DIRS as readonly string[]).includes(raw)) return raw as ThroughputDir;
  throw badRequest(`dir: expected one of ${DIRS.join(', ')}`);
}

/** What the top N is ranked by, per direction. Constants. */
const RANK_BY: Record<ThroughputDir, string> = {
  both: 'tx_bytes + rx_bytes',
  total: 'tx_bytes + rx_bytes',
  tx: 'tx_bytes',
  rx: 'rx_bytes',
};

/**
 * `r` with `from` rounded down to a bucket start, so the first bucket is
 * whole. (toStartOfInterval with a SECOND interval counts from the epoch, as
 * does this.)
 */
export function alignRange(r: Range): Range {
  const stepMs = r.step * 1000;
  return { ...r, from: Math.floor(r.from / stepMs) * stepMs };
}

/**
 * The top `top` keys of `by` over the whole range, then every bucket's bytes
 * per top key, the rest folded into THROUGHPUT_OTHER. Every piece of SQL text
 * is a constant picked from a whitelist; input arrives only as params.
 */
export function throughputQuery(
  r: Range,
  by: ThroughputBy,
  dir: ThroughputDir,
  top: number,
  filters: Filters,
): { sql: string; params: Record<string, unknown> } {
  const time = timeFilter(r);
  const needUid = by === 'uid' || filters.uid !== undefined;
  const src = flowSource(r.table, time, needUid);
  const f = filterSql(filters);
  const col = BY_COLUMNS[by];
  const rank = RANK_BY[dir];
  const sql = `WITH top_keys AS (
      SELECT ${col} AS k
      FROM ${src}
      WHERE ${time}${f.sql}
      GROUP BY k
      HAVING sum(${rank}) > 0
      ORDER BY sum(${rank}) DESC, k
      LIMIT {top:UInt8}
    )
    SELECT ${bucketSeconds(r)} AS t,
           if(${col} IN (SELECT k FROM top_keys), ${col}, '${THROUGHPUT_OTHER}') AS key,
           sum(tx_bytes) AS tx, sum(rx_bytes) AS rx
    FROM ${src}
    WHERE ${time}${f.sql}
    GROUP BY t, key
    ORDER BY t`;
  return { sql, params: { ...rangeParams(r), ...f.params, top } };
}

export type ThroughputRow = { t: number; key: string; tx: string | number; rx: string | number };

/** bytes over `seconds` → kbps, rounded to 3 decimals (bps) to keep the JSON small. */
export const kbps = (bytes: number, seconds: number) => (seconds > 0 ? Math.round((bytes * 8) / seconds) / 1000 : 0);

/**
 * Rows → the response: keys ranked by the direction's total (ties by key,
 * THROUGHPUT_OTHER last), one zero-filled value per bucket and key, converted
 * to kbps. Stacked areas break on a missing x value, so every key gets every
 * bucket. A bucket cut short by the end of the range is divided by the time it
 * covers (`flows_1m` rows cover whole minutes, so up to the minute after `to`).
 */
export function buildThroughput(rows: readonly ThroughputRow[], r: Range, dir: ThroughputDir, labels: Record<string, string> = {}): ThroughputResponse {
  const stepMs = r.step * 1000;
  const from = r.from;
  const n = Math.max(1, Math.ceil((r.to - from) / stepMs));
  const dataEnd = r.table === 'flows' ? r.to : Math.ceil(r.to / 60_000) * 60_000;

  const totals = new Map<string, number>();
  const tx = new Map<string, number[]>();
  const rx = new Map<string, number[]>();
  for (const row of rows) {
    const i = Math.round((row.t * 1000 - from) / stepMs);
    if (i < 0 || i >= n) continue;
    const bt = Number(row.tx);
    const br = Number(row.rx);
    if (!tx.has(row.key)) {
      tx.set(row.key, new Array<number>(n).fill(0));
      rx.set(row.key, new Array<number>(n).fill(0));
    }
    tx.get(row.key)![i]! += bt;
    rx.get(row.key)![i]! += br;
    const v = dir === 'tx' ? bt : dir === 'rx' ? br : bt + br;
    totals.set(row.key, (totals.get(row.key) ?? 0) + v);
  }

  const keys = [...tx.keys()].sort((a, b) => {
    if (a === THROUGHPUT_OTHER || b === THROUGHPUT_OTHER) return a === THROUGHPUT_OTHER ? 1 : -1;
    return totals.get(b)! - totals.get(a)! || (a < b ? -1 : a > b ? 1 : 0);
  });

  const t = Array.from({ length: n }, (_, i) => from + i * stepMs);
  const seconds = t.map((start) => (Math.min(start + stepMs, Math.max(dataEnd, start)) - start) / 1000);
  const rate = (bytes: number[]) => bytes.map((b, i) => kbps(b, seconds[i]!));
  const out: ThroughputResponse = { step: r.step, from, to: r.to, table: r.table, keys, labels: {}, t, tx: {}, rx: {} };
  for (const k of keys) {
    out.tx[k] = rate(tx.get(k)!);
    out.rx[k] = rate(rx.get(k)!);
    if (labels[k] !== undefined) out.labels[k] = labels[k]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Week-over-week ghost (11): the same window one day or week earlier

export function parseCompare(raw: unknown): CompareOffset | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw === 'string' && Object.hasOwn(COMPARE_OFFSET_MS, raw)) return raw as CompareOffset;
  throw badRequest(`compare: expected one of ${Object.keys(COMPARE_OFFSET_MS).join(', ')}`);
}

/** The earlier window's bucket width: `flows_1m` rows are whole minutes, so at least 60 s. */
export const compareStep = (r: Range) => Math.max(60, Math.ceil(r.step / 60) * 60);

/**
 * Totals (no per-key split) over `[from - offset, to - offset)` from
 * `flows_1m`, whatever table the range reads, bucketed after shifting forward
 * by `offset`, so its buckets line up with the range's. `from` is rounded down
 * to the ghost's step. Filters apply as to the main query.
 */
export function compareQuery(r: Range, offsetMs: number, filters: Filters): { sql: string; params: Record<string, unknown> } {
  const step = compareStep(r);
  const from = Math.floor(r.from / (step * 1000)) * step * 1000;
  const time = 'minute >= toDateTime(intDiv({g_from:Int64}, 1000)) AND minute < toDateTime(intDiv({g_to:Int64}, 1000))';
  const src = flowSource('flows_1m', time, filters.uid !== undefined);
  const f = filterSql(filters);
  const sql = `SELECT toUnixTimestamp(toStartOfInterval(minute + INTERVAL {offset_s:UInt32} SECOND, INTERVAL {g_step:UInt32} SECOND)) AS t,
           sum(tx_bytes) AS tx, sum(rx_bytes) AS rx
    FROM ${src}
    WHERE ${time}${f.sql}
    GROUP BY t
    ORDER BY t`;
  return { sql, params: { ...f.params, g_from: from - offsetMs, g_to: r.to - offsetMs, g_step: step, offset_s: offsetMs / 1000 } };
}

/** The first minute `flows_1m` holds (read in key order, so it stops after the first granule). */
export const FIRST_MINUTE_SQL = 'SELECT toUnixTimestamp(minute) AS first FROM flows_1m ORDER BY minute LIMIT 1';

export type CompareRow = { t: number; tx: string | number; rx: string | number };

/**
 * Rows → the ghost: kbps per shifted bucket, zero-filled, with the buckets
 * before the table's first minute (`firstMs`, shifted) null and a bucket
 * partly before it divided by the time it covers. Null when the whole earlier
 * window predates the data (or there is none).
 */
export function buildCompare(rows: readonly CompareRow[], r: Range, offsetMs: number, firstMs: number | null): ThroughputCompare | null {
  if (firstMs === null || firstMs >= r.to - offsetMs) return null;
  const step = compareStep(r);
  const stepMs = step * 1000;
  const from = Math.floor(r.from / stepMs) * stepMs;
  const n = Math.max(1, Math.ceil((r.to - from) / stepMs));
  const since = Math.max(from, firstMs + offsetMs);
  const dataEnd = Math.ceil(r.to / 60_000) * 60_000;
  const tx = new Array<number>(n).fill(0);
  const rx = new Array<number>(n).fill(0);
  for (const row of rows) {
    const i = Math.round((row.t * 1000 - from) / stepMs);
    if (i < 0 || i >= n) continue;
    tx[i]! += Number(row.tx);
    rx[i]! += Number(row.rx);
  }
  const t = Array.from({ length: n }, (_, i) => from + i * stepMs);
  const seconds = t.map((start) => (Math.min(start + stepMs, Math.max(dataEnd, start)) - Math.max(start, since)) / 1000);
  const rate = (bytes: number[]) => bytes.map((b, i) => (t[i]! + stepMs <= since ? null : kbps(b, Math.max(0, seconds[i]!))));
  return { offset: offsetMs, step, since, t, tx: rate(tx), rx: rate(rx) };
}
