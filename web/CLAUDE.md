# CLAUDE.md (web/)

A standalone dashboard app for net-watch data. It shares no files with the Rust
workspace; only the Redis/ClickHouse data layout (documented in ../README.md)
connects them. See README.md here for running, config, layout and conventions.

- `npm run typecheck` checks both tsconfigs; `npm run build` bundles the client.
- The server runs `.ts` directly (Node type stripping). Use erasable syntax only,
  and import relative files with their `.ts` extension.
- API response types live in `src/shared/api.ts`; both sides import them.
- The Vite dev proxy key is the regex `^/api/`. A bare `/api` prefix would also
  proxy the client module `/api.ts`.
