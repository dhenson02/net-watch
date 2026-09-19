# 04 — Health tiles

A strip of KPI tiles at the top of the Live page, showing that the pipeline
is running.

## Tiles

| tile | value | source | warn / bad |
|---|---|---|---|
| Collector lag | `now - last_tick_ms` | `netwatch:meta` | > 3 × interval / > 10 × interval |
| Dropped inserts | increase since the page was opened, plus the all-time value | `CompactTick.drops` | any increase → bad |
| Live processes | `nProcs` + sparkline | ticks | none |
| Active flows | `nFlows` + sparkline, % of 1M map capacity | ticks | > 50 % / > 80 % |
| Total ↑ / ↓ | current kbps + sparkline | ticks | none |
| ClickHouse ingest | rows in the last minute, latest `ts` | ClickHouse | latest ts older than 30 s → bad |

`drops` is a **cumulative counter since collector start** (`probe.drops()`
sums the per-CPU `DROPS` array). It resets to 0 when the collector restarts.
Compute increases as `max(0, cur - prev)`. A decrease means a restart. Show
"collector restarted" in the lag tile's subtitle for 5 minutes after one.

## Endpoints

**New** `GET /api/live/meta` returns `HGETALL netwatch:meta` plus
`SCARD netwatch:alive` and `ZCARD netwatch:ended`.

**New** `GET /api/history/ingest`:

```sql
SELECT max(ts) AS last_ts,
       countIf(ts > now() - INTERVAL 1 MINUTE) AS rows_1m
FROM flows
WHERE ts > now() - INTERVAL 10 MINUTE
```

This is cheap because it hits only today's partition and the `ts` minmax
index. The endpoint shows whether the ClickHouse sink is keeping up or is
buffering because ClickHouse is unavailable. The collector buffers up to
`--clickhouse-max-buffer`.

Poll both every 5 s. They can share the `useHealth` timer: extend
`/api/health` or add a sibling hook.

## UI

- `client/components/StatTile.tsx`: label, big value, unit, optional inline
  SVG sparkline (reuse `Sparkline` from 02), a tone (ok/warn/bad) shown as a
  left border, and a subtitle.
- The layout is a CSS grid, `repeat(auto-fit, minmax(160px, 1fr))`, which
  wraps to 2 columns on a phone.
- Tone must not be color only: add an icon or the words "OK / Lagging /
  Dropping" for accessibility.

## Files

```
server/routes/live.ts          + /api/live/meta
server/routes/history.ts       + /api/history/ingest
client/live/HealthStrip.tsx
client/components/StatTile.tsx
```

## Done when

To test the "bad" states:

- Stop the collector: lag goes red within 3 s.
- Stop ClickHouse: the ingest tile goes stale while Live keeps working.
