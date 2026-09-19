import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { createClickHouse } from './db/clickhouse.ts';
import { createRedis } from './db/redis.ts';
import { healthRoutes } from './routes/health.ts';

const app = Fastify({ logger: { level: config.logLevel } });

const redis = createRedis(config.redisUrl, app.log);
const clickhouse = createClickHouse(config.clickhouse);
app.addHook('onClose', async () => {
  redis.destroy();
  await clickhouse.close();
});

healthRoutes(app, { redis, clickhouse });

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
