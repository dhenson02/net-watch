// Peak vs average band (13): per bucket, the mean rate and the p95 and max of
// the per-tick rates, from raw `flows` (only raw rows have per-tick
// resolution). Pure, so node --test covers it; the route only runs the query.
import { BURST_MAX_SPAN_MS, type BurstDir, type BurstResponse, type BurstSide, type BurstStats } from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';
import type { Range } from './range.ts';
import { coveredSeconds, bucketCount, kbps } from './throughput.ts';
import { filterSql, type Filters } from './sql.ts';

export const BURST_DIRS: readonly BurstDir[] = ['both', 'tx', 'rx', 'total'];

export function parseBurstDir(raw: unknown): BurstDir {
  if (raw === undefined || raw === '') return 'total';
  if (typeof raw === 'string' && (BURST_DIRS as readonly string[]).includes(raw)) return raw as BurstDir;
  throw badRequest(`dir: expected one of ${BURST_DIRS.join(', ')}`);
}

/** The sides a direction answers: both is tx and rx (one scan for the mirrored chart). */
export const sidesOf = (dir: BurstDir): BurstSide[] => (dir === 'both' ? ['tx', 'rx'] : [dir]);

/** Bytes per side. Constants. */
const METRIC: Record<BurstSide, string> = { tx: 'tx_bytes', rx: 'rx_bytes', total: 'tx_bytes + rx_bytes' };

/**
 * Two-level aggregation over raw `flows`: first sum per tick (`ts`) across
 * all matching flows, then per bucket the bytes (for the true mean) and the
 * per-tick kbps of the ticks that had rows. `instance` narrows it to one
 * process by the primary key. Every piece of SQL text is a constant; input
 * arrives only as params.
 */
export function burstQuery(opts: {
  r: Range;
  dir: BurstDir;
  filters: Filters;
  instance?: { pid: number; start: string } | null;
}): { sql: string; params: Record<string, unknown> } {
  const { r, dir, filters, instance } = opts;
  const f = filterSql(filters);
  const sides = sidesOf(dir);
  const inst = instance ? 'pid = {pid:UInt32} AND proc_start = {start:UInt64} AND ' : '';
  const inner = sides.map((s) => `sum(${METRIC[s]}) AS b_${s}`).join(', ');
  const outer = sides.map((s) => `sum(b_${s}) AS bytes_${s}, groupArray(b_${s} * 8 / greatest(iv, 1)) AS kbps_${s}`).join(',\n           ');
  // Raw flows carry uid, so the filters apply without a join.
  const sql = `SELECT toUnixTimestamp(toStartOfInterval(ts, INTERVAL {step:UInt32} SECOND)) AS t,
           ${outer},
           any(iv) AS interval_ms
    FROM (
      SELECT ts, any(interval_ms) AS iv, ${inner}
      FROM flows
      WHERE ${inst}ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})${f.sql}
      GROUP BY ts
    )
    GROUP BY t
    ORDER BY t`;
  return {
    sql,
    params: { from: r.from, to: r.to, step: r.step, ...f.params, ...(instance && { pid: instance.pid, start: instance.start }) },
  };
}

export type BurstRow = { t: number; interval_ms: number } & Record<string, string | number | number[]>;

/** Rounded like `kbps`: 3 decimals (bps). */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * p95 (nearest rank) and max of `samples` padded with zeros up to `ticks`
 * values: idle ticks write no rows, and leaving them out would overstate both.
 */
export function paddedStats(samples: readonly number[], ticks: number): { p95: number; max: number } {
  const n = Math.max(ticks, samples.length);
  if (n === 0) return { p95: 0, max: 0 };
  const desc = [...samples].sort((a, b) => b - a);
  // Nearest rank: the ceil(0.95 n)-th smallest is the (n - ceil(0.95 n))-th largest (0-based).
  const i = n - Math.ceil(0.95 * n);
  return { p95: round3(Math.max(0, desc[i] ?? 0)), max: round3(Math.max(0, desc[0] ?? 0)) };
}

/**
 * Rows → the response, one value per bucket of the aligned range `r`,
 * zero-filled. The mean is the bucket's bytes over the time it covers (every
 * second, idle or not); p95 and max come from the per-tick rates padded with
 * one zero per missing tick (covered time / the bucket's tick interval).
 */
export function buildBurst(rows: readonly BurstRow[], r: Range, dir: BurstDir): BurstResponse {
  const stepMs = r.step * 1000;
  const n = bucketCount(r);
  const t = Array.from({ length: n }, (_, i) => r.from + i * stepMs);
  const seconds = coveredSeconds({ ...r, table: 'flows' }, t);
  const out: BurstResponse = { from: r.from, to: r.to, step: r.step, dir, t };
  const sides = sidesOf(dir);
  for (const s of sides) out[s] = { mean: new Array<number>(n).fill(0), p95: new Array<number>(n).fill(0), max: new Array<number>(n).fill(0) };
  for (const row of rows) {
    const i = Math.round((row.t * 1000 - r.from) / stepMs);
    if (i < 0 || i >= n) continue;
    const interval = Number(row.interval_ms) || 1000;
    const ticks = Math.round((seconds[i]! * 1000) / interval);
    for (const s of sides) {
      const stats = out[s] as BurstStats;
      const samples = (row[`kbps_${s}`] as number[] | undefined) ?? [];
      const { p95, max } = paddedStats(samples.map(Number), ticks);
      stats.mean[i] = kbps(Number(row[`bytes_${s}`] ?? 0), seconds[i]!);
      stats.p95[i] = p95;
      stats.max[i] = max;
    }
  }
  return out;
}

/** Whether a range is short enough for the all-process scan (one instance is exempt: it reads by key). */
export const burstSpanOk = (from: number, to: number) => to - from <= BURST_MAX_SPAN_MS;
