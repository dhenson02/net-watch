# 07 — uid → process → app treemap

Shows what used the bandwidth over a range. Area is bytes.

## Endpoint

**New** `GET /api/history/treemap?from&to&dir=total|tx|rx`

`flows_1m` has no `uid` column. It only has `pid`, `proc_start`, `name`,
`proto`, `app`, `raddr`, `rport` and the counters. Raw `flows` has `uid`, so
ranges ≤ 2 h can simply `GROUP BY uid, name, app` on `flows`. Longer ranges
have two options:

1. **(Recommended, no schema change.)** Join uid from `processes`:

   ```sql
   SELECT p.uid AS uid, f.name, f.app, sum(f.{METRIC}) AS bytes
   FROM flows_1m AS f
   LEFT JOIN (SELECT pid, proc_start, argMax(uid, version) AS uid
              FROM processes GROUP BY pid, proc_start) AS p
     USING (pid, proc_start)
   WHERE f.minute >= … AND f.minute < …
   GROUP BY uid, f.name, f.app
   ```

   `processes` holds one row per process instance, which is small enough for a
   hash join.
2. Add `uid` to `flows_1m` and its MV. This needs a schema migration, and
   `CREATE … IF NOT EXISTS` will not alter an existing table. Only do this if
   the join proves slow.

The server nests the rows into
`{ name: user, children: [{ name: proc, children: [{ name: app, value }] }] }`.
It maps uid to a username using `server/users.ts` (from 02, reads
`/etc/passwd`). Unknown uids show as `uid 1234`.

- Keep the top 30 processes per user. Group the rest as "other (N processes)".

## Chart

- ECharts `treemap`, `leafDepth: 2` (click to drill into the app level),
  `breadcrumb: { show: true }`, `roam: false`.
- Color by the **user** level (a categorical slot per uid) with
  `colorSaturation` varying across children. Mark root (uid 0) distinctly,
  because root-owned traffic is often the most interesting.
- Label: `{b}\n{fmtBytes(value)}`, hidden below a minimum size
  (`visibleMin: 300`).
- An alternative view toggle, `?tm=sunburst`, uses the same data. A sunburst
  reads better on a phone.

## Files

```
server/routes/history.ts        + /api/history/treemap
server/users.ts                 (shared with 02)
client/history/BandwidthTreemap.tsx
```

## Edge cases

- Containers: traffic is attributed to host PIDs, and container uids may not
  exist in the host `/etc/passwd`. Show the numeric id, not an error.
