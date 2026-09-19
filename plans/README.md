# Dashboard visualization plans

These plans turn the chart ideas for the `web/` dashboard into build steps.
Each file stands alone, but every chart depends on **00-foundation**, so build
that first.

## Index

| # | plan | source | page | size |
|---|---|---|---|---|
| 00 | [Foundation](00-foundation.md): ECharts, routing, live hub, SSE, query helpers | both | — | L |
| 01 | [Live throughput (mirrored area)](01-live-throughput.md) | Redis | Live | M |
| 02 | [Top-talkers table + sparklines](02-top-talkers.md) | Redis | Live | M |
| 03 | [Process → app → destination Sankey](03-flow-sankey.md) | Redis + CH | Live, History | M |
| 04 | [Health tiles](04-health-tiles.md) | Redis | Live (header strip) | S |
| 05 | [History throughput, stacked by dimension](05-history-throughput.md) | CH `flows_1m` | History | M |
| 06 | [Hour × weekday heatmap](06-activity-heatmap.md) | CH `flows_1m` | History | S |
| 07 | [uid → process → app treemap](07-bandwidth-treemap.md) | CH `flows_1m` | History | S |
| 08 | [tx vs rx log-log scatter](08-tx-rx-scatter.md) | CH `processes` | History | S |
| 09 | [Process lifetime Gantt](09-process-gantt.md) | CH `processes` | History, Process | M |
| 10 | [Bytes-per-call distribution](10-bytes-per-call.md) | CH `flows_1m` | History, Process | S |
| 11 | [Week-over-week ghost line](11-week-over-week-ghost.md) | CH `flows_1m` | overlay on 05 | S |
| 12 | [Process start/end markers](12-lifecycle-markers.md) | CH `processes` | overlay on 05 | S |
| 13 | [Peak vs average band](13-peak-vs-average-band.md) | CH `flows` | overlay on 05 | M |
| 14 | [Bytes vs calls small multiples](14-bytes-vs-calls-multiples.md) | CH `flows_1m` | History, Process | S |
| 15 | [Beaconing strip plot + periodicity score](15-beaconing-strip.md) | CH `flows` | Process | M |
| 16 | [Unknown-protocol share](16-unknown-share.md) | CH `flows_1m` | overlay on 05 | S |
| 17 | [New-destination markers](17-new-destinations.md) | CH (+ optional new table) | overlay on 05, Process | M–L |
| 18 | [Geo / ASN enrichment](18-geo-asn.md) (optional) | CH + local IP DB | Destinations | L |

## Suggested order

1. **00**: foundation.
2. **04, 01, 02**: the Live page. Once these work, the dashboard is useful.
3. **05, 12**: History throughput with process start/end markers.
4. **03, 08**: the rest of the first-dashboard set.
5. **11, 16, 06, 07, 14**: cheap additions that reuse the queries from 05.
6. **09, 10, 13, 15**: the process drill-down page.
7. **17, 18**: these need a schema change or external data, so do them last.

## Target UI structure

```
/                      → redirect to /live
/live                  Live page: 04 strip, 01, 02, 03 (live mode)
/history?from&to&by    History page: 05 (+11/12/13/16 toggles), 06, 07, 08, 03 (history mode)
/process/:pid/:start   Process page: header, 09 (instances of same name), 14, 10, 15, 17, dest table
/destinations          (18) ASN / country breakdown, destination table
```

Every page keeps its state in the URL (time range, group-by, toggles) so views
can be linked and bookmarked. The server's existing SPA fallback in
`web/src/server/index.ts` already covers these paths.

## Conventions every plan follows

- Put every response type in `web/src/shared/api.ts`. Both sides import it.
- Keep the server as erasable TypeScript with `.ts` import suffixes. ClickHouse
  queries pass parameters as `{name:Type}` placeholders only (`readonly=2`
  applies).
- Treat `pid:start_ns` as a string everywhere (see "64-bit IDs" in 00).
  Never parse it as a JS number.
- Time is in ms since epoch on the wire. The browser sends its IANA timezone
  for any bucketing by hour or day.
- Charts use Apache ECharts through the shared `<EChart>` wrapper and the
  shared palette and formatters (00).
