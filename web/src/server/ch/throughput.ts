// History throughput (05): the two-pass top-N query and the conversion of its
// rows into zero-padded, column-oriented kbps series. Pure, so node --test
// covers it; the route only runs the query.
import { THROUGHPUT_OTHER, type ThroughputBy, type ThroughputDir, type ThroughputResponse } from '../../shared/api.ts';
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
