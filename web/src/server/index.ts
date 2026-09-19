import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { createClickHouse } from './db/clickhouse.ts';
import { createRedis } from './db/redis.ts';
import { GeoDb } from './geo/asn.ts';
import { Rdns } from './geo/rdns.ts';
import { HttpError } from './http-error.ts';
import { LiveHub } from './live/hub.ts';
import { healthRoutes } from './routes/health.ts';
import { historyRoutes } from './routes/history.ts';
import { liveRoutes } from './routes/live.ts';
import { processRoutes } from './routes/process.ts';
import { rdnsRoutes } from './routes/rdns.ts';
import { Users } from './users.ts';

const app = Fastify({ logger: { level: config.logLevel } });

const redis = createRedis(config.redisUrl, app.log);
const clickhouse = createClickHouse(config.clickhouse);
const hub = new LiveHub(redis, app.log, config.liveBackfill);
hub.start();
const users = new Users(app.log);
await users.start();
// Loads in the background; the API serves without enrichment until it is ready.
const geo = new GeoDb(config.geoipFile, app.log);
void geo.start();
const rdns = new Rdns(config.rdns);
app.addHook('onClose', async () => {
  await hub.stop();
  users.stop();
  geo.stop();
  redis.destroy();
  await clickhouse.close();
});

// Every error response is `{ error }`. Messages of unexpected (non-HttpError)
// 5xx errors stay in the log.
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  const expose = status < 500 || err instanceof HttpError;
  if (!expose) req.log.error(err);
  return reply.code(status).send({ error: expose ? err.message : 'internal error' });
});

const deps = { redis, clickhouse, hub, users, geo, rdns };
healthRoutes(app, deps);
liveRoutes(app, deps);
historyRoutes(app, deps);
processRoutes(app, deps);
rdnsRoutes(app, deps);

const serveClient = existsSync(`${config.clientDir}/index.html`);
if (serveClient) {
  await app.register(fastifyStatic, {
    root: config.clientDir,
    setHeaders(reply, path) {
      // Vite content-hashes everything under assets/; index.html must revalidate.
      reply.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
} else {
  app.log.warn(`no client build at ${config.clientDir}; serving the API only (run "npm run build", or use "npm run dev")`);
}

app.setNotFoundHandler((req, reply) => {
  // Client-side routes fall back to the SPA; unknown API paths stay 404.
  if (req.method === 'GET' && !/^\/api(\/|\?|$)/.test(req.url) && serveClient) {
    return reply.type('text/html').sendFile('index.html');
  }
  return reply.code(404).send({ error: 'not found' });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info(`${signal}, shutting down`);
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}

await app.listen({ host: config.host, port: config.port });
