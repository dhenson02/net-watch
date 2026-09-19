# 09 — Process lifetime Gantt

One bar per process instance, from start to end (or now), colored by bytes.
Short, repeated bars from the same name reveal restart loops and cron jobs.

## Endpoint

**New** `GET /api/history/lifetimes?from&to&name?&limit=500`

```sql
SELECT toString(pid) AS pid, toString(proc_start) AS proc_start,
       argMax(name, version)      AS name,
       argMax(start_ms, version)  AS start_ms,
       argMax(first_seen, version) AS first_seen,
       argMax(last_seen, version) AS last_seen,
       argMax(ended, version)     AS ended,
       argMax(tx_total, version) + argMax(rx_total, version) AS bytes
FROM processes
{WHERE name = {name:String}}
GROUP BY pid, proc_start
HAVING start_ms < fromUnixTimestamp64Milli({to:Int64})
   AND coalesce(ended, last_seen) >= fromUnixTimestamp64Milli({from:Int64})
ORDER BY name, start_ms
LIMIT {limit:UInt32}
```

- Only processes that did network I/O exist in this table.
- For a live process, `ended` is NULL. Draw it to "now" with an open (arrow)
  end.
- `start_ms` (process start) can be much earlier than `first_seen` (first
  network I/O). Draw the part before first I/O as a thin, hatched bar and the
  networked lifetime as the full-height bar.

## Chart

- ECharts `custom` series with a `renderItem` that draws a rect per row. This
  is the standard ECharts Gantt approach.
  - The y axis is category = **process name**. All instances of one name share
    a lane. When they overlap in time, a lane packing algorithm gives each
    overlapping instance its own sub-row.
  - The x axis is time.
- Color: sequential scale by `bytes` (log).
- Lane labels show the name plus the instance count ("cron-backup ×48").
- Sort lanes by first start or by total bytes (toggle).
- `dataZoom` on both axes.
- Clicking a bar opens `/process/:pid/:start`.

On the **Process page**, the same component is called with `name=<this name>`
over the last 7 days. It shows every past instance of the current program,
and the current one is highlighted.

## Pattern callouts (client-side)

For each lane, compute:

- `n` instances.
- The median lifetime.
- The coefficient of variation of start-time gaps. CV < 0.1 with n ≥ 5 means
  "runs every ~Xm", which marks a scheduled job.

Show these in the lane tooltip.

## Files

```
server/routes/history.ts        + /api/history/lifetimes
client/history/ProcessGantt.tsx
client/history/packLanes.ts     (+ unit test)
```

## Limits

- Cap the chart at 500 bars. Past that, show "narrow the range or filter by
  name".
- Many short-lived processes (for example a curl in a loop) can reach the cap
  quickly. In that case, offer to group lanes by name with density shading
  instead of individual bars. This is a later enhancement.
