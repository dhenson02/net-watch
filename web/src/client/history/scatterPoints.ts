// Pure logic of the tx vs rx scatter (08): URL params, colors, axis extent,
// reference lines, ratio and lifetime text. No React or ECharts here, so
// node --test can run it.
import type { ScatterBasis, ScatterGroup, ScatterPoint } from '../../shared/api.ts';
import { SLOTS } from '../charts/palette.ts';

/** URL params: `scatter_by=name` (default instance), `scatter_basis=range` (default lifetime). */
export const GROUP_PARAM = 'scatter_by';
export const BASIS_PARAM = 'scatter_basis';

export const parseGroup = (raw: string | null): ScatterGroup => (raw === 'name' ? 'name' : 'instance');
export const parseBasis = (raw: string | null): ScatterBasis => (raw === 'range' ? 'range' : 'lifetime');

/** Log axes cannot show 0: a zero total is drawn at 1 B (the tooltip says so). */
export const clamp1 = (v: number) => Math.max(v, 1);

/**
 * The names that get a hue: the first `SLOTS` distinct names of `points`
 * (which arrive largest first). Everything else is grey.
 */
export function topNames(points: readonly Pick<ScatterPoint, 'name'>[], n = SLOTS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of points) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    out.push(p.name);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * A color slot per name. A name that already holds one of the page's slots
 * (e.g. a band of the throughput chart stacked by process) keeps it, so it
 * looks the same in both charts; the rest take the lowest slots left over.
 * Assigning here does not take slots from the page's other charts.
 */
export function colorSlots(names: readonly string[], pageSlot: (name: string) => number, slots = SLOTS): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  for (const name of names) {
    const s = pageSlot(name);
    if (s >= 0 && s < slots && !used.has(s)) {
      out.set(name, s);
      used.add(s);
    }
  }
  let next = 0;
  for (const name of names) {
    if (out.has(name)) continue;
    while (used.has(next)) next++;
    if (next >= slots) break;
    out.set(name, next);
    used.add(next);
  }
  return out;
}

/**
 * The shared extent of both log axes: whole decades around every point's
 * (clamped) tx and rx, at least one decade wide. The same on both axes, so
 * the diagonal runs corner to corner.
 */
export function axisExtent(points: readonly Pick<ScatterPoint, 'tx' | 'rx'>[]): [number, number] {
  if (!points.length) return [1, 1000];
  let lo = Infinity;
  let hi = 0;
  for (const p of points) {
    for (const v of [clamp1(p.tx), clamp1(p.rx)]) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const min = 10 ** Math.floor(Math.log10(lo) + 1e-9);
  let max = 10 ** Math.ceil(Math.log10(hi) - 1e-9);
  if (max <= min) max = min * 10;
  return [min, max];
}

export type RefLine = { id: 'even' | 'up10' | 'down10'; label: string; from: [number, number]; to: [number, number] };

/**
 * Reference lines in (received, sent) coordinates, clipped to the square
 * extent [lo, hi]: sent = received, sent = 10 × received ("10× upload") and
 * sent = received / 10 ("10× download").
 */
export function refLines([lo, hi]: [number, number]): RefLine[] {
  const lines: RefLine[] = [{ id: 'even', label: '', from: [lo, lo], to: [hi, hi] }];
  if (hi / lo > 10) {
    lines.push({ id: 'up10', label: '10× upload', from: [lo, lo * 10], to: [hi / 10, hi] });
    lines.push({ id: 'down10', label: '10× download', from: [lo * 10, lo], to: [hi, hi / 10] });
  }
  return lines;
}

/** "12× upload", "3.4× download", "even"; "sent only" / "received only" for a zero side. */
export function ratioText(tx: number, rx: number): string {
  if (tx <= 0 && rx <= 0) return '—';
  if (rx <= 0) return 'sent only';
  if (tx <= 0) return 'received only';
  const r = tx / rx;
  const fmt = (x: number) => (x >= 10 ? Math.round(x).toString() : x.toFixed(1));
  if (r >= 1.05) return `${fmt(r)}× upload`;
  if (r <= 1 / 1.05) return `${fmt(1 / r)}× download`;
  return 'even';
}

/**
 * How long the process (or, for a name, the span from its first start to its
 * last end) ran: until its end, else its last network I/O. Null if unknown.
 */
export function lifetimeMs(p: Pick<ScatterPoint, 'startMs' | 'endedMs' | 'lastSeenMs'>): number | null {
  if (p.startMs === null) return null;
  const end = p.endedMs ?? p.lastSeenMs;
  return end === null ? null : Math.max(0, end - p.startMs);
}

/** Marker size: fixed per instance; ∝ √instances per name, capped. */
export function symbolSize(group: ScatterGroup, instances: number): number {
  return group === 'instance' ? 8 : Math.min(40, 7 * Math.sqrt(Math.max(1, instances)));
}

/** A decade on a byte axis in SI units, which match decades: 1 B, 10 B, 1 kB, 100 MB. */
export function fmtDecadeBytes(v: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${Number(v.toPrecision(3))} ${units[i]}`;
}

/**
 * The indexes into `points` inside a brush rectangle given in (received,
 * sent) data coordinates, on the clamped values the chart plots.
 */
export function inRect(points: readonly Pick<ScatterPoint, 'tx' | 'rx'>[], [[x0, x1], [y0, y1]]: [[number, number], [number, number]]): number[] {
  const [xl, xh] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [yl, yh] = y0 <= y1 ? [y0, y1] : [y1, y0];
  const out: number[] = [];
  points.forEach((p, i) => {
    const x = clamp1(p.rx);
    const y = clamp1(p.tx);
    if (x >= xl && x <= xh && y >= yl && y <= yh) out.push(i);
  });
  return out;
}
