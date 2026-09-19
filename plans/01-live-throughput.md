# 01 — Live throughput (mirrored stacked area)

Shows system-wide send and receive rates at 1 s resolution, split into the
top processes. tx is stacked above zero and rx below it, on one shared time
axis.

## Data

- Source: the hub's `CompactTick[]` ring buffer (00). Nothing new is read
  from Redis.
- Endpoints: the existing `GET /api/live/series?seconds=N` plus
  `GET /api/live/events` (SSE). **No new endpoint.**

## Series construction (client, `useLiveThroughput`)

1. Pick the window: 5 min, 15 min (default), or as much as the buffer holds.
2. Choose the top N (default 8) by `Σ(tx + rx)` over the window.
   - Recompute the ranking every 5 s, not every tick, so the legend does not
     jitter.
   - Keep a series that has been in the top N at least 15 s longer
     (hysteresis) so a process near the cutoff does not flicker in and out.
3. For each tick, add each process's rate to its series. Everything else goes
   to "other", so the stack always adds up to `txKbps`/`rxKbps`.
4. Group by **process name**, not by id. Several `chrome` instances make one
   band. Offer a toggle "by name / by instance" (`?live_by=name|id`).
5. Put tx series on `stack: 'tx'` with positive values. Put rx series on
   `stack: 'rx'` with **negative** values. The y-axis label formatter shows
   `Math.abs`.
6. When the hub reports a gap, insert a `null` point so the area breaks.

## ECharts option sketch

```ts
{
  animation: false,
  grid: { top: 24, right: 16, bottom: 28, left: 56 },
  xAxis: { type: 'time' },
  yAxis: { type: 'value', axisLabel: { formatter: v => fmtRate(Math.abs(v)) } },
  tooltip: { trigger: 'axis', valueFormatter: v => fmtRate(Math.abs(v)) },   // tooltip lists tx then rx, sorted
  legend: { type: 'scroll', top: 0 },
  series: [
    ...top.map(n => ({ id: `tx:${n}`, name: n, type: 'line', stack: 'tx', areaStyle: {}, symbol: 'none',
                       lineStyle: { width: 0 }, color: slot(n), sampling: 'lttb' })),
    ...top.map(n => ({ id: `rx:${n}`, name: n, type: 'line', stack: 'rx', areaStyle: { opacity: .75 }, ... })),
    // thin total lines on top so the envelope reads cleanly
  ],
  markLine: { data: [{ yAxis: 0 }], silent: true, symbol: 'none' },
}
```

- tx and rx series for the same process share a legend name, so one legend
  click toggles both.
- Put small fixed "↑ sent" and "↓ received" labels at the top-left and
  bottom-left using `graphic`.
- Updates on each tick: append the point, drop points older than the window,
  and call `setOption({ series:[{id, data}] })` for the changed series only.
- Keep `animation: false`. A 1 Hz update with animation looks laggy.

## Interaction

- Clicking a band navigates to `/process/:pid/:start`. In "by name" mode it
  goes to the largest instance with that name.
- A "pause" button freezes the rendered data while ticks keep buffering, so
  the user can hover without the chart moving.
- On hover, a thin vertical cursor is shared with 02's sparklines via
  `echarts.connect('live')`.

## Files

```
client/pages/LivePage.tsx                 layout
client/live/LiveThroughput.tsx            panel + chart
client/live/useLiveThroughput.ts          top-N / hysteresis / series building (pure, unit-testable)
```

## Edge cases

- If Redis is down, the SSE stays open, but the hub gets no ticks. Show a
  "stale since HH:MM:SS" overlay once `now - lastTs > 3 * intervalMs`.
- `interval_ms` other than 1000 changes nothing, because rates are already
  kbps and the x axis is time-based.
- Idle host (all zeros): show a flat line at 0 instead of an empty state.

## Done when

- A 15-minute backfill renders in under 200 ms.
- Steady 1 Hz updates hold 60 fps while hovering.
- Colors stay stable when the ranking changes.
