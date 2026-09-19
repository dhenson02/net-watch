// SQL fragments shared by the history queries. They are constants: user input
// never becomes SQL text, only `{name:Type}` parameters.
import { isIP } from 'node:net';
import type { ThroughputBy } from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';

/**
 * `raddr` as text, matching the plain IPv4 that Redis and the live API show
 * (IPv4 is stored IPv4-mapped, `::ffff:a.b.c.d`). For the reverse direction,
 * filtering by user-typed text, use `raddr = toIPv6({ip:String})`: toIPv6 maps
 * IPv4 input to `::ffff:…`.
 */
export const DISPLAY_IP = "replaceRegexpOne(IPv6NumToString(raddr), '^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$', '\\1')";

/** WHERE condition for one destination; its params come from `parseDest`. */
export const DEST_FILTER = 'raddr = toIPv6({dest_ip:String}) AND rport = {dest_port:UInt16}';

/**
 * Parses a destination filter, `ip:port` as the dashboard shows it
 * (`1.2.3.4:443`, `2001:db8::1:443` or `[2001:db8::1]:443`), into
 * `DEST_FILTER`'s params. Missing means no filter.
 */
export function parseDest(raw: unknown): { dest_ip: string; dest_port: number } | null {
  if (raw === undefined || raw === '') return null;
  const bad = () => badRequest('dest: expected ip:port');
  if (typeof raw !== 'string' || raw.length > 64) throw bad();
  const i = raw.lastIndexOf(':');
  if (i <= 0) throw bad();
  let ip = raw.slice(0, i);
  const port = raw.slice(i + 1);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (!isIP(ip) || !/^\d{1,5}$/.test(port) || Number(port) > 65535) throw bad();
  return { dest_ip: ip, dest_port: Number(port) };
}

// ---------------------------------------------------------------------------
// Group-by dimensions and filters (History throughput, 05)

export const DIMENSIONS: readonly ThroughputBy[] = ['app', 'name', 'proto', 'uid', 'dest'];

/**
 * uid of `flows_1m` rows whose process is missing from `processes` (the
 * rollup has no uid column; see `flowSource`). (uid_t)-1 is never a real uid.
 */
export const UNKNOWN_UID = 4294967295;

/**
 * The group-by expression per dimension, as a String. The key into this map is
 * validated against DIMENSIONS; its value is the only SQL that `by` selects.
 * `dest` matches the dashboard's `ip:port` text (IPv6 in brackets), which
 * `parseDest` reads back.
 */
export const BY_COLUMNS: Record<ThroughputBy, string> = {
  app: 'app',
  name: 'name',
  proto: 'proto',
  uid: 'toString(uid)',
  dest: `if(position(${DISPLAY_IP}, ':') > 0, concat('[', ${DISPLAY_IP}, ']:', toString(rport)), concat(${DISPLAY_IP}, ':', toString(rport)))`,
};

export function parseBy(raw: unknown, fallback: ThroughputBy = 'app'): ThroughputBy {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw === 'string' && (DIMENSIONS as readonly string[]).includes(raw)) return raw as ThroughputBy;
  throw badRequest(`by: expected one of ${DIMENSIONS.join(', ')}`);
}

/** Exact-match filters; `dest` is `parseDest`'s result. */
export interface Filters {
  name?: string;
  app?: string;
  proto?: string;
  uid?: number;
  dest?: { dest_ip: string; dest_port: number };
}

const MAX_FILTER_LEN = 256;

/** Reads the `name`, `app`, `proto`, `uid` and `dest` query parameters. Missing or empty means no filter. */
export function parseFilters(q: Record<string, unknown>): Filters {
  const f: Filters = {};
  for (const k of ['name', 'app', 'proto'] as const) {
    const v = q[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || v.length > MAX_FILTER_LEN) throw badRequest(`${k}: expected a string of at most ${MAX_FILTER_LEN} chars`);
    f[k] = v;
  }
  const uid = q.uid;
  if (uid !== undefined && uid !== '') {
    if (typeof uid !== 'string' || !/^\d{1,10}$/.test(uid) || Number(uid) > UNKNOWN_UID) throw badRequest('uid: expected an integer uid');
    f.uid = Number(uid);
  }
  const dest = parseDest(q.dest);
  if (dest) f.dest = dest;
  return f;
}

/**
 * ` AND …` conditions for the set filters (constant fragments) and their
 * query params. Empty when no filter is set.
 */
export function filterSql(f: Filters): { sql: string; params: Record<string, string | number> } {
  let sql = '';
  const params: Record<string, string | number> = {};
  if (f.name !== undefined) {
    sql += ' AND name = {f_name:String}';
    params.f_name = f.name;
  }
  if (f.app !== undefined) {
    sql += ' AND app = {f_app:String}';
    params.f_app = f.app;
  }
  if (f.proto !== undefined) {
    sql += ' AND proto = {f_proto:String}';
    params.f_proto = f.proto;
  }
  if (f.uid !== undefined) {
    sql += ' AND uid = {f_uid:UInt32}';
    params.f_uid = f.uid;
  }
  if (f.dest) {
    sql += ` AND ${DEST_FILTER}`;
    Object.assign(params, f.dest);
  }
  return { sql, params };
}

/**
 * The FROM source for a flow query. `flows` and a plain `flows_1m` are the
 * table itself. `flows_1m` has no uid, so when the query groups or filters by
 * uid it becomes a subquery that joins each row's process instance to
 * `processes` (a small table); rows whose process is missing get UNKNOWN_UID.
 * `time` is the range condition, applied inside the subquery too so the
 * rollup's (minute, …) key still prunes.
 */
export function flowSource(table: 'flows' | 'flows_1m', time: string, needUid: boolean): string {
  if (table === 'flows' || !needUid) return table;
  return `(SELECT minute, pid, proc_start, name, proto, app, raddr, rport, tx_bytes, rx_bytes, tx_calls, rx_calls,
            if(p.p_known = 1, p.p_uid, ${UNKNOWN_UID}) AS uid
          FROM flows_1m
          LEFT JOIN (SELECT pid, proc_start, argMax(uid, version) AS p_uid, toUInt8(1) AS p_known
                     FROM processes GROUP BY pid, proc_start) AS p USING (pid, proc_start)
          WHERE ${time})`;
}
