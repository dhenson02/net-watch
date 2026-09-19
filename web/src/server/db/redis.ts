import { createClient } from 'redis';
import type { FastifyBaseLogger } from 'fastify';
import type { BackendStatus } from '../../shared/api.ts';
import { displayTarget } from '../config.ts';
import { withTimeout } from '../timeout.ts';

/**
 * Connects in the background and keeps reconnecting forever, so the API starts
 * (and stays up) while Redis is down. Commands fail fast instead of queueing
 * while disconnected.
 */
export function createRedis(url: string, log: FastifyBaseLogger) {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 3000,
      reconnectStrategy: (retries) => Math.min(250 * 2 ** retries, 5000),
    },
  });

  // Log transitions, not every failed reconnect attempt.
  let up = false;
  client.on('ready', () => {
    up = true;
    log.info({ target: displayTarget(url) }, 'redis connected');
  });
  client.on('error', (err: Error) => {
    if (up) log.warn({ err: err.message }, 'redis connection lost');
    up = false;
  });

  client.connect().catch((err: Error) => log.error({ err: err.message }, 'redis connect gave up'));
  return client;
}

export type Redis = ReturnType<typeof createRedis>;

export async function redisStatus(client: Redis, url: string): Promise<BackendStatus> {
  const status: BackendStatus = { ok: false, target: displayTarget(url), latencyMs: null, version: null, error: null };
  if (!client.isReady) {
    status.error = 'not connected';
    return status;
  }
  try {
    const start = performance.now();
    const info = await withTimeout(client.info('server'), 2000, 'redis INFO');
    status.latencyMs = Math.round((performance.now() - start) * 10) / 10;
    status.version = /^redis_version:(.+)$/m.exec(info)?.[1]?.trim() ?? null;
    status.ok = true;
  } catch (err) {
    status.error = (err as Error).message;
  }
  return status;
}
