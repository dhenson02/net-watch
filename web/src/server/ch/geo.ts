// Bytes by ASN, by country and per destination (18, option A). ClickHouse
// knows nothing of ASNs, so the queries return per-IP (or per ip:port) sums,
// the largest GEO_IP_LIMIT, and the grouping happens here with the geo table.
import {
  GEO_IP_LIMIT,
  type AsnRow,
  type CountryRow,
  type DestRow,
  type DestScope,
  type Geo,
  type GeoBreakdown,
  type GeoDir,
  type GeoSum,
} from '../../shared/api.ts';
import { ipScope, parseIp, type ParsedIp } from '../geo/ip.ts';
import { badRequest } from '../http-error.ts';
import { destText } from './beacons.ts';
import { rangeParams, timeFilter, type Range } from './range.ts';
import { DISPLAY_IP, filterSql, flowSource, type Filters } from './sql.ts';

export function parseGeoDir(raw: unknown): GeoDir {
  if (raw === undefined || raw === '') return 'total';
  if (raw === 'total' || raw === 'tx' || raw === 'rx') return raw;
  throw badRequest('dir: expected total, tx or rx');
}

/** The ranking expression of `dir` over columns `tx`/`rx` (a constant fragment). */
const rankSql = (dir: GeoDir) => (dir === 'tx' ? 'tx' : dir === 'rx' ? 'rx' : 'tx + rx');
/** The same over the table's own columns, per row. */
const rawRankSql = (dir: GeoDir) => (dir === 'tx' ? 'tx_bytes' : dir === 'rx' ? 'rx_bytes' : 'tx_bytes + rx_bytes');
const pick = (dir: GeoDir, tx: number, rx: number) => (dir === 'tx' ? tx : dir === 'rx' ? rx : tx + rx);

export interface IpTotalRow {
  ip: string;
  tx: string | number;
  rx: string | number;
}
export interface TotalsRow {
  tx: string | number;
  rx: string | number;
  ips: string | number;
}

/** Per-IP sums over the range, the largest `limit` by `dir`, and the totals over every IP. */
export function ipTotalsQueries(r: Range, dir: GeoDir, filters: Filters, limit = GEO_IP_LIMIT) {
  const time = timeFilter(r);
  const f = filterSql(filters);
  const src = flowSource(r.table, time, filters.uid !== undefined);
  const params = { ...rangeParams(r), ...f.params, limit };
  return {
    perIp: {
      sql: `SELECT ${DISPLAY_IP} AS ip, sum(tx_bytes) AS tx, sum(rx_bytes) AS rx
            FROM ${src} WHERE ${time}${f.sql}
            GROUP BY raddr
            HAVING ${rankSql(dir)} > 0
            ORDER BY ${rankSql(dir)} DESC, ip
            LIMIT {limit:UInt32}`,
      params,
    },
    totals: {
      sql: `SELECT sum(tx_bytes) AS tx, sum(rx_bytes) AS rx, uniqExactIf(raddr, ${rawRankSql(dir)} > 0) AS ips
            FROM ${src} WHERE ${time}${f.sql}`,
      params,
    },
  };
}

const zero = (): GeoSum => ({ tx: 0, rx: 0, bytes: 0, ips: 0 });
const addTo = (s: GeoSum, tx: number, rx: number, bytes: number) => {
  s.tx += tx;
  s.rx += rx;
  s.bytes += bytes;
  s.ips++;
};

/** The geo table's lookup of a parsed address. */
export type Lookup = (ip: ParsedIp) => Geo | null;

/** Where one address belongs: local, public with geo, or public without. */
function classify(ip: string, lookup: Lookup | null): { local: boolean; geo: Geo | null } {
  const p = parseIp(ip);
  if (!p) return { local: false, geo: null };
  if (ipScope(p) !== 'public') return { local: true, geo: null };
  return { local: false, geo: lookup ? lookup(p) : null };
}

/**
 * Groups per-IP sums by ASN and by country. `lookup` is null without a geo
 * table. Rows come back largest `bytes` first (ties: ASN / country code).
 */
