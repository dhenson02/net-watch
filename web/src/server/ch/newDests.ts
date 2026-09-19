// New-destination markers (17), phase 1: query-only, no first-seen table.
// "First ever" needs the whole history, so both queries scan all of
// `flows_1m` (up to 2 years). That is fine while the table is small; the
// route logs a warning once a request takes longer than NEW_DESTS_SLOW_MS
// (time for phase 2, a `dest_first_seen` table; its design is in
// `git show 5342a2b:plans/17-new-destinations.md`).
import type { NewDest, NewDestsResponse } from '../../shared/api.ts';
import { destText } from './beacons.ts';
import { DISPLAY_IP } from './sql.ts';

export const NEW_DESTS_LIMIT_DEFAULT = 500;
export const NEW_DESTS_LIMIT_MAX = 2000;
/** Destinations first seen this soon after the table's first minute are "warm-up": right after install, everything is new. */
export const WARMUP_MS = 24 * 3_600_000;
/** Above this, the scans are too slow for a page load: log a hint to move to the first-seen table. */
export const NEW_DESTS_SLOW_MS = 1000;
const HOUR_S = 3600;

/** UDP receivers with no peer address (`0.0.0.0` is stored IPv4-mapped). */
const NO_PEER = "raddr NOT IN (toIPv6('::'), toIPv6('0.0.0.0'))";
/** `::1` or 127.0.0.0/8 (IPv4-mapped); IPv6 values compare as 128-bit numbers. */
const LOOPBACK = "(raddr = toIPv6('::1') OR (raddr >= toIPv6('127.0.0.0') AND raddr <= toIPv6('127.255.255.255')))";
const NAME_FILTER = ' AND name IN {names:Array(String)}';
/** The first contacts' minute, as a DateTime range condition on `fm`. */
const IN_RANGE = 'fm >= toDateTime(intDiv({from:Int64}, 1000)) AND fm < toDateTime(intDiv({to:Int64}, 1000))';

export interface NewDestsOptions {
  from: number;
  to: number;
  /** Exact process names; undefined = every name. */
  names?: string[];
  /** Key by (name, raddr, rport) instead of (name, raddr). */
  ports: boolean;
  /** Keep loopback destinations (hidden by default). */
  loopback: boolean;
  /** Keep destinations first seen within WARMUP_MS of the table's first minute (hidden by default). */
  warmup: boolean;
  limit: number;
}

/**
 * Query 1: every (name, raddr[, rport]) whose first minute anywhere in
 * `flows_1m` lies in [from, to), with the app, proto, port and instance of
 * that first minute. Hidden rows (loopback, warm-up) are sorted last rather
 * than dropped, so the window counts always arrive, even when nothing is
 * visible; `n_vis` says whether visible rows were cut by the limit.
 */
export function newDestsQuery(o: NewDestsOptions): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    from: o.from,
    to: o.to,
    limit: o.limit,
    show_lo: o.loopback ? 1 : 0,
    show_warm: o.warmup ? 1 : 0,
    warmup_s: WARMUP_MS / 1000,
  };
  if (o.names) params.names = o.names;
  const key = o.ports ? 'name, raddr, rport' : 'name, raddr';
  const port = o.ports ? 'rport' : 'argMin(rport, minute)';
  const sql = `SELECT name, ip, port, app, proto, first_s, iid, lo, warm,
       countIf(lo AND NOT {show_lo:UInt8}) OVER () AS n_lo,
       countIf(warm AND NOT {show_warm:UInt8} AND NOT (lo AND NOT {show_lo:UInt8})) OVER () AS n_warm,
       countIf(NOT hidden) OVER () AS n_vis
FROM (
  SELECT name, ${DISPLAY_IP} AS ip, ${port} AS port,
         argMin(app, minute) AS app, argMin(proto, minute) AS proto,
         argMin(concat(toString(pid), ':', toString(proc_start)), minute) AS iid,
         min(minute) AS fm, toUnixTimestamp(fm) AS first_s,
         ${LOOPBACK} AS lo,
         fm < (SELECT min(minute) FROM flows_1m) + toIntervalSecond({warmup_s:UInt32}) AS warm,
         (lo AND NOT {show_lo:UInt8}) OR (warm AND NOT {show_warm:UInt8}) AS hidden
  FROM flows_1m
  WHERE ${NO_PEER}${o.names ? NAME_FILTER : ''}
  GROUP BY ${key}
  HAVING ${IN_RANGE}
)
ORDER BY hidden, first_s, name, ip, port
LIMIT {limit:UInt32}`;
  return { sql, params };
}

