import type { FastifyBaseLogger, FastifyReply } from 'fastify';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import { HttpError } from '../http-error.ts';

/** Per-query limit; readonly=2 still lets a query set it. */
const MAX_EXECUTION_TIME_S = 20;

/**
 * An AbortSignal that fires when the client goes away before the response is
 * sent (tab closed, navigation), so its ClickHouse query is cancelled.
 *
 * It listens on the response, not the request: since Node 16 the request's
 * 'close' fires as soon as its (empty) body has been read, not on disconnect.
 */
export function clientGone(reply: FastifyReply): AbortSignal {
  const ctrl = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) ctrl.abort();
  });
  return ctrl.signal;
}

/**
 * Runs a read query and returns its rows. User input goes only through
 * `params` (`{name:Type}` placeholders). UInt64/Int64 columns arrive as JSON
 * strings (output_format_json_quote_64bit_integers stays at its default), so
 * type them as `string` or convert sums with Number(). ClickHouse errors become
 * 502s carrying the server's message.
 */
export async function chQuery<T>(
  ch: ClickHouseClient,
  log: FastifyBaseLogger,
  sql: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T[]> {
  const start = performance.now();
  try {
    const rs = await ch.query({
      query: sql,
      format: 'JSONEachRow',
      query_params: params,
      abort_signal: signal,
      clickhouse_settings: {
        max_execution_time: MAX_EXECUTION_TIME_S,
        // Without this, ClickHouse keeps running a SELECT whose HTTP client left.
        cancel_http_readonly_queries_on_client_close: 1,
      },
    });
    const rows = await rs.json<T>();
    log.debug({ ms: Math.round(performance.now() - start), rows: rows.length }, 'clickhouse query');
    return rows;
  } catch (err) {
    // Nobody is waiting for the response; 499 keeps it out of the error log.
    if (signal?.aborted) throw new HttpError(499, 'client closed request');
    const message = (err as Error).message;
    log.warn({ ms: Math.round(performance.now() - start), err: message }, 'clickhouse query failed');
    throw new HttpError(502, `ClickHouse: ${message}`);
  }
}
