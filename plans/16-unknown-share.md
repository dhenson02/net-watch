# 16 — Unknown-protocol share (overlay on 05)

A thin line under the throughput chart showing what fraction of bytes the
classifier labelled `unknown`. A rise means new traffic the classifier can't
label, which is worth a look (new app, new port, tunnelling).

## Endpoint

Extend `GET /api/history/throughput` (05) with `&unknown=1`:

```sql
SELECT toStartOfInterval(minute, INTERVAL {step:UInt32} SECOND) AS t,
       sumIf(tx_bytes + rx_bytes, app = 'unknown') AS unk,
       sum(tx_bytes + rx_bytes)                    AS total
FROM flows_1m
WHERE minute >= … AND minute < … {FILTERS}
GROUP BY t ORDER BY t
```

Return `unknown?: { share: (number|null)[]; bytes: number[] }`. `share` is
`null` when `total = 0`, so the line breaks instead of dropping to 0 %.

When `by=app`, the stacked chart already contains `unknown` as a key. The
separate track still helps, because a share stays readable when the absolute
volume is tiny.

## Chart

- A 48 px secondary grid under 05, alongside the lifecycle track (12).
- y axis 0–100 %.
- Line in the "attention" color. `markLine` at the range's median share
  (dashed) gives a baseline.
- Tooltip: "unknown: 14 % (220 MiB of 1.5 GiB)".
- Clicking the track sets `filter.app=unknown&by=dest` on 05, which lists the
  unlabelled destinations directly.

## Files

```
server/routes/history.ts                (unknown branch)
client/history/UnknownShareTrack.tsx
```

## Possible follow-up

Add a small table, "top unknown destinations (port, bytes)", next to the
track. It hints at which ports to add to `classify.rs`'s port table, which
feeds improvements back to the collector.
