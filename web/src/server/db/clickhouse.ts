import { ClickHouseLogLevel, createClient, type ClickHouseClient } from '@clickhouse/client';
import type { BackendStatus } from '../../shared/api.ts';
import { config, displayTarget } from '../config.ts';

export type { ClickHouseClient };

export function createClickHouse(cfg: typeof config.clickhouse): ClickHouseClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: cfg.database,
    request_timeout: 30_000,
    // Failures reach callers as rejected promises; the client's own logger
    // would print a multi-line stack for each one.
    log: { level: ClickHouseLogLevel.OFF },
    compression: { response: true },
    clickhouse_settings: {
      // The dashboard only reads. readonly=2 still allows per-query settings.
      readonly: '2',
    },
  });
}

export async function clickhouseStatus(client: ClickHouseClient, url: string): Promise<BackendStatus> {
  const status: BackendStatus = { ok: false, target: displayTarget(url), latencyMs: null, version: null, error: null };
  try {
    // A real query rather than ping(): /ping does not check credentials.
    const start = performance.now();
    const rs = await client.query({
      query: 'SELECT version() AS v',
      format: 'JSONEachRow',
      abort_signal: AbortSignal.timeout(2000),
    });
    const [row] = await rs.json<{ v: string }>();
    status.latencyMs = Math.round((performance.now() - start) * 10) / 10;
    status.version = row?.v ?? null;
    status.ok = true;
  } catch (err) {
    status.error = (err as Error).message;
  }
  return status;
}
