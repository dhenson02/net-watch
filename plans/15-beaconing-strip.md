# 15 — Beaconing strip plot + periodicity score

For one process, draws one row per destination (`ip:port`) with a dot for
every tick that had traffic to it. Periodic telemetry, heartbeats and C2-style
beacons show up as evenly spaced dots, which a throughput chart never shows.

## Endpoint

**New** `GET /api/process/:pid/:start/beacons?from&to`. It defaults to the
process's full networked lifetime, capped at 24 h.

```sql
SELECT {DISPLAY_IP} AS ip, rport, proto, app,
       groupArray(toUnixTimestamp64Milli(ts)) AS ts_ms,
       groupArray(tx_bytes + rx_bytes)       AS bytes
FROM flows
WHERE pid = {pid:UInt32} AND proc_start = {start:UInt64}
  AND ts >= {from_dt:DateTime64(3)} AND ts < {to_dt:DateTime64(3)}
GROUP BY raddr, rport, proto, app
ORDER BY length(ts_ms) DESC
LIMIT 100
```

This is fast because `(pid, proc_start, ts)` is the table's primary key.
The server sorts each array by time, then computes the periodicity stats for
each destination:

```ts
gaps = diff(ts_ms)                    // ms between active ticks
// merge runs: consecutive ticks (gap == interval_ms) are one "burst"
bursts = starts of runs
intervals = diff(bursts)
period  = median(intervals)
cv      = stddev(intervals) / mean(intervals)
score   = n_bursts >= 6 && cv < 0.15 ? 1 - cv : 0
```

The response adds `{ period_s, cv, bursts, score }` per destination.

**Why merge runs:** a 3-second download is 3 consecutive active ticks, not 3
beacons. Only gaps between bursts show periodicity.

Also add **name-scoped mode**, `GET /api/history/beacons?name=&from&to`,
covering all instances of a program. It groups by `(raddr, rport)` across
instances. This query is slower because it cannot use the pid prefix, so
limit it to ≤ 6 h.

## Chart

- ECharts `scatter`. The y axis is category = destination (sorted by score,
  then by count). The x axis is time. `symbolSize` is scaled by
  `log(bytes)`, 3–9 px.
- A right-side column of `graphic` text, or a second y-axis with labels,
  shows "every 30.0 s · cv 0.02". Rows with a high score get an accent badge.
- `large: true` for more than 5k points.
- Tooltip: time, bytes, gap since the previous burst.
- Clicking a row filters History 05 to that `dest`.

## Also on the Process page

A table of destinations with `score > 0.8` sorted first. This is a lightweight
"periodic connections" detector. Call it a heuristic in the UI: DNS
refreshes, NTP and health checks are legitimately periodic.

## Files

```
server/routes/process.ts            + /api/process/:pid/:start/beacons
server/routes/history.ts            + /api/history/beacons (name mode)
server/analysis/periodicity.ts      (+ unit tests: perfect period, jitter, bursts, too few samples)
client/process/BeaconStrip.tsx
```

## Limits

- Resolution is one collector interval (default 1 s). Beacons faster than 2 s
  look continuous.
- `flows` TTL is 90 days, which is also the lookback limit here.
