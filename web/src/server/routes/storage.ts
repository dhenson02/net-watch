import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { StorageBreakdownResponse, StorageDeleteRequest, StorageDeleteResponse, StorageResponse } from '../../shared/api.ts';
import { config } from '../config.ts';
import { clientGone } from '../ch/query.ts';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import type { Redis } from '../db/redis.ts';
import { HttpError, badRequest } from '../http-error.ts';
import { clickhouseBreakdown, clickhouseStorage, clickhouseTimezone as chTimezone, dropPartitions } from '../storage/clickhouse.ts';
import { deleteEndedDays, redisStorage } from '../storage/redis.ts';

const MAX_KEYS = 400;
/** Wrong passwords tolerated per window before every attempt is refused until it ends. */
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60_000;

/** An IANA timezone name the runtime knows, or a 400. */
function timezoneParam(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) throw badRequest('tz: required');
  try {
    new Intl.DateTimeFormat('en', { timeZone: raw });
  } catch {
    throw badRequest('tz: unknown timezone');
  }
  return raw;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time comparison (hashing first makes the lengths equal). */
export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

const errMsg = (err: unknown) => (err instanceof HttpError ? err.message : (err as Error).message);

export function storageRoutes(
  app: FastifyInstance,
  deps: { redis: Redis; clickhouse: ClickHouseClient; clickhouseAdmin: ClickHouseClient },
) {
  const db = config.clickhouse.database;
  let fails: number[] = [];

  /** Sizes of both stores. A store that is down reports its own error. */
  app.get<{ Querystring: { tz?: string } }>('/api/storage', async (req, reply): Promise<StorageResponse> => {
    const signal = clientGone(reply);
    const timezone = timezoneParam(req.query.tz);
    let clickhouseTimezone = 'UTC';
    let clickhouse: StorageResponse['clickhouse'] = null;
    let clickhouseError: string | null = null;
    try {
      clickhouseTimezone = await chTimezone(deps.clickhouse, req.log, signal);
      clickhouse = await clickhouseStorage(deps.clickhouse, req.log, db, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      clickhouseError = errMsg(err);
    }
    let redis: StorageResponse['redis'] = null;
    let redisError: string | null = null;
    try {
      if (!deps.redis.isReady) throw new Error('not connected');
      redis = await redisStorage(deps.redis, timezone, req.log);
    } catch (err) {
      redisError = errMsg(err);
    }
    return { deleteEnabled: config.storageAdminPassword !== '', timezone, clickhouseTimezone, clickhouse, clickhouseError, redis, redisError };
  });

  /** A ClickHouse partition split by hour (or a flows_1m month by day), sizes estimated. */
  app.get<{ Querystring: { table?: string; key?: string; tz?: string } }>('/api/storage/breakdown', async (req, reply): Promise<StorageBreakdownResponse> => {
    const { table = '', key = '' } = req.query;
    const tz = timezoneParam(req.query.tz);
    return { rows: await clickhouseBreakdown(deps.clickhouse, req.log, db, table, key, tz, clientGone(reply)) };
  });

  /**
   * Deletes stored data after checking `STORAGE_ADMIN_PASSWORD`: partitions of
   * `flows` / `flows_1m`, or the ended Redis processes of some days.
   */
  app.post<{ Body: StorageDeleteRequest }>('/api/storage/delete', async (req): Promise<StorageDeleteResponse> => {
    if (!config.storageAdminPassword) throw new HttpError(403, 'deleting is disabled: STORAGE_ADMIN_PASSWORD is not set on the server');
    const { store, table, keys, password } = req.body ?? ({} as Partial<StorageDeleteRequest>);

    const now = Date.now();
    fails = fails.filter((t) => now - t < FAIL_WINDOW_MS);
    if (fails.length >= MAX_FAILS) throw new HttpError(429, 'too many wrong passwords; wait a minute');
    if (typeof password !== 'string' || !passwordMatches(password, config.storageAdminPassword)) {
      fails.push(now);
      req.log.warn({ store }, 'storage: delete refused, wrong password');
      throw new HttpError(403, 'wrong password');
    }

    if (store !== 'clickhouse' && store !== 'redis') throw badRequest('store: clickhouse or redis');
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS || keys.some((k) => typeof k !== 'string')) {
      throw badRequest(`keys: 1 to ${MAX_KEYS} strings`);
    }
    const unique = [...new Set(keys)];

    if (store === 'clickhouse') {
      if (typeof table !== 'string') throw badRequest('table: required');
      const deleted = await dropPartitions(deps.clickhouse, deps.clickhouseAdmin, req.log, db, table, unique);
      return { deleted, aofRewrite: false };
    }
    if (unique.some((k) => !/^\d{4}-\d{2}-\d{2}$/.test(k))) throw badRequest('keys: days as YYYY-MM-DD');
    if (!deps.redis.isReady) throw new HttpError(502, 'Redis: not connected');
    const tz = timezoneParam(req.body.tz);
    return deleteEndedDays(deps.redis, tz, unique, req.log);
  });
}
