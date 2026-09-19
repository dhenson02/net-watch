import type { FastifyInstance } from 'fastify';
import type { HistoryFlowsResponse, HistoryIngest, HistorySummary, LifecycleResponse, ScatterResponse, ThroughputResponse } from '../../shared/api.ts';
import { LIFECYCLE_LIMIT_DEFAULT, LIFECYCLE_LIMIT_MAX, lifecycleQuery, parseNames, toLifecycleProc, type LifecycleRow } from '../ch/lifecycle.ts';
import { chQuery, clientGone } from '../ch/query.ts';
import { parseRange, rangeInfo, rangeParams, timeFilter } from '../ch/range.ts';
import {
  parseBasis,
  parseGroup,
  SCATTER_LIMIT_DEFAULT,
  SCATTER_LIMIT_MAX,
  scatterQuery,
  toScatterPoint,
  type ScatterRow,
} from '../ch/scatter.ts';
import { DISPLAY_IP, filterSql, flowSource, parseBy, parseFilters, UNKNOWN_UID } from '../ch/sql.ts';
import { alignRange, buildThroughput, parseDir, throughputQuery, type ThroughputRow } from '../ch/throughput.ts';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import { badRequest } from '../http-error.ts';
import type { Users } from '../users.ts';

type RangeQuery = { Querystring: Record<string, string | undefined> };

const MAX_FLOW_ROWS = 2000;

/** An optional integer query parameter in `min..max`. */
function intInRange(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= min && n <= max)) throw badRequest(`${name}: expected an integer in ${min}..${max}`);
  return n;
}

