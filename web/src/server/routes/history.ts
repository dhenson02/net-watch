import type { FastifyInstance } from 'fastify';
import type { HistoryFlowsResponse, HistoryIngest, HistorySummary } from '../../shared/api.ts';
import { chQuery, clientGone } from '../ch/query.ts';
import { parseRange, rangeInfo, rangeParams, timeFilter } from '../ch/range.ts';
import { DEST_FILTER, DISPLAY_IP, parseDest } from '../ch/sql.ts';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import { badRequest } from '../http-error.ts';

type RangeQuery = { Querystring: Record<string, string | undefined> };

const MAX_FLOW_ROWS = 2000;

/** An optional integer query parameter in `min..max`. */
function intInRange(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= min && n <= max)) throw badRequest(`${name}: expected an integer in ${min}..${max}`);
  return n;
}

export function historyRoutes(app: FastifyInstance, deps: { clickhouse: ClickHouseClient }) {
  const ch = deps.clickhouse;

  /** Payload totals over a range; the History page header. */
  app.get<RangeQuery>('/api/history/summary', async (req, reply): Promise<HistorySummary> => {
    const r = parseRange(req.query);
    // `r.table` comes from a fixed whitelist in parseRange, never from input.
    const [row] = await chQuery<{ tx: string; rx: string; n: string }>(
      ch,
      req.log,
      `SELECT sum(tx_bytes) AS tx, sum(rx_bytes) AS rx, uniqExact(pid, proc_start) AS n
       FROM ${r.table} WHERE ${timeFilter(r)}`,
      rangeParams(r),
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
    const dest = parseDest(req.query.dest);
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
         FROM ${r.table}
         WHERE ${time}${dest ? ` AND ${DEST_FILTER}` : ''}
         GROUP BY name, proto, app, raddr, rport, pid, proc_start
       )
       GROUP BY name, proto, app, raddr, rport
       HAVING tx + rx > 0
       ORDER BY tx + rx DESC, name, app, ip, rport
       LIMIT {limit:UInt32}`,
      { ...rangeParams(r), ...dest, limit: limit + 1 },
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
