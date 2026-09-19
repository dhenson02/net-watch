# 03 — Process → app protocol → destination Sankey

Answers "who talks to what, over which protocol" in one view. Link width is
bytes, or rate in live mode.

## Modes

| mode | source | metric |
|---|---|---|
| **live** (Live page) | hub: flows from the last 10 ticks | mean kbps over those ticks |
| **history** (History page) | ClickHouse `flows_1m` over the selected range | bytes |

A direction toggle picks tx, rx or both (default both = tx + rx).

## Endpoints

**New** `GET /api/live/flows?seconds=10`. It returns aggregated flows from the
hub. To support it, the hub also keeps the full `flows` arrays of the last 30
snapshots, which is a small memory cost.

```ts
export interface FlowAgg { name: string; proto: string; app: string; ip: string; rport: number; tx: number; rx: number }
```

**New** `GET /api/history/flows?from&to&limit=300`:

```sql
SELECT name, proto, app,
       {DISPLAY_IP} AS ip, rport,
       sum(tx_bytes) AS tx, sum(rx_bytes) AS rx
FROM flows_1m
WHERE minute >= toStartOfMinute(fromUnixTimestamp64Milli({from:Int64}))
  AND minute <  fromUnixTimestamp64Milli({to:Int64})
GROUP BY name, proto, app, raddr, rport
ORDER BY tx + rx DESC
LIMIT {limit:UInt32}
```

For ranges ≤ 2 h, use the same query on `flows` with `ts` for 1-second
precision at the edges.

## Graph building (client, pure function `buildSankey(flows, opts)`)

1. There are three layers: process name → `app` (with `proto` in the label
   when ambiguous, e.g. `DNS/UDP`) → destination.
2. Node ids **must be unique across layers**, and ECharts rejects cycles. Use
   a prefix on every id: `p:firefox`, `a:HTTPS`, `d:1.2.3.4:443`. The label
   formatter strips the prefix.
3. Limit the number of nodes, or the diagram becomes unreadable:
   - Keep the top 10 processes. The rest go to `p:other processes`.
   - Keep the top 15 destinations by total bytes. The rest go into one node
     per app, `d:other (HTTPS)`, so the protocol split survives.
   - Keep all apps (few in practice).
4. Destination label: `ip:port`. In 18, `ip:port` gains an ASN or org name
   when enrichment exists.
5. Drop links under 0.5 % of the total into their "other" nodes, so the
   diagram doesn't fill with hairline links.

```ts
{
  series: [{
    type: 'sankey', nodeAlign: 'justify', layoutIterations: 32, draggable: false,
    emphasis: { focus: 'adjacency' },
    lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.35 },
    label: { formatter: p => strip(p.name) },
    levels: [{ depth: 0, itemStyle: { color: … } }, { depth: 1, … }, { depth: 2, … }],
    data: nodes, links,
  }],
  tooltip: { formatter: link → "firefox → HTTPS: 12.3 MiB" },
}
```

- Color process nodes with the page's stable slot map (00). Color app nodes
  from a fixed app palette (HTTPS, QUIC, DNS and SSH each get a set hue). Draw
  destination nodes in neutral grey.
- Live mode refreshes every 2 s. Keep node order stable between refreshes, or
  the layout jumps. Sort the nodes deterministically (by name) before handing
  them over.

## Interaction

- Hovering a node highlights its neighbours (`focus: 'adjacency'`).
- Clicking a process node goes to its process page.
- Clicking a destination node filters the History page to that
  `raddr`/`rport` (a `?dest=` param that 05 honors).

## Files

```
server/live/hub.ts               + recent flows buffer
server/routes/live.ts            + GET /api/live/flows
server/routes/history.ts         + GET /api/history/flows
client/charts/FlowSankey.tsx
client/charts/buildSankey.ts     (+ unit test with node-cap and prefix cases)
```

## Edge cases

- UDP receivers with no address buffer report `0.0.0.0:0`. Label that node
  "unknown peer", not an IP.
- When the process and the destination share a label (a destination IP that
  looks like a name), the prefixes still keep the ids unique.
