// Bytes vs calls (14) for one process instance: bytes and calls per bucket
// from raw `flows`, whose key starts with (pid, proc_start), so the query
// reads only that instance's granules. Pure, so node --test covers it.
import type { ProcessCallsResponse } from '../../shared/api.ts';
import { bucketSeconds, rangeParams, timeFilter, type Range } from './range.ts';
import { alignRange, bucketCount, coveredSeconds, kbps, perSecond } from './throughput.ts';

/**
 * `r` read from raw `flows` whatever its span (parseRange picks the rollup
 * beyond 2 h, which is keyed by minute first), `from` rounded down to a bucket.
 */
export function rawRange(r: Range): Range {
  return alignRange({ ...r, table: 'flows', col: 'ts' });
}

/** Bytes and calls per bucket of one instance. `r` must come from rawRange. */
export function processCallsQuery(r: Range, id: { pid: number; start: string }): { sql: string; params: Record<string, unknown> } {
  const sql = `SELECT ${bucketSeconds(r)} AS t,
           sum(tx_bytes) AS tx, sum(rx_bytes) AS rx, sum(tx_calls) AS txc, sum(rx_calls) AS rxc
    FROM flows
    WHERE pid = {pid:UInt32} AND proc_start = {start:UInt64} AND ${timeFilter(r)}
    GROUP BY t
    ORDER BY t`;
  return { sql, params: { ...rangeParams(r), pid: id.pid, start: id.start } };
}

export type ProcessCallsRow = { t: number; tx: string | number; rx: string | number; txc: string | number; rxc: string | number };

/** Rows → kbps and calls per second per bucket, zero-filled. */
export function buildProcessCalls(rows: readonly ProcessCallsRow[], r: Range): ProcessCallsResponse {
  const stepMs = r.step * 1000;
  const n = bucketCount(r);
  const zeros = () => new Array<number>(n).fill(0);
  const tx = zeros();
  const rx = zeros();
  const txc = zeros();
  const rxc = zeros();
  for (const row of rows) {
    const i = Math.round((row.t * 1000 - r.from) / stepMs);
    if (i < 0 || i >= n) continue;
    tx[i]! += Number(row.tx);
    rx[i]! += Number(row.rx);
    txc[i]! += Number(row.txc);
    rxc[i]! += Number(row.rxc);
  }
  const t = Array.from({ length: n }, (_, i) => r.from + i * stepMs);
  const s = coveredSeconds(r, t);
  return {
    step: r.step,
    from: r.from,
    to: r.to,
    t,
    tx: tx.map((b, i) => kbps(b, s[i]!)),
    rx: rx.map((b, i) => kbps(b, s[i]!)),
    calls: { tx: txc.map((c, i) => perSecond(c, s[i]!)), rx: rxc.map((c, i) => perSecond(c, s[i]!)) },
  };
}
