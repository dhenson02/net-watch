# 10 — Bytes-per-call distribution

`tx_calls` and `rx_calls` count socket send and receive calls. Bytes divided
by calls separates chatty traffic (RPC, keepalives, DNS) from bulk transfer.
Most network tools don't record call counts, so few can show this.

## Endpoint

**New** `GET /api/history/bytes-per-call?from&to&dir=tx|rx&by=app|name&name?&pid?&start?`

Use log2 buckets, weighted by calls. Each call counts once, so a single 1 GB
transfer doesn't hide a million 60-byte keepalives.

```sql
SELECT {BY} AS k,
       toUInt8(floor(log2(greatest(tx_bytes / tx_calls, 1)))) AS bucket,   -- 2^bucket bytes
       sum(tx_calls) AS calls,
       sum(tx_bytes) AS bytes
FROM flows_1m
WHERE minute >= … AND minute < … AND tx_calls > 0 {FILTERS}
GROUP BY k, bucket
ORDER BY k, bucket
```

(The `rx` variant uses the rx columns.)

**Caveat:** in `flows_1m`, each row already sums a minute of calls, so
`bytes/calls` is a per-minute **mean** for each flow, not a per-call value.
The histogram therefore shows a distribution of per-flow-minute means. Say so
in the footnote. For process-scoped views (pid + start given), use raw
`flows`, which gives per-tick means. That is closer to per-call, and cheap
because `flows` is ordered by pid.

## Chart

- Default: a **heatmap**. Rows are `k` (top 10 apps), columns are buckets
  (1 B, 2 B, …, 1 MiB+), and color is the share of that row's calls. Each row
  is normalized to 100 %, so rows with very different volumes can be compared.
- Process page: a single-row bar histogram with the median marked.
- Tooltip: "HTTPS · 1–2 KiB per call · 34 % of calls · 2 % of bytes". The
  gap between the share of calls and the share of bytes is the insight.

## Files

```
server/routes/history.ts        + /api/history/bytes-per-call
server/routes/process.ts        (process-scoped variant on raw flows)
client/history/BytesPerCall.tsx
```
