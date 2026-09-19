import type { FastifyInstance } from 'fastify';
import { BEACON_DEST_LIMIT, BEACON_MAX_SPAN_MS, type BeaconsResponse, type BytesPerCallResponse, type ProcessCallsResponse, type ProcessInfo } from '../../shared/api.ts';
import { beaconsQuery, buildBeacons, capSpan, lifetimeRange, type BeaconRow } from '../ch/beacons.ts';
import { buildBytesPerCall, bytesPerCallQuery, parseBpcBy, parseBpcDir, type BytesPerCallQueryRow } from '../ch/bytesPerCall.ts';
import { buildProcessCalls, processCallsQuery, rawRange, type ProcessCallsRow } from '../ch/calls.ts';
import { chQuery, clientGone } from '../ch/query.ts';
import { parseRange } from '../ch/range.ts';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import type { GeoDb } from '../geo/asn.ts';
import { badRequest, HttpError } from '../http-error.ts';

const U64_MAX = 2n ** 64n - 1n;

type ProcessParams = { Params: { pid: string; start: string } };
type ProcessRangeParams = ProcessParams & { Querystring: Record<string, string | undefined> };

/** Validates `:pid/:start`. `start` (ns since boot, u64) stays a string. */
function parseId(params: { pid: string; start: string }): { pid: number; start: string } {
  const { pid, start } = params;
  if (!/^\d{1,10}$/.test(pid) || Number(pid) > 0xffffffff) throw badRequest('pid: expected a u32');
  if (!/^\d{1,20}$/.test(start) || BigInt(start) > U64_MAX) throw badRequest('start: expected a u64');
  return { pid: Number(pid), start: BigInt(start).toString() };
}

export function processRoutes(app: FastifyInstance, deps: { clickhouse: ClickHouseClient; geo: GeoDb }) {
  const ch = deps.clickhouse;

  /** One process instance; the Process page header. */
  app.get<ProcessParams>('/api/process/:pid/:start', async (req, reply): Promise<ProcessInfo> => {
    const id = parseId(req.params);
    // Timestamps and totals are 64-bit and arrive as strings.
    type Row = Omit<ProcessInfo, 'start_ms' | 'first_seen_ms' | 'last_seen_ms' | 'ended_ms' | 'tx_total' | 'rx_total'> & {
      start_ms: string;
      first_seen_ms: string;
      last_seen_ms: string;
      ended_ms: string | null;
      tx_total: string;
      rx_total: string;
    };
    const [row] = await chQuery<Row>(
      ch,
      req.log,
      `SELECT pid, toString(proc_start) AS start_ns, name, cmdline, uid,
              toUnixTimestamp64Milli(start_ms) AS start_ms,
              toUnixTimestamp64Milli(first_seen) AS first_seen_ms,
              toUnixTimestamp64Milli(last_seen) AS last_seen_ms,
              toUnixTimestamp64Milli(ended) AS ended_ms,
              tx_total, rx_total
       FROM processes FINAL
       WHERE pid = {pid:UInt32} AND proc_start = {start:UInt64}`,
      id,
      clientGone(reply),
    );
    if (!row) throw new HttpError(404, 'no such process');
    return {
      ...row,
      start_ms: Number(row.start_ms),
      first_seen_ms: Number(row.first_seen_ms),
      last_seen_ms: Number(row.last_seen_ms),
      ended_ms: row.ended_ms === null ? null : Number(row.ended_ms),
      tx_total: Number(row.tx_total),
      rx_total: Number(row.rx_total),
    };
  });

  /**
   * Bytes vs calls (14) of one instance over `from`/`to` (ms, default: the
   * last hour) in buckets of `step` (s, raised to at most ~1500 buckets):
   * kbps and calls per second, from raw `flows` whatever the span, since its
   * key starts with (pid, proc_start). Zero-filled; no 404 for an unknown id.
   */
  app.get<ProcessRangeParams>('/api/process/:pid/:start/calls', async (req, reply): Promise<ProcessCallsResponse> => {
    const id = parseId(req.params);
    const r = rawRange(parseRange(req.query));
    const { sql, params } = processCallsQuery(r, id);
    const rows = await chQuery<ProcessCallsRow>(ch, req.log, sql, params, clientGone(reply));
    return buildProcessCalls(rows, r);
  });

  /**
   * Bytes-per-call distribution (10) of one instance over `from`/`to` (ms,
   * default: the last hour), `dir=tx|rx`, per `by=app|name`, from raw `flows`
   * (per-tick means) whatever the span: the same answer as
   * `/api/history/bytes-per-call?pid&start`. No 404 for an unknown id.
   */
  app.get<ProcessRangeParams>('/api/process/:pid/:start/bytes-per-call', async (req, reply): Promise<BytesPerCallResponse> => {
    const instance = parseId(req.params);
    const r = { ...parseRange(req.query), table: 'flows' as const, col: 'ts' as const };
    const dir = parseBpcDir(req.query.dir);
    const by = parseBpcBy(req.query.by);
    const { sql, params } = bytesPerCallQuery({ r, dir, by, filters: {}, instance });
    const rows = await chQuery<BytesPerCallQueryRow>(ch, req.log, sql, params, clientGone(reply));
    return buildBytesPerCall(rows, { from: r.from, to: r.to, table: r.table, dir, by });
  });

  /**
   * Beaconing strip (15): every active tick of this instance per destination
   * (ip, port, proto, app), the 100 with the most ticks, each with its
   * periodicity (period, cv, bursts, score). `from`/`to` (ms) default to the
   * instance's networked lifetime; either way the range is cut to its last
   * 24 h (`capped`). Reads by the primary key. No 404 for an unknown id.
   */
  app.get<ProcessRangeParams>('/api/process/:pid/:start/beacons', async (req, reply): Promise<BeaconsResponse> => {
    const id = parseId(req.params);
    const now = Date.now();
    let base: { from: number; to: number } = parseRange(req.query, now);
    if (!req.query.from && !req.query.to) {
      type Row = { first_seen_ms: string; last_seen_ms: string; ended_ms: string | null };
      const [p] = await chQuery<Row>(
        ch,
        req.log,
        `SELECT toUnixTimestamp64Milli(first_seen) AS first_seen_ms, toUnixTimestamp64Milli(last_seen) AS last_seen_ms,
                toUnixTimestamp64Milli(ended) AS ended_ms
         FROM processes FINAL
         WHERE pid = {pid:UInt32} AND proc_start = {start:UInt64}`,
        id,
        clientGone(reply),
      );
      if (p) {
        const ended = p.ended_ms === null ? null : Number(p.ended_ms);
        base = lifetimeRange({ first_seen_ms: Number(p.first_seen_ms), last_seen_ms: Number(p.last_seen_ms), ended_ms: ended }, now);
      }
    }
    const r = capSpan(base, BEACON_MAX_SPAN_MS.instance);
    const { sql, params } = beaconsQuery({ scope: 'instance', ...id, from: r.from, to: r.to, limit: BEACON_DEST_LIMIT + 1 });
    const rows = await chQuery<BeaconRow>(ch, req.log, sql, params, clientGone(reply));
    const res = buildBeacons(rows, { ...r, scope: 'instance' }, BEACON_DEST_LIMIT);
    deps.geo.enrich(res.dests);
    return res;
  });
}
