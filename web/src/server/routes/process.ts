import type { FastifyInstance } from 'fastify';
import type { ProcessInfo } from '../../shared/api.ts';
import { chQuery, clientGone } from '../ch/query.ts';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import { badRequest, HttpError } from '../http-error.ts';

const U64_MAX = 2n ** 64n - 1n;

type ProcessParams = { Params: { pid: string; start: string } };

/** Validates `:pid/:start`. `start` (ns since boot, u64) stays a string. */
function parseId(params: { pid: string; start: string }): { pid: number; start: string } {
  const { pid, start } = params;
  if (!/^\d{1,10}$/.test(pid) || Number(pid) > 0xffffffff) throw badRequest('pid: expected a u32');
  if (!/^\d{1,20}$/.test(start) || BigInt(start) > U64_MAX) throw badRequest('start: expected a u64');
  return { pid: Number(pid), start: BigInt(start).toString() };
}

export function processRoutes(app: FastifyInstance, deps: { clickhouse: ClickHouseClient }) {
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
}
