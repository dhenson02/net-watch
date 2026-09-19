import type { FastifyInstance } from 'fastify';
import {
  type BurstResponse,
  type BytesPerCallResponse,
  COMPARE_OFFSET_MS,
  HEATMAP_CELLS,
  type HistoryFlowsResponse,
  type HistoryIngest,
  type HeatmapResponse,
  type HistorySummary,
  type LifecycleResponse,
  type LifetimesResponse,
  type ScatterResponse,
  type ThroughputResponse,
  type TreemapResponse,
} from '../../shared/api.ts';
import { rawRange } from '../ch/calls.ts';
import { buildBurst, burstQuery, burstSpanOk, parseBurstDir, type BurstRow } from '../ch/burst.ts';
import { buildBytesPerCall, bytesPerCallQuery, parseBpcBy, parseBpcDir, parseInstance, type BytesPerCallQueryRow } from '../ch/bytesPerCall.ts';
import { buildHeatmap, heatmapQuery, parseHeatRange, parseMetric, parseSplit, sampleCounts, type HeatmapRow } from '../ch/heatmap.ts';
import { LIFECYCLE_LIMIT_DEFAULT, LIFECYCLE_LIMIT_MAX, lifecycleQuery, parseNames, toLifecycleProc, type LifecycleRow } from '../ch/lifecycle.ts';
import { LIFETIMES_LIMIT_DEFAULT, LIFETIMES_LIMIT_MAX, lifetimesQuery, toLifetimeBar, type LifetimeRow } from '../ch/lifetimes.ts';
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
import {
  alignRange,
  buildCompare,
  buildThroughput,
  compareQuery,
  FIRST_MINUTE_SQL,
  parseCompare,
  buildUnknown,
  buildCalls,
  callsQuery,
  parseCalls,
  parseDir,
  parseUnknown,
  throughputQuery,
  unknownQuery,
  type CallsRow,
  type CompareRow,
  type ThroughputRow,
  type UnknownRow,
} from '../ch/throughput.ts';
import { buildTreemap, parseTreemapDir, TREEMAP_MAX_ROWS, TREEMAP_TOP, treemapQuery, type TreemapRow } from '../ch/treemap.ts';
import { parseTz } from '../ch/tz.ts';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import { badRequest, HttpError } from '../http-error.ts';
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
   * bucket start. Filters: name, app, proto, uid, dest (exact). `compare=1d|1w`
   * adds the same window that long before, totals only (11). `unknown=1`
   * adds the share of bytes the classifier labelled unknown, per bucket (16).
   * `calls=1` adds send/receive calls per second, totals only (14).
   */
  app.get<RangeQuery>('/api/history/throughput', async (req, reply): Promise<ThroughputResponse> => {
    const r = alignRange(parseRange(req.query));
    const by = parseBy(req.query.by);
    const dir = parseDir(req.query.dir);
    const top = intInRange(req.query.top, 'top', 8, 5, 20);
    const compare = parseCompare(req.query.compare);
    const filters = parseFilters(req.query);
    const { sql, params } = throughputQuery(r, by, dir, top, filters);
    const gone = clientGone(reply);
    const offset = compare ? COMPARE_OFFSET_MS[compare] : 0;
    const ghost = offset ? compareQuery(r, offset, filters) : null;
    // The ghost (11) runs alongside: totals of the earlier window, and the
    // table's first minute, to tell "no data back then" from "no traffic".
    // 16: unknown vs all bytes over the same buckets.
    const unk = parseUnknown(req.query.unknown) ? unknownQuery(r, filters) : null;
    // 14: calls over the same buckets, totals only.
    const calls = parseCalls(req.query.calls) ? callsQuery(r, filters) : null;
    const [rows, ghostRows, first, unkRows, callRows] = await Promise.all([
      chQuery<ThroughputRow>(ch, req.log, sql, params, gone),
      ghost && chQuery<CompareRow>(ch, req.log, ghost.sql, ghost.params, gone),
      ghost && chQuery<{ first: number }>(ch, req.log, FIRST_MINUTE_SQL, {}, gone),
      unk && chQuery<UnknownRow>(ch, req.log, unk.sql, unk.params, gone),
      calls && chQuery<CallsRow>(ch, req.log, calls.sql, calls.params, gone),
    ]);
    const labels: Record<string, string> = {};
    if (by === 'uid') {
      for (const { key } of rows) {
        if (!/^\d+$/.test(key) || key in labels) continue;
        const uid = Number(key);
        const user = uid === UNKNOWN_UID ? 'unknown uid' : users.name(uid);
        if (user) labels[key] = uid === UNKNOWN_UID ? user : `${user} (${key})`;
      }
    }
    const out = buildThroughput(rows, r, dir, labels);
    if (ghostRows && first) out.compare = buildCompare(ghostRows, r, offset, first[0] ? Number(first[0].first) * 1000 : null);
    if (unkRows) out.unknown = buildUnknown(unkRows, r);
    if (callRows) out.calls = buildCalls(callRows, r);
    return out;
  });

  /**
   * Peak vs average band (13): per bucket of the throughput chart's range and
   * step, the mean kbps over the whole bucket and the p95 and max of the
   * per-tick kbps (idle ticks count as 0), from raw `flows` whatever the span.
   * `dir=total|tx|rx`, or `both` for tx and rx in one scan. Over all processes
   * the range is limited to 24 h (the scan is by time); `pid` + `start` read
   * one instance by the primary key, any range. The page's filters apply. A
   * query over the time limit is a 504 that suggests a shorter range.
   */
  app.get<RangeQuery>('/api/history/burst', async (req, reply): Promise<BurstResponse> => {
    const parsed = parseRange(req.query);
    const dir = parseBurstDir(req.query.dir);
    const instance = parseInstance(req.query);
    if (!instance && !burstSpanOk(parsed.from, parsed.to)) throw badRequest('band needs ≤ 24 h range');
    // The throughput answer's buckets for the same range, but always raw rows.
    const r = rawRange(parsed);
    const { sql, params } = burstQuery({ r, dir, filters: parseFilters(req.query), instance });
    try {
      const rows = await chQuery<BurstRow>(ch, req.log, sql, params, clientGone(reply));
      return buildBurst(rows, r, dir);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 504) throw new HttpError(504, 'The burst band query timed out; pick a shorter range');
      throw err;
    }
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
   * Process lifetimes (09): instances whose lifetime overlaps the range, latest
   * start first; the Gantt on the History and Process pages. Optional `name`
   * and `uid` (exact) narrow it; `limit` 1..2000 (default 500).
   */
  app.get<RangeQuery>('/api/history/lifetimes', async (req, reply): Promise<LifetimesResponse> => {
    const { from, to } = parseRange(req.query);
    const limit = intInRange(req.query.limit, 'limit', LIFETIMES_LIMIT_DEFAULT, 1, LIFETIMES_LIMIT_MAX);
    const { name, uid } = parseFilters({ name: req.query.name, uid: req.query.uid });
    const { sql, params } = lifetimesQuery({ from, to, limit: limit + 1, name, uid });
    const rows = await chQuery<LifetimeRow>(ch, req.log, sql, params, clientGone(reply));
    return { from, to, bars: rows.slice(0, limit).map(toLifetimeBar), truncated: rows.length > limit };
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
   * Hour-of-day × weekday heatmap (06): average kbps per (weekday, hour) in
   * `tz` over the range (default: the last 28 days), from `flows_1m`. A cell
   * is its bytes divided by how often that weekday-hour occurs in the part of
   * the range the rollup covers (counted here, not from the data, so an hour
   * without traffic still counts). `metric=total|tx|rx`; `split=app` gives
   * one grid per top-4 app. The page's filters apply.
   */
  app.get<RangeQuery>('/api/history/heatmap', async (req, reply): Promise<HeatmapResponse> => {
    const { from, to } = parseHeatRange(req.query);
    const metric = parseMetric(req.query.metric);
    const split = parseSplit(req.query.split);
    const filters = parseFilters(req.query);
    const tz = await parseTz(ch, req.log, req.query.tz);
    const gone = clientGone(reply);
    const { sql, params } = heatmapQuery({ from, to, tz, metric, split, filters });
    const [rows, first] = await Promise.all([
      chQuery<HeatmapRow>(ch, req.log, sql, params, gone),
      chQuery<{ first: number }>(ch, req.log, FIRST_MINUTE_SQL, {}, gone),
    ]);
    const firstMs = first[0] ? Number(first[0].first) * 1000 : null;
    const coveredFrom = firstMs === null ? null : Math.max(from, firstMs);
    const start = coveredFrom ?? from;
    const samples = start < to ? sampleCounts(start, to, tz) : new Array<number>(HEATMAP_CELLS).fill(0);
    return buildHeatmap(rows, { from, to, tz, metric, split, coveredFrom }, samples);
  });

  /**
   * uid → process → app treemap (07): bytes per user, process name and app
   * over the range (`dir=total|tx|rx`), nested, largest first; each user keeps
   * its 30 largest processes and folds the rest into `other (N processes)`.
   * Raw flows up to 2 h, else the rollup with uid joined from `processes`.
   * The page's filters apply.
   */
  app.get<RangeQuery>('/api/history/treemap', async (req, reply): Promise<TreemapResponse> => {
    const r = parseRange(req.query);
    const dir = parseTreemapDir(req.query.dir);
    const { sql, params } = treemapQuery(r, dir, parseFilters(req.query), TREEMAP_MAX_ROWS + 1);
    const rows = await chQuery<TreemapRow>(ch, req.log, sql, params, clientGone(reply));
    const truncated = rows.length > TREEMAP_MAX_ROWS;
    const tree = buildTreemap(truncated ? rows.slice(0, TREEMAP_MAX_ROWS) : rows, (uid) => users.name(uid));
    return {
      from: r.from,
      to: r.to,
      table: r.table,
      dir,
      total: tree.reduce((s, u) => s + u.value, 0),
      top: TREEMAP_TOP,
      users: tree,
      truncated,
    };
  });

  /**
   * Bytes-per-call distribution (10): calls per log2 bucket of bytes per call
   * (`dir=tx|rx`), per `by=app|name`, the top 10 by calls plus the folded
   * rest, and the total. Each source row adds its mean weighted by its calls:
   * raw `flows` (per-tick means) up to 2 h, else `flows_1m` (per-minute
   * means). `pid` + `start` narrow it to one instance, always from raw flows.
   * The page's filters apply.
   */
  app.get<RangeQuery>('/api/history/bytes-per-call', async (req, reply): Promise<BytesPerCallResponse> => {
    const parsed = parseRange(req.query);
    const dir = parseBpcDir(req.query.dir);
    const by = parseBpcBy(req.query.by);
    const instance = parseInstance(req.query);
    const r = instance ? { ...parsed, table: 'flows' as const, col: 'ts' as const } : parsed;
    const { sql, params } = bytesPerCallQuery({ r, dir, by, filters: parseFilters(req.query), instance });
    const rows = await chQuery<BytesPerCallQueryRow>(ch, req.log, sql, params, clientGone(reply));
    return buildBytesPerCall(rows, { from: r.from, to: r.to, table: r.table, dir, by });
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
