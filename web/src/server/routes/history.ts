import type { FastifyInstance } from 'fastify';
import type { HistoryIngest, HistorySummary } from '../../shared/api.ts';
import { chQuery, clientGone } from '../ch/query.ts';
import { parseRange, rangeInfo, rangeParams, timeFilter } from '../ch/range.ts';
import type { ClickHouseClient } from '../db/clickhouse.ts';

type RangeQuery = { Querystring: Record<string, string | undefined> };

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
