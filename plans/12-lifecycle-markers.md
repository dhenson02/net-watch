# 12 — Process start/end markers (overlay on 05)

Draws markers on the throughput chart for process starts and ends. Most "what
was that spike?" questions are answered by a process that started just before
it.

## Endpoint

**New** `GET /api/history/lifecycle?from&to&names=a,b,c&limit=200`

```sql
SELECT toString(pid) AS pid, toString(proc_start) AS proc_start,
       argMax(name, version)       AS name,
       argMax(first_seen, version) AS first_seen,
       argMax(ended, version)      AS ended,
       argMax(tx_total, version) + argMax(rx_total, version) AS bytes
FROM processes
GROUP BY pid, proc_start
HAVING (first_seen >= {from_dt:DateTime64(3)} AND first_seen < {to_dt:DateTime64(3)})
    OR (ended      >= {from_dt:DateTime64(3)} AND ended      < {to_dt:DateTime64(3)})
ORDER BY bytes DESC
LIMIT {limit:UInt32}
```

- Use **`first_seen`** (first network I/O), not `start_ms`. A daemon that
  started 3 days ago and first talked 2 minutes before the spike should mark
  the moment it started talking.
- `names` is optional. It is passed as `{names:Array(String)}` with
  `AND name IN {names:Array(String)}`. By default the client passes the
  current top keys when `by=name`. Otherwise it passes nothing, and the server
  keeps the top 200 by bytes.

## Chart

- Put these markers on a **separate thin track** under the throughput chart,
  on the same x axis, not directly on the areas:
  - ▲ = start (colored with the process's slot), ▼ = end.
  - One scatter series per kind on a secondary `grid` 36 px tall, linked
    through the `history` group.

  Vertical lines through the stack would bury the data once there are more
  than about ten events.
- When hovering a marker, draw a temporary vertical `markLine` across the main
  chart. The tooltip shows name, pid, bytes and the cmdline start.
- Cluster markers closer than 4 px. Show one marker with a count ("7 starts")
  whose tooltip lists them.
- Toggle: `Events: off | starts | starts+ends` (`?events=`).
- Clicking a marker opens the process page.

## Files

```
server/routes/history.ts            + /api/history/lifecycle
client/history/LifecycleTrack.tsx
client/history/clusterMarkers.ts    (+ unit test)
```
