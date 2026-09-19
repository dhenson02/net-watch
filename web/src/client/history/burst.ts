// Peak vs average band (13), the pure part: the `band` URL param, the band
// series (mean → p95 shaded, max dotted) and the tooltip lookup. No DOM, so
// node --test covers it; ThroughputChart draws it.
import { BURST_MAX_SPAN_MS, type BurstResponse, type BurstSide, type BurstStats, type ThroughputDir } from '../../shared/api.ts';
import type { Point, Stack } from '../charts/mirroredStack.ts';
import { stacksOf } from './throughputSeries.ts';

/** Series id prefix of the band; the stack tooltip omits it and adds its own row per section. */
export const BURST_ID = 'burst:';

/** Shown instead of the band when the range is too long for the raw scan. */
export const BAND_TOO_LONG = 'band needs ≤ 24 h range';

/** Reads `band` from a query string: `1` is on. */
export function parseBandParam(search: string): boolean {
  return new URLSearchParams(search).get('band') === '1';
}

/** Whether the band can be drawn over a range (the endpoint scans raw flows by time). */
export const bandSpanOk = (r: { from: number; to: number }) => r.to - r.from <= BURST_MAX_SPAN_MS;

/** The side of the answer a drawn stack reads. */
export const sideOf = (stack: Stack): BurstSide => (stack === 'sum' ? 'total' : stack);

/** The stats of one drawn stack, or undefined when the answer was for another direction. */
export const statsOf = (res: BurstResponse, stack: Stack): BurstStats | undefined => res[sideOf(stack)];

/**
 * Per drawn stack (tx above, rx mirrored below when `dir` is both): a
 * transparent line at the mean with the p95 − mean stacked on it and shaded
 * (the standard confidence band, so it sits on top of 05's stack, whose top is
 * the same mean), and the max as a thin dotted line. Behind the bands (z 1),
 * silent. Empty when the answer has no data for a stack.
 */
export function burstSeries(res: BurstResponse, dir: ThroughputDir, color: string): object[] {
  return stacksOf(dir).flatMap((stack) => {
    const s = statsOf(res, stack);
    if (!s) return [];
    const sign = stack === 'rx' && dir === 'both' ? -1 : 1;
    const pts = (v: (i: number) => number): Point[] => res.t.map((t, i) => [t, sign * v(i) || 0]);
    const common = { type: 'line', symbol: 'none', showSymbol: false, silent: true, z: 1, emphasis: { disabled: true } };
    return [
      { ...common, id: `${BURST_ID}lo:${stack}`, name: 'mean', stack: `${BURST_ID}${stack}`, data: pts((i) => s.mean[i]!), lineStyle: { opacity: 0 } },
      {
        ...common,
        id: `${BURST_ID}hi:${stack}`,
        name: 'p95',
        stack: `${BURST_ID}${stack}`,
        data: pts((i) => Math.max(0, s.p95[i]! - s.mean[i]!)),
        color,
        lineStyle: { width: 0 },
        areaStyle: { color, opacity: 0.22 },
      },
      {
        ...common,
        id: `${BURST_ID}max:${stack}`,
        name: 'max',
        data: pts((i) => s.max[i]!),
        color,
        lineStyle: { type: 'dotted', width: 1, color, opacity: 0.9 },
      },
    ];
  });
}

/** The band's values for a stack in the bucket holding `ts`; null outside the answer. */
export function burstAt(res: BurstResponse, stack: Stack, ts: number): { mean: number; p95: number; max: number } | null {
  const s = statsOf(res, stack);
  const i = Math.floor((ts - res.from) / (res.step * 1000));
  if (!s || !(i >= 0 && i < res.t.length)) return null;
  return { mean: s.mean[i]!, p95: s.p95[i]!, max: s.max[i]! };
}

/** p95 over the mean; null without a mean. */
export const burstRatio = (mean: number, p95: number): number | null => (mean > 0 ? p95 / mean : null);

/** "9×", "2.4×", "120×". */
export function fmtRatio(r: number): string {
  return r >= 10 ? `${Math.round(r)}×` : `${Math.round(r * 10) / 10}×`;
}

/** The tooltip's text: "mean 2.1 Mbps · p95 18 Mbps · max 94 Mbps · burst ratio 9×". */
export function burstText(v: { mean: number; p95: number; max: number }, fmtRate: (kbps: number) => string): string {
  const ratio = burstRatio(v.mean, v.p95);
  const base = `mean ${fmtRate(v.mean)} · p95 ${fmtRate(v.p95)} · max ${fmtRate(v.max)}`;
  return ratio === null ? base : `${base} · burst ratio ${fmtRatio(ratio)}`;
}
