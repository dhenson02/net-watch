// Process lifetimes (09): one Gantt bar per process instance, from `processes`.
import type { LifetimeBar } from '../../shared/api.ts';

export const LIFETIMES_LIMIT_DEFAULT = 500;
export const LIFETIMES_LIMIT_MAX = 2000;
/** The command line is cut to this many chars. */
const CMDLINE = 120;

/**
 * Latest version of every process instance whose lifetime overlaps
 * [from, to): started before `to` and not ended before `from`. A NULL end
 * (running, or the collector stopped before it saw the exit) overlaps every
 * later range, as in the scatter (08). Latest start first, so a capped answer
 * keeps the most recent instances. Aliases differ from the column names so
 * that WHERE reads columns, not aggregates.
 */
export function lifetimesQuery(opts: { from: number; to: number; limit: number; name?: string; uid?: number }): {
  sql: string;
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = { from: opts.from, to: opts.to, limit: opts.limit };
  // start_ms is fixed per instance: skip the ones that started after `to` before aggregating.
  let where = 'start_ms < fromUnixTimestamp64Milli({to:Int64})';
  if (opts.name !== undefined) {
    where += ' AND name = {name:String}';
    params.name = opts.name;
  }
  if (opts.uid !== undefined) {
    where += ' AND uid = {uid:UInt32}';
    params.uid = opts.uid;
  }
  const sql = `SELECT pid, toString(proc_start) AS start_ns,
       argMax(name, version) AS pname,
       leftUTF8(argMax(cmdline, version), ${CMDLINE}) AS cmd,
       argMax(uid, version) AS puid,
       argMax(start_ms, version) AS st,
       argMax(ended, version) AS en,
       toUnixTimestamp64Milli(st) AS start_ms_,
       toUnixTimestamp64Milli(argMax(first_seen, version)) AS first_seen_ms,
       toUnixTimestamp64Milli(argMax(last_seen, version)) AS last_seen_ms,
       toUnixTimestamp64Milli(en) AS ended_ms,
       argMax(tx_total, version) AS tx,
       argMax(rx_total, version) AS rx
FROM processes
WHERE ${where}
GROUP BY pid, proc_start
HAVING en IS NULL OR en >= fromUnixTimestamp64Milli({from:Int64})
ORDER BY st DESC, pid, proc_start
LIMIT {limit:UInt32}`;
  return { sql, params };
}

/** A row of lifetimesQuery; 64-bit values arrive as strings. */
export interface LifetimeRow {
  pid: number;
  start_ns: string;
  pname: string;
  cmd: string;
  puid: number;
  start_ms_: string;
  first_seen_ms: string;
  last_seen_ms: string;
  ended_ms: string | null;
  tx: string;
  rx: string;
}

export function toLifetimeBar(r: LifetimeRow): LifetimeBar {
  const startMs = Number(r.start_ms_);
  return {
    id: `${r.pid}:${r.start_ns}`,
    pid: r.pid,
    name: r.pname,
    cmdline: r.cmd,
    uid: r.puid,
    startMs,
    // Processes already running when the collector started can have a first
    // I/O "before" the exec time only through clock skew; never draw it so.
    firstSeenMs: Math.max(startMs, Number(r.first_seen_ms)),
    lastSeenMs: Number(r.last_seen_ms),
    endedMs: r.ended_ms === null ? null : Number(r.ended_ms),
    tx: Number(r.tx),
    rx: Number(r.rx),
  };
}
