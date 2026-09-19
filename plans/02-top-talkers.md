# 02 — Top-talkers table with sparklines

A table of live processes, plus those that ended in the last 60 s. Each row
shows the current rates, a 60-second sparkline and lifetime totals.

## Data

- Current rows: `GET /api/live/snapshot` (**new**). It returns the hub's
  latest full snapshot, reduced to the process list:

  ```ts
  export interface LiveProcess {
    id: string; pid: number; startNs: string; name: string; cmdline: string; uid: number;
    startMs: number; firstSeenMs: number; lastSeenMs: number; endedMs: number | null;
    txKbps: number; rxKbps: number; txTotal: number; rxTotal: number;
    nFlows: number;               // count of this tick's flows with this id
  }
  export interface LiveSnapshotResponse { ts: number; intervalMs: number; processes: LiveProcess[] }
  ```

  The SSE `tick` event (00) carries only compact per-process rates. The table
  re-fetches `/api/live/snapshot` every 2 s, which is cheap because it is
  served from memory. It does not need to refresh every second.
- Sparklines: built from the `CompactTick.procs` entries that `useLive`
  already holds. No extra request.
- `cmdline` can be long. Truncate it to 300 chars on the server. The process
  page gets the full value from `netwatch:proc:{id}` (`HGET cmdline`).

## Columns

| column | notes |
|---|---|
| status dot | green = live, grey = ended (row at 55 % opacity, "ended 12 s ago") |
| name | bold; cmdline below in muted monospace, one line with ellipsis, full text in `title` |
| pid / uid | uid shown as username. The server reads `/etc/passwd` once at startup; see 07 |
| ↑ tx | current rate + inline bar scaled to the table max |
| ↓ rx | same |
| 60 s | sparkline: tx above, rx below, same convention as 01 |
| flows | active flow count |
| total ↑ / ↓ | lifetime bytes |
| age | `now - startMs` |

- Default sort: `tx + rx` descending. Clicking a header sorts by that column.
  Persist the sort in `?sort=`.
- Filter box: substring match on name or cmdline (client-side).
- Toggle: "hide idle" (default on). It hides rows with 0 rate for 30 s.
- Clicking a row opens `/process/:pid/:start`.

## Sparklines

Render them as **plain inline SVG** (a 120×28 `<path>`), not ECharts. A
table with 50 rows would otherwise create 50 chart instances. Write a
`<Sparkline tx={number[]} rx={number[]} />` component. Scale each row to its
own max, and show the max value in the tooltip.

## Files

```
server/routes/live.ts          + GET /api/live/snapshot
server/users.ts                uid → username map from /etc/passwd (read once, refresh hourly)
client/live/TopTalkers.tsx
client/components/Sparkline.tsx
client/live/useSnapshot.ts
```

## Edge cases

- Rows keyed by `id` (string). Never key by pid.
- Two rows can share a pid when a PID has been reused within 60 s. Both are
  shown, and they are distinguishable by age.
- Render up to 200 rows. Past that, show "N more hidden by filter". No
  virtualization is needed yet.

## Done when

- Sorting, filtering and row click work.
- Ended processes fade out and disappear after 60 s, when the collector stops
  listing them.