/**
 * Query 2: per-minute bytes of the destinations first seen in the range,
 * from their first minute up to an hour past `to`, summed into each one's
 * first hour in JS (`firstHourBytes`). The subquery repeats query 1's scan
 * (phase 1 tolerates it); it takes every first contact in range, hidden ones
 * too, which only adds rows the caller ignores.
 */
export function firstHourQuery(o: Pick<NewDestsOptions, 'from' | 'to' | 'names' | 'ports'>): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { from: o.from, to: o.to };
  if (o.names) params.names = o.names;
  const key = o.ports ? 'name, raddr, rport' : 'name, raddr';
  const sql = `SELECT name, ${DISPLAY_IP} AS ip, ${o.ports ? 'rport' : '0'} AS port,
       toUnixTimestamp(minute) AS m, sum(tx_bytes + rx_bytes) AS bytes
FROM flows_1m
WHERE minute >= toDateTime(intDiv({from:Int64}, 1000)) - INTERVAL 1 MINUTE
  AND minute < toDateTime(intDiv({to:Int64}, 1000)) + INTERVAL 1 HOUR
  AND (${key}) IN (
    SELECT ${key} FROM flows_1m
    WHERE ${NO_PEER}${o.names ? NAME_FILTER : ''}
    GROUP BY ${key}
    HAVING ${IN_RANGE.replaceAll('fm', 'min(minute)')})
GROUP BY name, raddr, port, minute`;
  return { sql, params };
}

export type NewDestRow = {
  name: string;
  ip: string;
  port: number;
  app: string;
  proto: string;
  first_s: number;
  iid: string;
  lo: number;
  warm: number;
  n_lo: string | number;
  n_warm: string | number;
  n_vis: string | number;
};

export type FirstHourRow = { name: string; ip: string; port: number; m: number; bytes: string | number };

const keyOf = (name: string, ip: string, port: number) => `${name}\u0000${ip}\u0000${port}`;

/**
 * Rows of both queries → the answer. Hidden rows (sorted last) are dropped;
 * `limit` is the requested limit (query 1 asked for one more than that).
 */
export function buildNewDests(
  rows: readonly NewDestRow[],
  hours: readonly FirstHourRow[],
  o: Pick<NewDestsOptions, 'from' | 'to' | 'ports' | 'loopback' | 'warmup' | 'limit'>,
  firstMinuteMs: number | null,
): NewDestsResponse {
  // Bytes per key and minute, for the first-hour sums.
  const perKey = new Map<string, [number, number][]>();
  for (const h of hours) {
    const k = keyOf(h.name, h.ip, o.ports ? h.port : 0);
    let list = perKey.get(k);
    if (!list) perKey.set(k, (list = []));
    list.push([Number(h.m), Number(h.bytes)]);
  }
  const visible = rows.filter((r) => !((r.lo && !o.loopback) || (r.warm && !o.warmup)));
  const dests: NewDest[] = visible.slice(0, o.limit).map((r) => {
    const first = Number(r.first_s);
    let bytes = 0;
    for (const [m, b] of perKey.get(keyOf(r.name, r.ip, o.ports ? r.port : 0)) ?? []) if (m >= first && m < first + HOUR_S) bytes += b;
    const i = r.iid.indexOf(':');
    return {
      name: r.name,
      ip: r.ip,
      port: r.port,
      dest: destText(r.ip, r.port),
      app: r.app,
      proto: r.proto,
      firstMs: first * 1000,
      firstHourBytes: bytes,
      id: r.iid,
      pid: Number(r.iid.slice(0, i)),
      loopback: r.lo === 1,
      warmup: r.warm === 1,
    };
  });
  const head = rows[0];
  const nVis = head ? Number(head.n_vis) : 0;
  return {
    from: o.from,
    to: o.to,
    ports: o.ports,
    dests,
    truncated: nVis > o.limit,
    hidden: { loopback: head ? Number(head.n_lo) : 0, warmup: head ? Number(head.n_warm) : 0 },
    warmupUntil: firstMinuteMs === null ? null : firstMinuteMs + WARMUP_MS,
  };
}
