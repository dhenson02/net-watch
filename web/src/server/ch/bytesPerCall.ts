// Bytes-per-call distribution (10): calls bucketed by log2 of each source
// row's bytes / calls, weighted by calls. Raw `flows` rows are one flow over
// one tick; `flows_1m` rows are first summed per flow-minute (the rollup is a
// SummingMergeTree, so unmerged parts may split one), then bucketed. Pure, so
// node --test covers it.
import {
  BPC_BUCKETS,
  type BytesPerCallBy,
  type BytesPerCallDir,
  type BytesPerCallResponse,
  type BytesPerCallRow,
} from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';
import { rangeParams, timeFilter, type Range } from './range.ts';
import { filterSql, flowSource, type Filters } from './sql.ts';

/** Rows of the History heatmap before the rest is folded. */
export const BPC_TOP = 10;

/** The only SQL a `dir` selects: [bytes, calls]. */
const DIR_COLS: Record<BytesPerCallDir, [string, string]> = {
  tx: ['tx_bytes', 'tx_calls'],
  rx: ['rx_bytes', 'rx_calls'],
};

export function parseBpcDir(raw: unknown): BytesPerCallDir {
  if (raw === undefined || raw === '') return 'tx';
  if (raw === 'tx' || raw === 'rx') return raw;
  throw badRequest('dir: expected tx or rx');
}

export function parseBpcBy(raw: unknown): BytesPerCallBy {
  if (raw === undefined || raw === '') return 'app';
  if (raw === 'app' || raw === 'name') return raw;
  throw badRequest('by: expected app or name');
}

/**
 * The optional `pid` + `start` pair of the History endpoint: both or neither.
 * `start` (a u64) stays a string.
 */
export function parseInstance(q: Record<string, unknown>): { pid: number; start: string } | null {
  const { pid, start } = q;
  const has = (v: unknown) => v !== undefined && v !== '';
  if (!has(pid) && !has(start)) return null;
  if (!has(pid) || !has(start)) throw badRequest('pid and start go together');
  if (typeof pid !== 'string' || !/^\d{1,10}$/.test(pid) || Number(pid) > 0xffffffff) throw badRequest('pid: expected a u32');
  if (typeof start !== 'string' || !/^\d{1,20}$/.test(start) || BigInt(start) > 2n ** 64n - 1n) throw badRequest('start: expected a u64');
  return { pid: Number(pid), start: BigInt(start).toString() };
}

/** The bucket of a mean, as the SQL computes it: floor(log2(max(mean, 1))), capped at the last bucket. */
export function bucketOf(bytesPerCall: number): number {
  return Math.min(BPC_BUCKETS - 1, Math.floor(Math.log2(Math.max(bytesPerCall, 1))));
}

/**
 * Calls and bytes per (key, bucket). `r` picks the table (a Range from
 * parseRange, or raw `flows` for one instance); with `instance`, only that
 * process, read by the raw table's primary key. The page's filters apply.
 */
export function bytesPerCallQuery(opts: {
  r: Range;
  dir: BytesPerCallDir;
  by: BytesPerCallBy;
  filters: Filters;
  instance?: { pid: number; start: string } | null;
}): { sql: string; params: Record<string, unknown> } {
  const { r, dir, by, filters, instance } = opts;
  const [b, c] = DIR_COLS[dir];
  const f = filterSql(filters);
  const time = timeFilter(r);
  const inst = instance ? 'pid = {pid:UInt32} AND proc_start = {start:UInt64} AND ' : '';
  const where = `${inst}${time}${f.sql}`;
  const params: Record<string, unknown> = { ...rangeParams(r), ...f.params, ...(instance && { pid: instance.pid, start: instance.start }) };
  // `by` is validated to app|name, both plain columns.
  const src =
    r.table === 'flows'
      ? `(SELECT ${by} AS k, ${b} AS b, ${c} AS c FROM flows WHERE ${where})`
      : `(SELECT ${by} AS k, sum(${b}) AS b, sum(${c}) AS c
          FROM ${flowSource('flows_1m', time, filters.uid !== undefined)}
          WHERE ${where}
          GROUP BY k, minute, pid, proc_start, proto, app, raddr, rport)`;
  const sql = `SELECT k, least(toUInt8(floor(log2(greatest(b / c, 1)))), ${BPC_BUCKETS - 1}) AS bucket,
       sum(c) AS calls, sum(b) AS bytes
FROM ${src}
WHERE c > 0
GROUP BY k, bucket
ORDER BY k, bucket`;
  return { sql, params };
}

export type BytesPerCallQueryRow = { k: string; bucket: number | string; calls: string | number; bytes: string | number };

const emptyRow = (key: string | null): BytesPerCallRow => ({
  key,
  calls: new Array<number>(BPC_BUCKETS).fill(0),
  bytes: new Array<number>(BPC_BUCKETS).fill(0),
  totalCalls: 0,
  totalBytes: 0,
});

function addInto(into: BytesPerCallRow, from: BytesPerCallRow): void {
  for (let i = 0; i < BPC_BUCKETS; i++) {
    into.calls[i]! += from.calls[i]!;
    into.bytes[i]! += from.bytes[i]!;
  }
  into.totalCalls += from.totalCalls;
  into.totalBytes += from.totalBytes;
}

/** Rows → one histogram per key, the top `top` by calls, the rest folded into a null row, and the total. */
export function buildBytesPerCall(
  rows: readonly BytesPerCallQueryRow[],
  base: Omit<BytesPerCallResponse, 'total' | 'rows' | 'folded'>,
  top = BPC_TOP,
): BytesPerCallResponse {
  const byKey = new Map<string, BytesPerCallRow>();
  for (const row of rows) {
    const i = Number(row.bucket);
    if (!(i >= 0 && i < BPC_BUCKETS)) continue;
    let h = byKey.get(row.k);
    if (!h) byKey.set(row.k, (h = emptyRow(row.k)));
    const calls = Number(row.calls);
    const bytes = Number(row.bytes);
    h.calls[i]! += calls;
    h.bytes[i]! += bytes;
    h.totalCalls += calls;
    h.totalBytes += bytes;
  }
  const all = [...byKey.values()].sort((a, b) => b.totalCalls - a.totalCalls || String(a.key).localeCompare(String(b.key)));
  const total = emptyRow('');
  for (const h of all) addInto(total, h);
  const kept = all.slice(0, top);
  const rest = all.slice(top);
  if (rest.length) {
    const other = emptyRow(null);
    for (const h of rest) addInto(other, h);
    kept.push(other);
  }
  return { ...base, total, rows: kept, folded: rest.length };
}
