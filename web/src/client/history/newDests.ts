// New-destination markers (17), the pure part: URL toggles, clustering of
// markers that would overlap, colors, the per-day counts and the notes. No
// DOM, so node --test covers it; the charts are NewDestTrack.tsx,
// NewDestDaily.tsx and process/NewDestList.tsx.
import type { NewDest, NewDestsResponse } from '../../shared/api.ts';
import { fmtTime } from '../charts/format.ts';

/** `?newdests=1`: the marker track under the History throughput chart. */
export const ND_TRACK_PARAM = 'newdests';
/** Endpoint options as URL params (History and Process pages alike). */
export const ND_PARAMS = { ports: 'nd_ports', loopback: 'nd_lo', warmup: 'nd_warmup' } as const;

export interface NewDestOptions {
  /** Key by ip and port (default: ip only). */
  ports: boolean;
  /** Keep loopback addresses. */
  loopback: boolean;
  /** Keep the destinations first seen in the first 24 h of data. */
  warmup: boolean;
}

export function parseNewDestOptions(search: string): NewDestOptions {
  const q = new URLSearchParams(search);
  return { ports: q.get(ND_PARAMS.ports) === '1', loopback: q.get(ND_PARAMS.loopback) === '1', warmup: q.get(ND_PARAMS.warmup) === '1' };
}

export const parseNewDestTrack = (search: string) => new URLSearchParams(search).get(ND_TRACK_PARAM) === '1';

export interface NewDestCluster {
  /** Where the marker is drawn: the mean time of its destinations. */
  t: number;
  /** Most first-hour bytes first. */
  items: NewDest[];
  /** The one program of every item, or null when they differ. */
  name: string | null;
}

/** Markers closer than this (px) are drawn as one, with a count. */
export const ND_CLUSTER_PX = 6;

/**
 * Groups destinations (any order) into markers: one joins the current marker
 * while it is less than `minPx` from that marker's first destination at
 * `msPerPx`, so no marker spans more than `minPx`. Only those in [from, to).
 */
export function clusterNewDests(dests: readonly NewDest[], range: { from: number; to: number }, msPerPx: number, minPx = ND_CLUSTER_PX): NewDestCluster[] {
  const gap = Math.max(0, msPerPx * minPx);
  const sorted = dests.filter((d) => d.firstMs >= range.from && d.firstMs < range.to).sort((a, b) => a.firstMs - b.firstMs);
  const groups: NewDest[][] = [];
  let cur: NewDest[] | null = null;
  for (const d of sorted) {
    if (cur && d.firstMs - cur[0]!.firstMs < gap) cur.push(d);
    else groups.push((cur = [d]));
  }
  return groups.map((g) => {
    const items = [...g].sort((a, b) => b.firstHourBytes - a.firstHourBytes || a.firstMs - b.firstMs);
    const name = items.every((d) => d.name === items[0]!.name) ? items[0]!.name : null;
    return { t: Math.round(g.reduce((s, d) => s + d.firstMs, 0) / g.length), items, name };
  });
}

/** Program names, the most new destinations first (ties by name): the order colors are handed out in. */
export function namesByCount(dests: readonly Pick<NewDest, 'name'>[]): string[] {
  const n = new Map<string, number>();
  for (const d of dests) n.set(d.name, (n.get(d.name) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name]) => name);
}

/** "chrome: 1.2.3.4:443", "7 new destinations" (tooltip head and aria text). */
export function clusterTitle(c: NewDestCluster): string {
  if (c.items.length === 1) return `${c.items[0]!.name} → ${c.items[0]!.dest}`;
  return c.name ? `${c.name}: ${c.items.length} new destinations` : `${c.items.length} new destinations`;
}

/** The start of the local day of `t` (the browser's timezone). */
export function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The start of the next local day (23, 24 or 25 h later around DST changes). */
export function nextDay(day: number): number {
  const d = new Date(day);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const OTHER_NAME = '__other';

export interface DailyCounts {
  /** Local day starts (ms), every day of the range present. */
  days: number[];
  /** Per program, a count per day; the top `top` programs by count, then OTHER_NAME if any are left. */
  series: { name: string; counts: number[] }[];
}

/** New destinations per local day, stacked by program: the top `top` by count and the rest folded. */
export function dailyCounts(dests: readonly Pick<NewDest, 'name' | 'firstMs'>[], range: { from: number; to: number }, top = 8): DailyCounts {
  const days: number[] = [];
  for (let d = dayStart(range.from); d < range.to; d = nextDay(d)) days.push(d);
  const index = new Map(days.map((d, i) => [d, i]));
  const names = namesByCount(dests);
  const kept = new Set(names.slice(0, top));
  const rows = new Map<string, number[]>();
  for (const n of [...names.slice(0, top), ...(names.length > top ? [OTHER_NAME] : [])]) rows.set(n, new Array<number>(days.length).fill(0));
  for (const d of dests) {
    const i = index.get(dayStart(d.firstMs));
    if (i === undefined) continue;
    rows.get(kept.has(d.name) ? d.name : OTHER_NAME)![i]!++;
  }
  return { days, series: [...rows].map(([name, counts]) => ({ name, counts })) };
}

/**
 * What the exclusions left out, for the note under a chart:
 * "154 first seen in the first 24 h of data (until Sep 20 16:36) hidden · 21 loopback hidden".
 * Null when nothing was hidden.
 */
export function hiddenText(d: Pick<NewDestsResponse, 'hidden' | 'warmupUntil'>): string | null {
  const parts: string[] = [];
  if (d.hidden.warmup > 0)
    parts.push(`${d.hidden.warmup} first seen in the first 24 h of data${d.warmupUntil ? ` (until ${fmtTime(d.warmupUntil)})` : ''} hidden`);
  if (d.hidden.loopback > 0) parts.push(`${d.hidden.loopback} loopback hidden`);
  return parts.length ? parts.join(' · ') : null;
}
