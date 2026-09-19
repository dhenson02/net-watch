import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { CompactTick, LiveFlowsResponse, LiveHello, LiveMeta, LiveSnapshot, LiveSnapshotResponse } from '../../shared/api.ts';
import type { Redis } from '../db/redis.ts';
import { HttpError } from '../http-error.ts';
import { aggregateFlows, snapshotRows } from '../live/compact.ts';
import { RECENT_FLOWS, type LiveHub } from '../live/hub.ts';
import { withTimeout } from '../timeout.ts';
import type { Users } from '../users.ts';

const KEEPALIVE_MS = 15_000;
/** A client this far behind is dropped; EventSource reconnects and re-syncs. */
const MAX_BUFFERED_BYTES = 1 << 20;

/** A numeric hash field, or null when the collector has not written it. */
const num = (v: string | undefined) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function liveRoutes(app: FastifyInstance, deps: { hub: LiveHub; redis: Redis; users: Users }) {
  const { hub, redis, users } = deps;

  app.get<{ Querystring: { seconds?: string } }>('/api/live/series', async (req): Promise<CompactTick[]> => {
    const raw = req.query.seconds ?? '900';
    const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(seconds >= 1 && seconds <= 86_400)) throw new HttpError(400, 'seconds: expected an integer in 1..86400');
    return hub.series(seconds);
  });

  // Polled every 2 s by the top-talkers table, so it is not request-logged.
  // Every tab asks for the same snapshot, so the reduced form is kept until the next tick.
  let reduced: { snap: LiveSnapshot; res: Omit<LiveSnapshotResponse, 'serverTimeMs'> } | null = null;
  app.get('/api/live/snapshot', { logLevel: 'warn' }, async (): Promise<LiveSnapshotResponse> => {
    const snap = hub.latest();
    if (!snap) throw new HttpError(503, 'no live data yet');
    if (reduced?.snap !== snap) reduced = { snap, res: snapshotRows(snap, (uid) => users.name(uid)) };
    return { ...reduced.res, serverTimeMs: Date.now() };
  });

  // Polled every 2 s by the live Sankey, so it is not request-logged. The
  // aggregate is kept until the next tick (every tab asks for the same one).
  let flowsCache: { ts: number; seconds: number; res: LiveFlowsResponse } | null = null;
  app.get<{ Querystring: { seconds?: string } }>('/api/live/flows', { logLevel: 'warn' }, async (req): Promise<LiveFlowsResponse> => {
    const raw = req.query.seconds ?? '10';
    const seconds = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(seconds >= 1 && seconds <= RECENT_FLOWS)) throw new HttpError(400, `seconds: expected an integer in 1..${RECENT_FLOWS}`);
    const recent = hub.recentFlows(seconds);
    const ts = recent.at(-1)?.ts ?? null;
    if (ts === null) return { ts, ticks: 0, flows: [] };
    if (flowsCache?.ts !== ts || flowsCache.seconds !== seconds) {
      flowsCache = { ts, seconds, res: { ts, ticks: recent.length, flows: aggregateFlows(recent.map((r) => r.flows)) } };
    }
    return flowsCache.res;
  });

  // Polled every 5 s by the health strip, so it is not request-logged.
  app.get('/api/live/meta', { logLevel: 'warn' }, async (): Promise<LiveMeta> => {
    if (!redis.isReady) throw new HttpError(503, 'Redis: not connected');
    let meta: Record<string, string>, alive: number, ended: number;
    try {
      [meta, alive, ended] = await withTimeout(
        Promise.all([redis.hGetAll('netwatch:meta'), redis.sCard('netwatch:alive'), redis.zCard('netwatch:ended')]),
        2000,
        'redis meta',
      );
    } catch (err) {
      throw new HttpError(503, `Redis: ${(err as Error).message}`);
    }
    return {
      serverTimeMs: Date.now(),
      lastTickMs: num(meta.last_tick_ms),
      intervalMs: num(meta.interval_ms),
      drops: num(meta.drops),
      alive,
      ended,
    };
  });

  // One SSE stream per browser tab, all fed by the hub's single stream reader.
  const open = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of open) res.end();
  });

  app.get('/api/live/events', { logLevel: 'warn' }, (req, reply) => {
    reply.hijack(); // we write the raw response; Fastify must not serialize one
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // in case a proxy ever sits in front
    });
    res.flushHeaders();
    open.add(res);

    const send = (event: string, data: unknown) => {
      if (res.writableLength > MAX_BUFFERED_BYTES) {
        req.log.warn('SSE client too slow; closing its stream');
        res.destroy();
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('hello', { latestTs: hub.latestTs() } satisfies LiveHello);
    const unsubscribe = hub.subscribe((tick) => send('tick', tick));
    const keepalive = setInterval(() => res.write(':keepalive\n\n'), KEEPALIVE_MS);

    // The response's 'close' is the disconnect signal. The request's 'close'
    // fires once its empty GET body has been consumed.
    res.once('close', () => {
      clearInterval(keepalive);
      unsubscribe();
      open.delete(res);
    });
  });
}
