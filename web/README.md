# net-watch-web

Web dashboard for [net-watch](../README.md). It is a standalone app: one Node
process serves the React SPA and a small JSON API that reads Redis (realtime)
and ClickHouse (history). It shares no files with the Rust collector, only the
databases.

## Why a web server (and not Electron/Tauri)

The databases listen on `127.0.0.1` on the monitored host, which is usually
headless. A server that runs next to them needs no extra network exposure, and
any browser can reach it through an SSH tunnel. A desktop app would need a
display on that host, or the databases opened to the network.

## Run

Requires Node ≥ 22.18. TypeScript runs directly under Node's type stripping,
so the server needs no build step.

```sh
cd web
cp .env.example .env        # optional; the defaults match the compose stack
npm ci
npm run build               # bundles the SPA into dist/client
npm start                   # http://127.0.0.1:8787
```

From another machine: `ssh -L 8787:127.0.0.1:8787 <host>`, then open
http://localhost:8787.

## Develop

```sh
npm run dev         # API on :8787 (node --watch) + Vite on :5173 with HMR
npm run typecheck   # client and server tsconfigs
```

Open http://127.0.0.1:5173. Vite proxies `/api/*` to the API server.

## Configuration

Environment variables, or `web/.env` (real environment variables win):

| variable | default |
|---|---|
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `8787` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` |
| `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | `netwatch` / `netwatch` |
| `CLICKHOUSE_DATABASE` | `netwatch` |
| `LOG_LEVEL` | `info` |

The API starts and stays up even when a database is down. Redis reconnects in
the background, and `/api/health` reports the state of each backend.

## API

| route | |
|---|---|
| `GET /api/health` | status, latency and version of Redis and ClickHouse (always 200 while the API is up) |

## Layout

```
src/server/    Fastify API + static hosting of dist/client (SPA fallback)
  db/          Redis and ClickHouse clients and their health probes
  routes/      one module per API area
src/client/    React SPA (Vite root)
src/shared/    API response types, imported by both sides
```

Conventions:

- Server code must be erasable TypeScript (no `enum`, `namespace` or parameter
  properties) because Node strips types rather than compiling them.
  `tsconfig.server.json` enforces this with `erasableSyntaxOnly`. Relative
  imports keep their `.ts` extension.
- ClickHouse queries run with `readonly=2`, so the dashboard cannot write.
  Pass user input as query parameters (`{name:Type}` + `query_params`), never
  by string concatenation.
- Charts will use Apache ECharts.
