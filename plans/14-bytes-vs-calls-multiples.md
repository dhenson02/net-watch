# 14 — Bytes vs calls, shared-x small multiples

Puts bytes and call counts in vertically stacked panels that share one time
axis, instead of one dual-axis chart. A dual-axis chart invites comparisons
between two unrelated scales.

- Calls rise while bytes stay flat: something started polling or retrying.
- Bytes rise while calls stay flat: the transfers got bigger.

## Endpoint

Extend `GET /api/history/throughput` (05) with `&calls=1`. The server adds
`sum(tx_calls)` and `sum(rx_calls)` per bucket (totals only, not per key) and
returns:

```ts
calls?: { tx: number[]; rx: number[] }   // calls per second, aligned with t
```

This avoids a second request. A standalone
`GET /api/history/calls?from&to&step&name?&pid?&start?` serves the Process
page, where the query filters by `pid = {pid:UInt32} AND proc_start = {start:UInt64}`
on raw `flows` (primary-key hit).

## Chart

One ECharts instance with **three grids**:

1. Bytes/s (mirrored tx/rx lines, no stack).
2. Calls/s (mirrored).
3. Bytes per call = (1) ÷ (2), a derived line on a log y axis.

Setup:

- `xAxis` ×3 with `gridIndex` 0–2. Only the bottom grid shows labels.
- `axisPointer: { link: [{ xAxisIndex: 'all' }] }` gives one cursor across
  all three panels.
- `dataZoom` with `xAxisIndex: [0,1,2]`.
- Heights: 40 % / 30 % / 30 %. Each panel has its own y-axis name, so no
  legend is needed.
- Also `group: 'history'` so it links with 05.

On the History page this panel stays collapsed by default ("Calls &
efficiency ▸") to keep the page short. On the Process page it is open.

## Files

```
server/routes/history.ts             (calls branch)
server/routes/process.ts             + /api/process/:pid/:start/calls
client/charts/SmallMultiples.tsx     generic N-grid shared-x builder (reused by 13 on the process page)
client/history/CallsPanel.tsx
```