export function historyRoutes(app: FastifyInstance, deps: { clickhouse: ClickHouseClient; users: Users }) {
  const { clickhouse: ch, users } = deps;

  /** Payload totals over a range, with the page's filters; the History page header. */
  app.get<RangeQuery>('/api/history/summary', async (req, reply): Promise<HistorySummary> => {
    const r = parseRange(req.query);
    const filters = parseFilters(req.query);
    const f = filterSql(filters);
    const time = timeFilter(r);
    // `r.table` comes from a fixed whitelist in parseRange, never from input.
    const src = flowSource(r.table, time, filters.uid !== undefined);
    const [row] = await chQuery<{ tx: string; rx: string; n: string }>(
      ch,
      req.log,
      `SELECT sum(tx_bytes) AS tx, sum(rx_bytes) AS rx, uniqExact(pid, proc_start) AS n
       FROM ${src} WHERE ${time}${f.sql}`,
      { ...rangeParams(r), ...f.params },
      clientGone(reply),
    );
    return { range: rangeInfo(r), txBytes: Number(row?.tx ?? 0), rxBytes: Number(row?.rx ?? 0), processes: Number(row?.n ?? 0) };
  });

  /**
   * Bytes per (process name, proto, app, destination) over a range, largest
   * first; the History page's Sankey. `id` is the instance of the name with
   * the most traffic to that destination, for click-through.
   */
  app.get<RangeQuery>('/api/history/flows', async (req, reply): Promise<HistoryFlowsResponse> => {
    const r = parseRange(req.query);
    const limit = intInRange(req.query.limit, 'limit', 300, 1, MAX_FLOW_ROWS);
    const filters = parseFilters(req.query);
    const f = filterSql(filters);
    // Raw flows up to 2 h (exact edges); beyond that the rollup, including the
    // minute `from` falls in. Both fragments are constants.
    const time =
      r.table === 'flows'
        ? timeFilter(r)
        : 'minute >= toStartOfMinute(fromUnixTimestamp64Milli({from:Int64})) AND minute < fromUnixTimestamp64Milli({to:Int64})';
    type Row = { name: string; proto: string; app: string; ip: string; rport: number; tx: string; rx: string; id: string };
    const rows = await chQuery<Row>(
      ch,
      req.log,
      `SELECT name, proto, app, ${DISPLAY_IP} AS ip, rport,
              sum(itx) AS tx, sum(irx) AS rx, argMax(iid, itx + irx) AS id
       FROM (
         SELECT name, proto, app, raddr, rport,
                concat(toString(pid), ':', toString(proc_start)) AS iid,
                sum(tx_bytes) AS itx, sum(rx_bytes) AS irx
         FROM ${flowSource(r.table, time, filters.uid !== undefined)}
         WHERE ${time}${f.sql}
         GROUP BY name, proto, app, raddr, rport, pid, proc_start
       )
       GROUP BY name, proto, app, raddr, rport
       HAVING tx + rx > 0
       ORDER BY tx + rx DESC, name, app, ip, rport
       LIMIT {limit:UInt32}`,
      { ...rangeParams(r), ...f.params, limit: limit + 1 },
      clientGone(reply),
    );
    const truncated = rows.length > limit;
    return {
      range: rangeInfo(r),
      flows: rows.slice(0, limit).map((row) => ({ ...row, tx: Number(row.tx), rx: Number(row.rx) })),
      truncated,
    };
  });

  /**
   * Throughput over a range stacked by one dimension (05): kbps per bucket for
   * the top N keys plus the rest, zero-padded. `from` is rounded down to a
   * bucket start. Filters: name, app, proto, uid, dest (exact).
   */
  app.get<RangeQuery>('/api/history/throughput', async (req, reply): Promise<ThroughputResponse> => {
    const r = alignRange(parseRange(req.query));
    const by = parseBy(req.query.by);
    const dir = parseDir(req.query.dir);
    const top = intInRange(req.query.top, 'top', 8, 5, 20);
    const { sql, params } = throughputQuery(r, by, dir, top, parseFilters(req.query));
    const rows = await chQuery<ThroughputRow>(ch, req.log, sql, params, clientGone(reply));
    const labels: Record<string, string> = {};
    if (by === 'uid') {
      for (const { key } of rows) {
        if (!/^\d+$/.test(key) || key in labels) continue;
        const uid = Number(key);
        const user = uid === UNKNOWN_UID ? 'unknown uid' : users.name(uid);
        if (user) labels[key] = uid === UNKNOWN_UID ? user : `${user} (${key})`;
      }
    }
    return buildThroughput(rows, r, dir, labels);
  });

  /**
   * Process start/end markers (12): instances whose first network I/O or end
   * lies in the range, largest lifetime total first. Optional `names`
   * (comma-separated) and `uid` narrow it; `limit` 1..1000 (default 200).
   */
  app.get<RangeQuery>('/api/history/lifecycle', async (req, reply): Promise<LifecycleResponse> => {
    const { from, to } = parseRange(req.query);
    const limit = intInRange(req.query.limit, 'limit', LIFECYCLE_LIMIT_DEFAULT, 1, LIFECYCLE_LIMIT_MAX);
    const names = parseNames(req.query.names);
    const { uid } = parseFilters({ uid: req.query.uid });
    const { sql, params } = lifecycleQuery({ from, to, limit: limit + 1, names, uid });
    const rows = await chQuery<LifecycleRow>(ch, req.log, sql, params, clientGone(reply));
    return { from, to, procs: rows.slice(0, limit).map(toLifecycleProc), truncated: rows.length > limit };
  });

  /**
   * tx vs rx scatter (08): per process instance (`group=instance`) or name,
   * lifetime totals of the processes whose lifetime overlaps the range
   * (`basis=lifetime`) or bytes within the range (`basis=range`), largest
   * first; `limit` 1..5000 (default 2000). The page's filters keep the
   * processes with matching traffic in the range.
   */
  app.get<RangeQuery>('/api/history/scatter', async (req, reply): Promise<ScatterResponse> => {
    const range = parseRange(req.query);
    const group = parseGroup(req.query.group);
    const basis = parseBasis(req.query.basis);
    const limit = intInRange(req.query.limit, 'limit', SCATTER_LIMIT_DEFAULT, 1, SCATTER_LIMIT_MAX);
    const { sql, params } = scatterQuery({ range, group, basis, filters: parseFilters(req.query), limit: limit + 1 });
    const rows = await chQuery<ScatterRow>(ch, req.log, sql, params, clientGone(reply));
    return {
      from: range.from,
      to: range.to,
      group,
      basis,
      table: range.table,
      points: rows.slice(0, limit).map((r) => toScatterPoint(r, (uid) => users.name(uid))),
      truncated: rows.length > limit,
    };
  });

  /**
   * Whether the collector's ClickHouse sink is keeping up (it buffers while
   * ClickHouse is down). Touches only today's partition and the ts minmax
   * index. Polled every 5 s by the health strip, so it is not request-logged.
   */
  app.get('/api/history/ingest', { logLevel: 'warn' }, async (req, reply): Promise<HistoryIngest> => {
    const [row] = await chQuery<{ last_ts: string; rows_1m: string }>(
      ch,
      req.log,
      `SELECT toUnixTimestamp64Milli(max(ts)) AS last_ts, countIf(ts > now() - INTERVAL 1 MINUTE) AS rows_1m
       FROM flows
       WHERE ts > now() - INTERVAL 10 MINUTE`,
      {},
      clientGone(reply),
    );
    // max() over no rows is the epoch, not NULL.
    const last = Number(row?.last_ts ?? 0);
    return { serverTimeMs: Date.now(), lastTsMs: last > 0 ? last : null, rows1m: Number(row?.rows_1m ?? 0) };
  });
}
