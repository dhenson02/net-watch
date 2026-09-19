// Process start/end markers (12): the query over `processes` and its params.
import type { LifecycleProc } from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';

export const LIFECYCLE_LIMIT_DEFAULT = 200;
export const LIFECYCLE_LIMIT_MAX = 1000;
export const MAX_NAMES = 50;
const MAX_NAME_LEN = 256;

/**
 * `names=a,b,c` (or repeated `names=`): the process names to keep, deduped.
 * Undefined when absent or empty (no name filter).
 */
export function parseNames(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => {
    if (typeof v !== 'string') throw badRequest('names: expected a comma-separated list');
    return v.split(',');
  });
  const names = [...new Set(parts.filter((n) => n !== ''))];
  if (names.length > MAX_NAMES) throw badRequest(`names: at most ${MAX_NAMES} names`);
  if (names.some((n) => n.length > MAX_NAME_LEN)) throw badRequest(`names: a name is longer than ${MAX_NAME_LEN} chars`);
  return names.length ? names : undefined;
}

/**
 * Latest version of every process instance whose first network I/O or end
 * lies in [from, to), largest lifetime total first. `first_seen` is fixed per
 * instance, so rows that started talking after `to` are skipped before the
 * aggregation. Aliases differ from the column names so that the WHERE clause
 * reads columns, not aggregates.
 */
export function lifecycleQuery(opts: { from: number; to: number; limit: number; names?: string[]; uid?: number }): {
  sql: string;
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = { from: opts.from, to: opts.to, limit: opts.limit };
  let where = 'first_seen < fromUnixTimestamp64Milli({to:Int64})';
  if (opts.names) {
    where += ' AND name IN {names:Array(String)}';
    params.names = opts.names;
  }
  if (opts.uid !== undefined) {
    where += ' AND uid = {uid:UInt32}';
    params.uid = opts.uid;
  }
  const sql = `SELECT pid, toString(proc_start) AS start_ns,
       argMax(name, version) AS pname,
       leftUTF8(argMax(cmdline, version), 120) AS cmd,
       argMax(first_seen, version) AS fs,
       argMax(ended, version) AS en,
       toUnixTimestamp64Milli(fs) AS first_seen_ms,
       toUnixTimestamp64Milli(en) AS ended_ms,
       argMax(tx_total, version) + argMax(rx_total, version) AS bytes
FROM processes
WHERE ${where}
GROUP BY pid, proc_start
HAVING (fs >= fromUnixTimestamp64Milli({from:Int64}) AND fs < fromUnixTimestamp64Milli({to:Int64}))
    OR (en >= fromUnixTimestamp64Milli({from:Int64}) AND en < fromUnixTimestamp64Milli({to:Int64}))
ORDER BY bytes DESC, pid, proc_start
LIMIT {limit:UInt32}`;
  return { sql, params };
}

/** A row of lifecycleQuery; 64-bit values arrive as strings. */
export interface LifecycleRow {
  pid: number;
  start_ns: string;
  pname: string;
  cmd: string;
  first_seen_ms: string;
  ended_ms: string | null;
  bytes: string;
}

export function toLifecycleProc(r: LifecycleRow): LifecycleProc {
  return {
    id: `${r.pid}:${r.start_ns}`,
    pid: r.pid,
    name: r.pname,
    cmdline: r.cmd,
    firstSeenMs: Number(r.first_seen_ms),
    endedMs: r.ended_ms === null ? null : Number(r.ended_ms),
    bytes: Number(r.bytes),
  };
}
