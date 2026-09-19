# 11 — Week-over-week ghost line (overlay on 05)

Draws the same time window from one week earlier as a faint line behind the
current total. The eye catches deviations immediately, with no model or
thresholds.

## Endpoint

Extend `GET /api/history/throughput` with `&compare=1w|1d` (**change to an
existing endpoint** from 05). When the param is set, the server runs a second,
simpler query over `[from - offset, to - offset)`, totals only with no
per-key split, and shifts the timestamps by `+offset`:

```sql
SELECT toStartOfInterval(minute, INTERVAL {step:UInt32} SECOND) + INTERVAL {offset_s:UInt32} SECOND AS t,
       sum(tx_bytes) AS tx, sum(rx_bytes) AS rx
FROM flows_1m
WHERE minute >= {from_min:DateTime} - INTERVAL {offset_s:UInt32} SECOND
  AND minute <  {to_min:DateTime}   - INTERVAL {offset_s:UInt32} SECOND {FILTERS}
GROUP BY t ORDER BY t
```

The response gains
`compare?: { offset: number; t: number[]; tx: number[]; rx: number[] }`.
Run both queries in parallel with `Promise.all`.

- Always use `flows_1m`, even for short ranges. A 1-minute ghost is smooth
  enough.
- If the compare window is older than the data (`flows_1m` TTL is 2 years,
  and the table only has data since install), return `compare: null` and show
  "no data for last week".

## Chart

- Two `line` series (tx ghost above, rx ghost below, mirrored like 05).
  - `lineStyle: { type: 'dashed', width: 1.5, opacity: 0.6 }`, no area, color
    = the text-muted token.
  - `z: 1`, so the stack draws over it.
  - Not stacked.
- Tooltip adds a row: "same time last week: 3.1 Mbps (−42 %)".
- Toggle in the chart header: `Compare: off | 1 day | 1 week` (URL
  `?compare=`).
- Optional deviation shading: a `markArea` where current > 2 × ghost for at
  least 3 consecutive buckets. Compute it on the client and keep it subtle.

## Files

```
server/routes/history.ts                (compare branch)
client/history/ThroughputChart.tsx      (ghost series + toggle)
```
