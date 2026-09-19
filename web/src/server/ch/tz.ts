import type { FastifyBaseLogger } from 'fastify';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import { badRequest } from '../http-error.ts';
import { chQuery } from './query.ts';

const known = new Map<string, boolean>();

/**
 * Validates an IANA timezone name (the browser's
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`) against the zones this
 * ClickHouse server knows, for `toHour(minute, {tz:String})` and friends.
 * Missing means UTC. Answers are cached for the life of the process.
 */
export async function parseTz(ch: ClickHouseClient, log: FastifyBaseLogger, raw: unknown): Promise<string> {
  if (raw === undefined || raw === '') return 'UTC';
  if (typeof raw !== 'string' || raw.length > 64) throw badRequest('tz: expected an IANA timezone name');
  let ok = known.get(raw);
  if (ok === undefined) {
    const [row] = await chQuery<{ n: number }>(ch, log, 'SELECT count() > 0 AS n FROM system.time_zones WHERE time_zone = {tz:String}', { tz: raw });
    ok = Boolean(row?.n);
    // Only valid names are remembered, so junk input cannot grow the cache.
    if (ok) known.set(raw, true);
  }
  if (!ok) throw badRequest(`tz: unknown timezone "${raw}"`);
  return raw;
}
