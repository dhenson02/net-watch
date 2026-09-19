# 08 — tx vs rx log-log scatter

One point per process instance, or per process name, placed by lifetime bytes
sent and received. The diagonal separates uploaders from downloaders.

## Endpoint

**New** `GET /api/history/scatter?from&to&group=instance|name&limit=2000`

A process belongs to the range if its lifetime overlaps it. For
`group=instance`:

```sql
SELECT toString(pid) AS pid, toString(proc_start) AS proc_start,
       argMax(name, version)       AS name,
       argMax(cmdline, version)    AS cmdline,
       argMax(uid, version)        AS uid,
       argMax(tx_total, version)   AS tx,
       argMax(rx_total, version)   AS rx,
       argMax(start_ms, version)   AS start_ms,
       argMax(ended, version)      AS ended
FROM processes
GROUP BY pid, proc_start
HAVING start_ms < fromUnixTimestamp64Milli({to:Int64})
   AND (ended IS NULL OR ended >= fromUnixTimestamp64Milli({from:Int64}))
   AND tx + rx > 0
ORDER BY tx + rx DESC
LIMIT {limit:UInt32}
```

- `argMax(…, version)` in place of `FINAL` gives the same result. It is
  explicit, and it lets the filter run after deduplication.
- `tx_total` and `rx_total` are **lifetime** totals, not totals within the
  range. Label the axes accordingly. To get totals within the range, use
  `sum()` over `flows_1m` grouped by `pid, proc_start`. Offer that as the
  `?basis=range` variant, since it answers a different question.
- `group=name`: wrap the query above and `sum(tx), sum(rx), count()` by name.
  The point size encodes the instance count.

## Chart

- `scatter` with `xAxis: { type: 'log', name: 'received' }` and
  `yAxis: { type: 'log', name: 'sent' }`. Log axes cannot show 0, so plot
  `max(v, 1)` and mention the clamp in the tooltip.
- Reference lines through `markLine`:
  - `y = x` (solid, muted).
  - `y = 10x` and `y = x/10` (dashed), labelled "10× upload" and
    "10× download".

  The ratio is what stands out, not the absolute size.
- Point color: categorical by name for the top 8, grey for the rest.
  `symbolSize` is √(instances) in name mode, fixed in instance mode.
- Tooltip: name, pid, cmdline (truncated), ↑/↓ totals, ratio, lifetime.
- `brush` (rect) selection lists the selected processes in a table under the
  chart.
- Clicking a point opens the process page.

## Files

```
server/routes/history.ts        + /api/history/scatter
client/history/TxRxScatter.tsx
```

## Why it's useful

Browsers, package managers and `apt` sit well into the receive side. Backup
agents, sync clients and uploaders sit on the send side. An unexpected process
above the 10× upload line is worth a look.
