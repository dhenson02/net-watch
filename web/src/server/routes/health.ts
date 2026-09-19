import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../../shared/api.ts';
import { config } from '../config.ts';
import { clickhouseStatus, type ClickHouseClient } from '../db/clickhouse.ts';
import { redisStatus, type Redis } from '../db/redis.ts';

export function healthRoutes(app: FastifyInstance, deps: { redis: Redis; clickhouse: ClickHouseClient }) {
  // Polled every few seconds by the UI, so it is not request-logged.
  // Always 200 while the API itself is up; backend state is in the body.
  app.get('/api/health', { logLevel: 'warn' }, async (): Promise<HealthResponse> => {
    const [redis, clickhouse] = await Promise.all([
      redisStatus(deps.redis, config.redisUrl),
      clickhouseStatus(deps.clickhouse, config.clickhouse.url),
    ]);
    return {
      serverTimeMs: Date.now(),
      uptimeS: Math.round(process.uptime()),
      redis,
      clickhouse,
    };
  });
}
