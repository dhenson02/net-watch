# 05 — History throughput, stacked by dimension

The main History chart: throughput over the selected range, stacked by one
dimension the user chooses. Overlays 11, 12, 13 and 16 attach to it.

## Controls (URL state)

| param | values | default |
|---|---|---|
| `from`, `to` | ms, via RangePicker | last 24 h |
| `by` | `app`, `name`, `proto`, `uid`, `dest` | `app` |
| `dir` | `both` (mirrored), `tx`, `rx`, `total` | `both` |
| `top` | 5–20 | 8 |
| `filter.name`, `filter.app`, `filter.dest` | exact | none |

`dest` means `ip:port`. With `dir=both` the chart uses the same mirrored
layout as 01 (tx above, rx below). The x axis is time on both pages, so the
two views look alike.

## Endpoint

**New** `GET /api/history/throughput?from&to&step&by&top&dir&name&app&dest`

The `by` column comes from a whitelist:
`{ app: 'app', name: 'name', proto: 'proto', uid: 'toString(uid)', dest: "concat({DISPLAY_IP}, ':', toString(rport))" }`.
User input never reaches the SQL text.

Two-pass query: find the top N keys over the whole range, then bucket, folding
the rest into `other`:

```sql
WITH top_keys AS (
  SELECT {BY} AS k
  FROM flows_1m
  WHERE minute >= {from_min:DateTime} AND minute < {to_min:DateTime} {FILTERS}
  GROUP BY k
  ORDER BY sum(tx_bytes + rx_bytes) DESC
  LIMIT {top:UInt8}
)
SELECT toStartOfInterval(minute, INTERVAL {step:UInt32} SECOND) AS t,
       if({BY} IN (SELECT k FROM top_keys), {BY}, '__other') AS k,
       sum(tx_bytes) AS tx, sum(rx_bytes) AS rx
FROM flows_1m
WHERE minute >= {from_min:DateTime} AND minute < {to_min:DateTime} {FILTERS}
GROUP BY t, k
ORDER BY t
```

- For spans ≤ 2 h (see `ch/range.ts`), the same template runs against `flows`
  with `ts` for sub-minute steps. Filter columns are the same except `lport`,
  which only exists in `flows`.
- `{FILTERS}` are fixed fragments such as `AND name = {name:String}`, added
  only when the param is present. For `dest`, split it on the server into
  `raddr = toIPv6({ip:String}) AND rport = {port:UInt16}`.
- The server converts the rows to rates (`kbps = bytes*8/1000/step`) and pads
  missing buckets with 0 for every key. Stacked areas break on missing
  x-values, and ClickHouse `WITH FILL` does not pad per key easily. Use JS for
  the padding.

Response:

```ts
export interface ThroughputResponse {
  step: number; from: number; to: number;
  keys: string[];                 // ranked, '__other' last
  t: number[];                    // bucket starts (ms)
  tx: Record<string, number[]>;   // kbps, aligned with t
  rx: Record<string, number[]>;
}
```

Column-oriented arrays keep the payload small: 1500 points × 9 keys × 2 is
about 27k numbers.

## Chart

- Stacked `line` with `areaStyle` (01's option, reused through a shared
  `mirroredStackOption()` builder), `sampling: 'lttb'`, `showSymbol: false`.
- `dataZoom: [{ type: 'inside' }, { type: 'slider', height: 20 }]`. When a
  zoom ends (debounced 300 ms), write the new `from`/`to` to the URL and
  re-query. Zooming in on 30 days therefore switches from 15-minute buckets to
  1-minute ones, then to raw data.
- A brush drag on the x axis does the same as zoom.
- Clicking a legend item toggles it. Double-clicking sets
  `filter.<by>=<key>` and switches `by` to the next dimension
  (app → name → dest), which drills down.
- `group: 'history'` gives a linked cursor with 14 and the overlays.

## Files

```
server/routes/history.ts           + /api/history/throughput
server/ch/sql.ts                   BY_COLUMNS, DISPLAY_IP, filter fragment builder
client/pages/HistoryPage.tsx
client/history/ThroughputChart.tsx
client/history/useThroughput.ts
client/charts/mirroredStack.ts     shared with 01
```

## Performance notes

- 30 days of `flows_1m` over all processes is the heavy case. The
  `ORDER BY (minute, …)` key makes the time filter efficient. Check with
  `EXPLAIN indexes = 1` in the integration script.
- If queries over more than 30 days take more than a second, add an hourly
  rollup later (`flows_1h` SummingMergeTree + MV in `clickhouse/schema.sql`).
  Keep that file splitter-friendly, per the root CLAUDE.md. Do not build it
  until it is measured to be needed.
