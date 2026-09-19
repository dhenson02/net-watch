// Pure logic of the beaconing strip (15): row labels, the period text, dot
// sizes, the History link and the scope parameter. node --test covers it.
import { BEACON_MAX_SPAN_MS, BEACON_PERIODIC_SCORE, type BeaconDest, type BeaconScope } from '../../shared/api.ts';
import type { TimeRange } from '../api.ts';
import { fmtDuration } from '../charts/format.ts';

/** URL param of the Process page: `beacon_scope=name` shows every instance of the name. */
export const BEACON_SCOPE_PARAM = 'beacon_scope';
/** `?beacon_ip=`: an address to highlight on the strip (set by the new-destinations list, 17). */
export const BEACON_FOCUS_PARAM = 'beacon_ip';
/** The Beaconing panel's element id, a scroll target. */
export const BEACONS_PANEL_ID = 'beacons';

/** Row indexes of the destinations at address `ip` (any port); empty without a focus. */
export function focusRows(dests: readonly Pick<BeaconDest, 'ip'>[], ip: string | null): number[] {
  if (!ip) return [];
  const out: number[] = [];
  dests.forEach((d, i) => d.ip === ip && out.push(i));
  return out;
}

/** The first visible row of a scrolled strip that shows `row` (near the top) with `visible` rows. */
export function scrollStart(row: number, total: number, visible: number): number {
  return Math.max(0, Math.min(row - 2, total - visible));
}

export const parseBeaconScope = (raw: string | null): BeaconScope => (raw === 'name' ? 'name' : 'instance');

/** Dot diameter range, px, scaled by log(bytes). */
export const DOT_MIN = 3;
export const DOT_MAX = 9;

export const isPeriodic = (d: Pick<BeaconDest, 'score'>) => d.score > BEACON_PERIODIC_SCORE;

/**
 * One category label per destination, unique: `ip:port app`, plus the
 * transport when the same destination and app occur twice (TCP and UDP).
 */
export function rowLabels(dests: readonly Pick<BeaconDest, 'dest' | 'app' | 'proto'>[]): string[] {
  const base = dests.map((d) => `${d.dest} ${d.app}`);
  const count = new Map<string, number>();
  for (const b of base) count.set(b, (count.get(b) ?? 0) + 1);
  return dests.map((d, i) => (count.get(base[i]!)! > 1 ? `${base[i]}/${d.proto}` : base[i]!));
}

/** A period in seconds: "4.0 s", "30.0 s", "2.5 min", "1.5 h". */
export function fmtPeriod(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** The right-hand column: "every 30.0 s · cv 0.02", or the burst count when there is no spread to measure. */
export function periodText(d: Pick<BeaconDest, 'period_s' | 'cv' | 'bursts'>): string {
  if (d.period_s === null) return d.bursts === 1 ? '1 burst' : `${d.bursts} bursts`;
  if (d.cv === null) return `${d.bursts} bursts, ${fmtPeriod(d.period_s)} apart`;
  return `every ${fmtPeriod(d.period_s)} · cv ${d.cv.toFixed(2)}`;
}

/** A dot's diameter: log(bytes) mapped linearly from [lo, hi] to DOT_MIN..DOT_MAX. */
export function dotSize(bytes: number, lo: number, hi: number): number {
  const l = Math.log1p(Math.max(0, bytes));
  const a = Math.log1p(Math.max(0, lo));
  const b = Math.log1p(Math.max(0, hi));
  if (!(b > a)) return (DOT_MIN + DOT_MAX) / 2;
  return DOT_MIN + ((DOT_MAX - DOT_MIN) * Math.min(1, Math.max(0, (l - a) / (b - a))));
}

/** The smallest and largest dot bytes over all destinations; [0, 0] without dots. */
export function bytesExtent(dests: readonly Pick<BeaconDest, 'b'>[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of dests)
    for (const x of d.b) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  return lo === Infinity ? [0, 0] : [lo, hi];
}

/** The tooltip's gap line: since the previous burst's start, or its place in a burst. */
export function gapText(gap: number | null): string {
  if (gap === null) return 'first burst';
  if (gap === 0) return 'continues a burst';
  return `${fmtDuration(gap)} after the previous burst`;
}

/** History throughput narrowed to one destination over `range`. */
export const historyHref = (dest: string, range: TimeRange) =>
  `/history?${new URLSearchParams({ from: String(range.from), to: String(range.to), 'filter.dest': dest })}`;

/** The name scope's window: the last 6 h of `range` (the server cuts longer ones the same way). */
export function scopeRange(range: TimeRange, scope: BeaconScope): TimeRange {
  const max = BEACON_MAX_SPAN_MS[scope];
  return range.to - range.from > max ? { from: range.to - max, to: range.to } : range;
}

/** Scatter data per destination row: [t, row, bytes, gap]; `row` is the index into `dests`. */
export function dotData(dests: readonly Pick<BeaconDest, 't' | 'b' | 'gap'>[]): [number, number, number, number | null][] {
  const out: [number, number, number, number | null][] = [];
  dests.forEach((d, row) => {
    for (let i = 0; i < d.t.length; i++) out.push([d.t[i]!, row, d.b[i]!, d.gap[i]!]);
  });
  return out;
}
