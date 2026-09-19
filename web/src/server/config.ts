import { fileURLToPath } from 'node:url';

/** web/ — the app root, whichever directory the server was started from. */
export const appRoot = fileURLToPath(new URL('../../', import.meta.url));

try {
  // Fills only variables that are not already set, so the real environment wins.
  process.loadEnvFile(`${appRoot}.env`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const env = (name: string, fallback: string): string => process.env[name] || fallback;

function port(name: string, fallback: number): number {
  const raw = env(name, String(fallback));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name}: invalid port "${raw}"`);
  return n;
}

export const config = {
  host: env('WEB_HOST', '127.0.0.1'),
  port: port('WEB_PORT', 8787),
  logLevel: env('LOG_LEVEL', 'info'),
  redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379'),
  clickhouse: {
    url: env('CLICKHOUSE_URL', 'http://127.0.0.1:8123'),
    username: env('CLICKHOUSE_USER', 'netwatch'),
    password: env('CLICKHOUSE_PASSWORD', 'netwatch'),
    database: env('CLICKHOUSE_DATABASE', 'netwatch'),
  },
  /** Built SPA; served only if it exists (in dev, Vite serves the client). */
  clientDir: `${appRoot}dist/client`,
} as const;

/** host:port of a URL, for display without credentials. */
export function displayTarget(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}
