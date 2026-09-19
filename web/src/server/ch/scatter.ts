// tx vs rx scatter (08): one point per process instance, or per name, placed
// by bytes sent and received. The query over `processes` (lifetime totals) or
// the flow tables (totals within the range) and its row conversion.
import type { ScatterBasis, ScatterGroup, ScatterPoint } from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';
import type { Range } from './range.ts';
import { filterSql, flowSource, UNKNOWN_UID, type Filters } from './sql.ts';

export const SCATTER_LIMIT_DEFAULT = 2000;
export const SCATTER_LIMIT_MAX = 5000;
/** The command line is cut to this many chars. */
export const SCATTER_CMDLINE = 300;

export function parseGroup(raw: unknown): ScatterGroup {
  if (raw === undefined || raw === '' || raw === 'instance') return 'instance';
  if (raw === 'name') return 'name';
  throw badRequest('group: expected instance or name');
}

export function parseBasis(raw: unknown): ScatterBasis {
  if (raw === undefined || raw === '' || raw === 'lifetime') return 'lifetime';
  if (raw === 'range') return 'range';
  throw badRequest('basis: expected lifetime or range');
}

/**
 * The range condition on a flow table. Raw flows are exact; the rollup
 * includes the minute `from` falls in (as /api/history/flows does). Constants.
 */
function flowTime(r: Range): string {
  return r.table === 'flows'
    ? 'ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})'
    : 'minute >= toStartOfMinute(fromUnixTimestamp64Milli({from:Int64})) AND minute < fromUnixTimestamp64Milli({to:Int64})';
}

/** Latest version of every process instance, with its times as ms. Aliases differ from the column names. */
const PROC_COLUMNS = `argMax(name, version) AS p_name,
       leftUTF8(argMax(cmdline, version), ${SCATTER_CMDLINE}) AS p_cmd,
       argMax(uid, version) AS p_uid,
       argMax(tx_total, version) AS p_tx,
       argMax(rx_total, version) AS p_rx,
       argMax(start_ms, version) AS p_start,
       argMax(ended, version) AS p_ended,
       argMax(last_seen, version) AS p_last`;

/**
 * One row per process instance: `pid, proc_start, pname, cmd, puid, tx, rx,
 * start_ms, ended_ms, last_ms` (ms columns nullable).
 *
 * - `lifetime`: `processes`' lifetime totals, for instances whose lifetime
 *   overlaps the range (started before `to`, not ended before `from`).
 * - `range`: bytes within the range from the flow table, with the instance's
 *   details joined from `processes` (missing there: uid UNKNOWN_UID, times null).
 *
 * The page's filters are flow-level (app, proto, dest), so under `lifetime`
 * they keep the instances that had matching traffic in the range.
 */
function instances(r: Range, basis: ScatterBasis, filters: Filters): { sql: string; params: Record<string, unknown> } {
  const time = flowTime(r);
  const f = filterSql(filters);
  const src = flowSource(r.table, time, filters.uid !== undefined);
  if (basis === 'lifetime') {
    const where = f.sql ? `WHERE (pid, proc_start) IN (SELECT pid, proc_start FROM ${src} WHERE ${time}${f.sql})` : '';
    return {
      sql: `SELECT pid, proc_start, p_name AS pname, p_cmd AS cmd, p_uid AS puid, p_tx AS tx, p_rx AS rx,
              toUnixTimestamp64Milli(p_start) AS start_ms, toUnixTimestamp64Milli(p_ended) AS ended_ms, toUnixTimestamp64Milli(p_last) AS last_ms
       FROM (
         SELECT pid, proc_start, ${PROC_COLUMNS}
         FROM processes
         ${where}
         GROUP BY pid, proc_start
         HAVING p_start < fromUnixTimestamp64Milli({to:Int64})
            AND (p_ended IS NULL OR p_ended >= fromUnixTimestamp64Milli({from:Int64}))
            AND p_tx + p_rx > 0
       )`,
      params: f.params,
    };
  }
  return {
    sql: `SELECT pid, proc_start, f_pname AS pname, p_cmd AS cmd, if(p_known = 1, p_uid, ${UNKNOWN_UID}) AS puid, f_tx AS tx, f_rx AS rx,
              if(p_known = 1, toUnixTimestamp64Milli(p_start), NULL) AS start_ms,
              if(p_known = 1, toUnixTimestamp64Milli(p_ended), NULL) AS ended_ms,
              if(p_known = 1, toUnixTimestamp64Milli(p_last), NULL) AS last_ms
       FROM (
         SELECT pid, proc_start, any(name) AS f_pname, sum(tx_bytes) AS f_tx, sum(rx_bytes) AS f_rx
         FROM ${src}
         WHERE ${time}${f.sql}
         GROUP BY pid, proc_start
         HAVING f_tx + f_rx > 0
       ) AS f
       LEFT JOIN (
         SELECT pid, proc_start, ${PROC_COLUMNS}, toUInt8(1) AS p_known
         FROM processes
         GROUP BY pid, proc_start
       ) AS p USING (pid, proc_start)`,
    params: f.params,
  };
}

