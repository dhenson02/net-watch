# 17 — New-destination markers

Marks the first time a program contacts a remote address it has never used
before. Plotted over throughput, this shows when an update or a compromise
started talking somewhere new.

## Definition

A destination is **new for program P at time t** if `(P.name, raddr)` has no
earlier row anywhere in the retained history.

- It is keyed by **name**, not by instance. Otherwise every restart would make
  every destination "new".
- Port is ignored by default (`raddr` only). A toggle can include `rport`.

## Phase 1: query-only (no schema change)

**New** `GET /api/history/new-dests?from&to&name?&limit=500`

Query 1 finds the first contacts in the range:

```sql
SELECT name, raddr, {DISPLAY_IP} AS ip, min(minute) AS first_minute
FROM flows_1m
WHERE 1 {NAME_FILTER}
GROUP BY name, raddr
HAVING first_minute >= {from_min:DateTime} AND first_minute < {to_min:DateTime}
ORDER BY first_minute
LIMIT {limit:UInt32}
```

Query 2 gets the bytes in each destination's first hour. Fetch per-minute
sums for the new keys only, then add up the first hour of each key in JS:

```sql
SELECT name, raddr, minute, sum(tx_bytes + rx_bytes) AS bytes
FROM flows_1m
WHERE minute >= {from_min:DateTime} AND minute < {to_min:DateTime} + INTERVAL 1 HOUR
  AND (name, raddr) IN (
        SELECT name, raddr FROM flows_1m
        WHERE 1 {NAME_FILTER}
        GROUP BY name, raddr
        HAVING min(minute) >= {from_min:DateTime} AND min(minute) < {to_min:DateTime})
GROUP BY name, raddr, minute
```

The subquery repeats query 1's full scan. Tolerate that in phase 1. Phase 2
removes both scans.

This scans **all of `flows_1m`** (up to 2 years) on every request, because
"first ever" needs full history. That is acceptable while the table is small.
Measure it. Once it exceeds about 1 s, move to phase 2.

Exclusions:

- Skip `0.0.0.0` and `::`, which are UDP receivers with no peer address.
- Hide loopback by default (toggle).
- Hide destinations first seen within 24 h of the **table's** earliest data.
  Right after install, everything is new.

## Phase 2: first-seen table (schema change in `clickhouse/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS netwatch.dest_first_seen
(
    name       LowCardinality(String),
    raddr      IPv6,
    first_seen SimpleAggregateFunction(min, DateTime),
    last_seen  SimpleAggregateFunction(max, DateTime)
)
ENGINE = AggregatingMergeTree
ORDER BY (name, raddr);

CREATE MATERIALIZED VIEW IF NOT EXISTS netwatch.dest_first_seen_mv TO netwatch.dest_first_seen AS
SELECT name, raddr, min(minute) AS first_seen, max(minute) AS last_seen
FROM netwatch.flows_1m
GROUP BY name, raddr;
```

- An MV on the `flows_1m` target table fires for inserts that come from the
  `flows_1m_mv` chain. **Verify this on the running ClickHouse version**
  (cascaded MVs are supported, but test it). Alternatively, source the MV from
  `flows` with `toStartOfMinute(ts)`.
- Backfill once by hand: `INSERT INTO netwatch.dest_first_seen SELECT name, raddr, min(minute), max(minute) FROM netwatch.flows_1m GROUP BY name, raddr`.
  The collector's schema apply must **not** run this: `schema.sql` must stay
  idempotent. Document it in the README.
- Keep the statements splitter-friendly: no `/* */` comments containing `;`.
  Run `cargo test schema_splits` afterwards.
- Queries become `SELECT … FROM dest_first_seen WHERE first_seen BETWEEN …`
  with `min(first_seen)`/`GROUP BY name, raddr` to merge unmerged parts.
- As a bonus, `last_seen` gives "destinations not contacted in 30 days",
  which is useful for spotting stale configs.
- This touches the Rust side (`schema.sql`, which the collector embeds with
  `include_str!`), so the change is a collector release, not only a web change.

## Chart

- On 05: a marker track, like 12's, with ◆ = new destination, colored by the
  process slot. Clusters show a count.
- On the Process page: a list of "new destinations for this program in the
  last 7 days" (time, ip:port, app, bytes in the first hour), linking to 15's
  strip for that destination.
- An optional daily count bar chart: new destinations per day, stacked by
  program. A spike after an update is normal. A spike without an update is
  not.

## Files

```
server/routes/history.ts            + /api/history/new-dests
client/history/NewDestTrack.tsx
client/process/NewDestList.tsx
clickhouse/schema.sql               (phase 2 only)
README.md                           (phase 2: table docs + backfill command)
```
