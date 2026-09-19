# 06 — Hour-of-day × day-of-week heatmap

Shows when traffic happens: backup windows, cron jobs, working hours and
unexpected night-time activity.

## Endpoint

**New** `GET /api/history/heatmap?from&to&tz&metric&name&app`

- `metric`: `total` (default), `tx` or `rx`.
- The default range is the last 28 days (four full weeks), so each cell is an
  average of 4 samples.

```sql
SELECT toDayOfWeek(minute, 0, {tz:String}) AS dow,      -- 1 = Monday
       toHour(minute, {tz:String})         AS hour,
       sum({METRIC})                        AS bytes,
       uniqExact(toDate(minute, {tz:String})) AS days      -- per-cell sample count
FROM flows_1m
WHERE minute >= {from_min:DateTime} AND minute < {to_min:DateTime} {FILTERS}
GROUP BY dow, hour
```

- `{METRIC}` comes from a whitelist: `tx_bytes`, `rx_bytes` or
  `tx_bytes + rx_bytes`.
- Value per cell = `bytes / days_in_range_with_that_weekday`. Compute the
  divisor on the server from `from`/`to` in `tz`, not from `days` above,
  because a weekday with zero traffic would otherwise be missing from the
  denominator. `days` is kept only to flag partial coverage.
- Show the cell as an **average rate over that hour**,
  `bytes*8/1000/3600` kbps, so the color scale has a meaningful unit.

## Chart

- ECharts `heatmap`. The x axis is hours 00–23 and the y axis is Mon…Sun,
  top to bottom.
- `visualMap`: continuous, with a **sequential single-hue** palette (from the
  dataviz skill) on a log scale, because traffic spans several orders of
  magnitude. ECharts has no log visualMap, so feed it `log10(v + 1)` and
  format the labels back.
- Tooltip: "Tue 03:00–04:00 · avg 4.2 Mbps · 4 weeks".
- Small multiples option: one heatmap per top-4 app (`?split=app`), each with
  its own scale. This shows, for example, that DNS runs all the time while
  HTTPS follows working hours.

## Interaction

Clicking a cell sets the History range to the most recent occurrence of that
weekday and hour, and scrolls to chart 05.

## Files

```
server/routes/history.ts        + /api/history/heatmap
client/history/ActivityHeatmap.tsx
```

## Edge cases

- DST days have 23 or 25 hours. The tz-aware functions handle them. The
  per-weekday divisor stays a day count, so the result is only slightly off.
- If the range is shorter than 7 days, show a note: "fewer than one full week:
  some cells are single samples".
