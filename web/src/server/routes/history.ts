import type { FastifyInstance } from 'fastify';
import type { HistorySummary } from '../../shared/api.ts';
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
}
