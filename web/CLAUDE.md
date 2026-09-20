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
- `start_ns` (and so every `pid:start_ns` id) is a u64 that passes 2^53 after
  ~104 days of uptime. Keep it a string end to end: the server parses snapshots
  with a reviver that keeps its source text (`live/compact.ts`), ClickHouse
  returns UInt64 as strings (keep that default), and the client never
  `Number()`s an id. Byte sums may be converted with `Number()`.
- Live data has one reader: `LiveHub` holds the only `XREAD` on
  `netwatch:stream` and fans out over SSE (`/api/live/events`). Do not add
  per-client XREADs or per-request snapshot reads from Redis. On the client,
  `useLive` shares one EventSource per tab.
- ClickHouse queries go through `chQuery` with `clientGone(reply)` as the
  signal, so a closed tab cancels the query. Table and time-column names come
  from `parseRange`'s whitelist, never from input. `flows_1m` needs `sum()` +
  `GROUP BY` (SummingMergeTree); `processes` needs `FINAL` or `argMax`.
- Disconnects are detected on the response (`reply.raw` 'close'), not the
  request: a GET request's 'close' fires as soon as its empty body is read.
- The dashboard reads with `readonly=2`. Only `routes/storage.ts` writes (Storage page: drop ClickHouse partitions, delete ended Redis processes), behind `STORAGE_ADMIN_PASSWORD` and through the separate `clickhouseAdmin` client. Never delete live-process keys from Redis: the collector owns them.