/**
 * The scatter query: the instances above, largest (tx + rx) first, or summed
 * per name (`n` instances; `id`, cmdline and uid of the busiest one; the
 * earliest start and latest end, null while any instance runs).
 */
export function scatterQuery(opts: { range: Range; group: ScatterGroup; basis: ScatterBasis; filters: Filters; limit: number }): {
  sql: string;
  params: Record<string, unknown>;
} {
  const inner = instances(opts.range, opts.basis, opts.filters);
  const params = { from: opts.range.from, to: opts.range.to, limit: opts.limit, ...inner.params };
  const sql =
    opts.group === 'instance'
      ? `SELECT concat(toString(pid), ':', toString(proc_start)) AS id, pid, pname AS name, cmd, puid AS uid,
       tx, rx, toUInt64(1) AS n, start_ms, ended_ms, last_ms
FROM (${inner.sql})
ORDER BY tx + rx DESC, pid, proc_start
LIMIT {limit:UInt32}`
      : `SELECT argMax(iid, itx + irx) AS id, argMax(pid, itx + irx) AS pid, pname AS name, argMax(cmd, itx + irx) AS cmd,
       argMax(puid, itx + irx) AS uid, sum(itx) AS tx, sum(irx) AS rx, count() AS n,
       min(start_ms) AS start_ms, if(countIf(ended_ms IS NULL) > 0, NULL, max(ended_ms)) AS ended_ms, max(last_ms) AS last_ms
FROM (SELECT concat(toString(pid), ':', toString(proc_start)) AS iid, pid, pname, cmd, puid, tx AS itx, rx AS irx, start_ms, ended_ms, last_ms
      FROM (${inner.sql}))
GROUP BY pname
ORDER BY tx + rx DESC, name
LIMIT {limit:UInt32}`;
  return { sql, params };
}

/** A row of scatterQuery; 64-bit values arrive as strings. */
export interface ScatterRow {
  id: string;
  pid: number;
  name: string;
  cmd: string;
  uid: number;
  tx: string;
  rx: string;
  n: string;
  start_ms: string | null;
  ended_ms: string | null;
  last_ms: string | null;
}

const msOrNull = (v: string | null) => (v === null ? null : Number(v));

export function toScatterPoint(r: ScatterRow, user: (uid: number) => string | null): ScatterPoint {
  return {
    id: r.id,
    pid: r.pid,
    name: r.name,
    cmdline: r.cmd,
    uid: r.uid,
    user: r.uid === UNKNOWN_UID ? null : user(r.uid),
    tx: Number(r.tx),
    rx: Number(r.rx),
    instances: Number(r.n),
    startMs: msOrNull(r.start_ms),
    endedMs: msOrNull(r.ended_ms),
    lastSeenMs: msOrNull(r.last_ms),
  };
}