export function buildGeoBreakdown(
  perIp: readonly IpTotalRow[],
  totals: TotalsRow | undefined,
  o: { r: Range; dir: GeoDir; lookup: Lookup | null },
): { base: GeoBreakdown; asns: AsnRow[]; countries: CountryRow[] } {
  const { dir } = o;
  const local = zero();
  const unmatched = zero();
  const asns = new Map<number, AsnRow & { byCc: Map<string, number> }>();
  const countries = new Map<string, CountryRow>();
  let covered = 0;
  for (const row of perIp) {
    const tx = Number(row.tx);
    const rx = Number(row.rx);
    const bytes = pick(dir, tx, rx);
    covered += bytes;
    const c = classify(row.ip, o.lookup);
    if (c.local) {
      addTo(local, tx, rx, bytes);
      continue;
    }
    if (!c.geo) {
      addTo(unmatched, tx, rx, bytes);
      continue;
    }
    const g = c.geo;
    let a = asns.get(g.asn);
    if (!a) asns.set(g.asn, (a = { asn: g.asn, org: g.org, country: g.cc, ...zero(), byCc: new Map() }));
    addTo(a, tx, rx, bytes);
    a.byCc.set(g.cc, (a.byCc.get(g.cc) ?? 0) + bytes);
    if (g.cc) {
      let ct = countries.get(g.cc);
      if (!ct) countries.set(g.cc, (ct = { country: g.cc, ...zero() }));
      addTo(ct, tx, rx, bytes);
    }
  }
  const asnRows: AsnRow[] = [...asns.values()].map(({ byCc, ...a }) => {
    let best = '';
    let most = -1;
    for (const [cc, b] of byCc) if (b > most || (b === most && cc < best)) [best, most] = [cc, b];
    return { ...a, country: best };
  });
  asnRows.sort((a, b) => b.bytes - a.bytes || a.asn - b.asn);
  const countryRows = [...countries.values()].sort((a, b) => b.bytes - a.bytes || (a.country < b.country ? -1 : 1));
  const tTx = Number(totals?.tx ?? 0);
  const tRx = Number(totals?.rx ?? 0);
  return {
    base: {
      from: o.r.from,
      to: o.r.to,
      table: o.r.table,
      dir,
      geo: o.lookup !== null,
      coverage: { ips: perIp.length, totalIps: Math.max(perIp.length, Number(totals?.ips ?? 0)), bytes: covered, totalBytes: Math.max(covered, pick(dir, tTx, tRx)) },
      local,
      unmatched,
    },
    asns: asnRows,
    countries: countryRows,
  };
}

// ---------------------------------------------------------------------------
// The destination table

export interface DestQueryRow {
  ip: string;
  rport: number;
  tx: string | number;
  rx: string | number;
  app: string;
  proto: string;
  procs: string | number;
  names: string[];
}

/**
 * Per (ip, port): bytes, the app and proto with the most bytes, the process
 * instances and up to 5 names; the largest `limit` by `dir`.
 */
export function destinationsQuery(r: Range, dir: GeoDir, filters: Filters, limit = GEO_IP_LIMIT) {
  const time = timeFilter(r);
  const f = filterSql(filters);
  const src = flowSource(r.table, time, filters.uid !== undefined);
  return {
    sql: `SELECT ${DISPLAY_IP} AS ip, rport, sum(ptx) AS tx, sum(prx) AS rx,
                 argMax(app, ptx + prx) AS app, argMax(proto, ptx + prx) AS proto,
                 length(arrayDistinct(arrayFlatten(groupArray(ids)))) AS procs,
                 arraySlice(arrayDistinct(arrayFlatten(groupArray(nms))), 1, 5) AS names
          FROM (
            SELECT raddr, rport, app, proto, sum(tx_bytes) AS ptx, sum(rx_bytes) AS prx,
                   groupUniqArray(concat(toString(pid), ':', toString(proc_start))) AS ids,
                   groupUniqArray(name) AS nms
            FROM ${src} WHERE ${time}${f.sql}
            GROUP BY raddr, rport, app, proto
          )
          GROUP BY raddr, rport
          HAVING ${rankSql(dir)} > 0
          ORDER BY ${rankSql(dir)} DESC, ip, rport
          LIMIT {limit:UInt32}`,
    params: { ...rangeParams(r), ...f.params, limit },
  };
}

/** Which rows the table keeps: an ASN, a country, or a scope. */
export interface DestSelection {
  asn?: number;
  cc?: string;
  scope: DestScope;
}

export function parseDestSelection(q: Record<string, string | undefined>): DestSelection {
  const sel: DestSelection = { scope: 'all' };
  if (q.asn !== undefined && q.asn !== '') {
    const n = /^\d{1,10}$/.test(q.asn) ? Number(q.asn) : NaN;
    if (!(n > 0 && n < 2 ** 32)) throw badRequest('asn: expected an AS number');
    sel.asn = n;
  }
  if (q.cc !== undefined && q.cc !== '') {
    if (!/^[A-Z]{2}$/.test(q.cc)) throw badRequest('cc: expected an ISO 3166 alpha-2 code');
    sel.cc = q.cc;
  }
  const s = q.scope;
  if (s !== undefined && s !== '') {
    if (s !== 'all' && s !== 'public' && s !== 'local' && s !== 'unmatched') throw badRequest('scope: expected all, public, local or unmatched');
    sel.scope = s;
  }
  return sel;
}

export function buildDestinations(rows: readonly DestQueryRow[], sel: DestSelection, lookup: Lookup | null, limit: number): { rows: DestRow[]; matched: number } {
  const out: DestRow[] = [];
  let matched = 0;
  for (const row of rows) {
    const c = classify(row.ip, lookup);
    if (sel.asn !== undefined && c.geo?.asn !== sel.asn) continue;
    if (sel.cc !== undefined && c.geo?.cc !== sel.cc) continue;
    if (sel.scope === 'public' && c.local) continue;
    if (sel.scope === 'local' && !c.local) continue;
    if (sel.scope === 'unmatched' && (c.local || c.geo)) continue;
    matched++;
    if (out.length >= limit) continue;
    const port = Number(row.rport);
    out.push({
      ip: row.ip,
      port,
      dest: destText(row.ip, port),
      ...(c.geo && { geo: c.geo }),
      local: c.local,
      app: row.app,
      proto: row.proto,
      tx: Number(row.tx),
      rx: Number(row.rx),
      procs: Number(row.procs),
      names: row.names,
    });
  }
  return { rows: out, matched };
}
