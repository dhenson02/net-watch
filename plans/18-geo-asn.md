# 18 — Geo / ASN enrichment (optional)

Turns raw IPs into "AS16509 Amazon", "AS13335 Cloudflare" or "DE", so users
can see how much goes to which provider or country. It needs external data.
Nothing in the collector changes.

## Data source (pick one)

| option | licence | notes |
|---|---|---|
| **iptoasn.com** `ip2asn-combined.tsv.gz` | public domain | ASN + org + country, v4+v6, about 10 MB. **Recommended**: no account needed |
| MaxMind GeoLite2 ASN + Country (`.mmdb`) | free with account, EULA | needs a licence key for downloads. Adds a `maxmind` npm dep |
| DB-IP lite | CC BY 4.0 | similar to MaxMind lite |

The server runs on the monitored host, which may be offline. Load the file
from a local path (`GEOIP_FILE`) and **never download at runtime.** Add a
`npm run geo:update` script that the user runs deliberately.

## Where the lookup happens

**Option A: web server (recommended to start).**

- `server/geo/asn.ts` loads the TSV into sorted range arrays, one for v4 and
  one for v6 (`BigInt` for v6), and does binary search.
- About 500k ranges: a few seconds to load, ~50 MB of memory, and µs per
  lookup.
- Enrich the IPs in API responses on the way out (03, 05 with `by=dest`, 15,
  17).
- This cannot group by ASN inside SQL. For "bytes by ASN" the server first
  pulls per-IP sums (`GROUP BY raddr`, top 5000) and then groups them by ASN
  in JS. Label the result "approximate: top 5000 IPs cover N % of bytes".

**Option B: ClickHouse dictionary (later).**

- An `ip_trie` dictionary loaded from the same TSV lets SQL do
  `dictGet('asn', 'org', raddr)` and group by ASN over all data exactly.
- It needs the file mounted into the container and a
  `CREATE DICTIONARY IF NOT EXISTS` in `schema.sql`. The dashboard is
  `readonly=2` and cannot create one itself.
- The dictionary source must be a file readable by the ClickHouse container.
  Add a volume in `docker-compose.yml`.
- Choose this once option A's approximation is not good enough.

## Endpoints

- **New** `GET /api/history/asn?from&to&dir` returns
  `{ asn, org, country, bytes, ips }[]`.
- **New** `GET /api/history/countries?from&to&dir` returns
  `{ country, bytes }[]`.
- **Change**: every response that carries `ip` gains an optional
  `geo?: { asn: number; org: string; cc: string }`. It is absent when no
  database is configured, and the UI then hides the geo features.
- `/api/health` gains a `geo: { loaded: boolean; entries; fileDate }` field,
  so a stale database is visible.

## Charts (Destinations page)

- **Bar chart by ASN (primary).** Horizontal bars for the top 20 orgs,
  mirrored tx/rx. It answers "AWS vs Cloudflare vs Google" better than a map.
- **World choropleth (secondary).** ECharts `map` with a world GeoJSON
  **bundled locally** (no CDN at runtime; about 250 KB, lazy-loaded chunk).
  Use a log color scale. Private and loopback traffic is shown as a separate
  "local" stat, not on the map.
- **Destination table.** ip:port, reverse-DNS (optional, see below), ASN org,
  country, app, bytes and the number of processes, with a link to History
  filtered by that `dest`.
- In 03's Sankey, destination labels become `org (ip:port)`. An extra toggle
  collapses destinations to ASN nodes, which simplifies the diagram a lot.

## Reverse DNS (optional add-on)

- `dns.promises.reverse` with an LRU cache (10k entries, 1 h TTL) and a
  per-request budget (at most 20 lookups, 500 ms). Do it on hover or on demand
  only, never in bulk.
- Keep it off by default (`RDNS=1` enables it), because it sends queries from
  the monitored host.

## Files

```
server/geo/asn.ts                   loader + lookup (+ unit tests with a tiny fixture TSV)
server/geo/rdns.ts                  optional
server/routes/history.ts            + /asn, /countries
scripts/geo-update.ts               downloads iptoasn TSV to data/ (manual)
client/pages/DestinationsPage.tsx
client/destinations/AsnBars.tsx
client/destinations/WorldMap.tsx    (lazy import of echarts map + geojson)
client/destinations/DestTable.tsx
```

## Privacy note

All lookups happen locally against a file. The only outbound traffic is the
manual update script, plus rDNS if enabled.
