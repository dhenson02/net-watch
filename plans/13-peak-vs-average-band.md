# 13 — Peak vs average band (overlay on 05)

Averaging per minute (or per 15 min) hides bursts. This overlay draws the
mean as a line and puts a p95 / max band behind it, computed from raw
per-tick data. A wide band means bursty traffic that the averaged chart
hides.

## Endpoint

**New** `GET /api/history/burst?from&to&step&dir=tx|rx|total&name?`

It uses raw `flows`, because only raw data has per-tick resolution. Two-level
aggregation: first sum per tick across all flows, then compute stats per
bucket:

```sql
SELECT toStartOfInterval(ts, INTERVAL {step:UInt32} SECOND) AS t,
       sum(bytes)          AS bytes,        -- for the true mean
       groupArray(kbps)    AS samples,      -- per-tick rates, active ticks only
       any(interval_ms)    AS interval_ms
FROM (
    SELECT ts, any(interval_ms) AS interval_ms,
           sum({METRIC}) AS bytes,
           sum({METRIC}) * 8 / any(interval_ms) AS kbps   -- bytes*8/ms = kbps
    FROM flows
    WHERE ts >= {from_dt:DateTime64(3)} AND ts < {to_dt:DateTime64(3)} {FILTERS}
    GROUP BY ts
)
GROUP BY t ORDER BY t
```

**Idle ticks produce no rows**, so statistics over `samples` alone skip
silent seconds and come out too high. The server fixes both statistics in JS:

- `mean = bytes * 8 / 1000 / step` (kbps over the whole bucket).
- Pad `samples` with `step*1000/interval_ms - samples.length` zeros, then take
  p95 and max.

The arrays hold at most about 900 values per bucket at a 15-minute step and
1 s ticks, so doing this in JS is cheap. It also avoids relying on ClickHouse
quantile approximations.

### Limits

- Raw `flows` over all processes scans every row in the time range. Clamp this
  endpoint to **≤ 24 h**. For longer ranges, the UI disables the toggle with
  "band needs ≤ 24 h range".
- With `name` set, the scan is still by time. Filtering on pid + proc_start
  (process page) uses the primary key and is fast for any range.
- Set `max_execution_time = 20`. If it is exceeded, return 504 with a clear
  message so the UI can suggest a shorter range.

## Chart

- Band: two stacked `line` series, a transparent lower one (mean) and an upper
  one (p95 − mean) with `areaStyle`. This is the standard ECharts confidence
  band.
- Max: a thin dotted line.
- It draws **on the total**, not per key. It sits under 05's stack in
  `dir=total` mode. In mirrored mode it is drawn per side.
- Toggle `Burst band` (`?band=1`).
- Tooltip: "mean 2.1 Mbps · p95 18 Mbps · max 94 Mbps · burst ratio 9×".

## Files

```
server/routes/history.ts            + /api/history/burst
client/history/ThroughputChart.tsx  (band series)
```
