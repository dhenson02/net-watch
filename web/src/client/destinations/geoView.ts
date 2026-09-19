// Destinations page (18): URL state, labels and chart data. Pure, so it is
// unit-tested without a browser.
import type { AsnRow, CountryRow, DestScope, GeoBreakdown, GeoDir } from '../../shared/api.ts';
import { clip, orgDestLabel, shortOrg } from '../../shared/org.ts';

/** URL params of the Destinations page. */
export const DEST_PAGE_PARAMS = { dir: 'dir', asn: 'asn', cc: 'cc', scope: 'scope' } as const;

export interface DestPageParams {
  dir: GeoDir;
  asn: number | null;
  cc: string | null;
  scope: DestScope;
}

export function parseDestPageParams(search: string): DestPageParams {
  const p = new URLSearchParams(search);
  const d = p.get('dir');
  const dir: GeoDir = d === 'tx' || d === 'rx' ? d : 'total';
  const a = p.get('asn');
  const asn = a && /^\d{1,10}$/.test(a) && Number(a) > 0 ? Number(a) : null;
  const c = p.get('cc');
  const cc = c && /^[A-Z]{2}$/.test(c) ? c : null;
  const s = p.get('scope');
  const scope: DestScope = s === 'public' || s === 'local' || s === 'unmatched' ? s : 'all';
  return { dir, asn, cc, scope };
}

export { clip, shortOrg };

/** "AS16509 Amazon.com": the bar and chip label of an ASN. */
export const asnLabel = (g: { asn: number; org: string }) => `AS${g.asn} ${shortOrg(g.org)}`;

export { orgDestLabel };

let regionNames: Intl.DisplayNames | null | undefined;

/** "DE" → "Germany" (the browser's English names); the code itself when unknown. */
export function countryName(cc: string): string {
  if (!cc) return 'unknown country';
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    } catch {
      regionNames = null;
    }
  }
  try {
    const name = regionNames?.of(cc);
    // CLDR names ZZ "Unknown Region"; the code says more.
    return name && name !== 'Unknown Region' ? name : cc;
  } catch {
    return cc;
  }
}

/** Bars shown by the ASN chart. */
export const ASN_BARS = 20;

export interface AsnBarData {
  /** Bottom to top (ECharts' category y axis runs upwards), so the largest is on top. */
  labels: string[];
  asns: number[];
  tx: number[];
  /** Negative: drawn to the left of zero. */
  rx: number[];
  rows: AsnRow[];
}

/** The top ASNs as mirrored bars: tx to the right, rx to the left. */
export function asnBars(rows: readonly AsnRow[], n = ASN_BARS): AsnBarData {
  const top = rows.slice(0, n).reverse();
  return {
    labels: top.map((r) => clip(asnLabel(r), 32)),
    asns: top.map((r) => r.asn),
    tx: top.map((r) => r.tx),
    rx: top.map((r) => -r.rx),
    rows: top,
  };
}

export interface MapDatum {
  /** ISO alpha-2: the map's `nameProperty`. */
  name: string;
  /** log10(bytes), for the color scale. */
  value: number;
  bytes: number;
  ips: number;
}

/** Country rows as map data on a log scale, and the scale's extent. */
export function mapData(rows: readonly CountryRow[]): { data: MapDatum[]; min: number; max: number } {
  const data = rows.filter((r) => r.bytes > 0).map((r) => ({ name: r.country, value: Math.log10(r.bytes), bytes: r.bytes, ips: r.ips }));
  if (!data.length) return { data, min: 0, max: 1 };
  const vals = data.map((d) => d.value);
  const min = Math.floor(Math.min(...vals));
  const max = Math.max(min + 1, Math.ceil(Math.max(...vals)));
  return { data, min, max };
}

/** "approximate: the top 5000 IPs carry 99.2 % of the bytes", or null when every IP was grouped. */
export function coverageText(b: Pick<GeoBreakdown, 'coverage'>): string | null {
  const c = b.coverage;
  if (c.ips >= c.totalIps) return null;
  const pct = c.totalBytes > 0 ? (c.bytes / c.totalBytes) * 100 : 100;
  return `approximate: the top ${c.ips.toLocaleString()} of ${c.totalIps.toLocaleString()} IPs carry ${pct >= 99.95 ? '> 99.9' : pct.toFixed(1)} % of the bytes`;
}

/** Days after which the IP table counts as stale (iptoasn updates hourly; ASNs move slowly). */
export const GEO_STALE_DAYS = 60;

export function geoAgeDays(fileDate: number | null, now: number): number | null {
  return fileDate === null ? null : Math.floor((now - fileDate) / 86_400_000);
}

/** The share of `part` in `total`, as "12.3 %" ("< 0.1 %" for a sliver). */
export function pctText(part: number, total: number): string {
  if (!(total > 0)) return '—';
  const p = (part / total) * 100;
  return p > 0 && p < 0.1 ? '< 0.1 %' : `${p.toFixed(1)} %`;
}
