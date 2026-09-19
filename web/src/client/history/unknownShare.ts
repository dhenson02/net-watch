// Unknown-protocol share (16), the pure part: the `unknown` URL param, the
// median baseline, the tooltip text and the click-through. No DOM, so
// node --test covers it; UnknownShareTrack draws it.
import type { ThroughputUnknown } from '../../shared/api.ts';
import { fmtBytes } from '../charts/format.ts';
import { filterParam } from './throughputSeries.ts';

/** Reads `unknown` from a query string: on only for `1`. */
export function parseUnknownParam(search: string): boolean {
  return new URLSearchParams(search).get('unknown') === '1';
}

/** Median of the buckets that had traffic (nulls skipped); null when none did. */
export function medianShare(share: readonly (number | null)[]): number | null {
  const v = share.filter((s): s is number => s !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** A 0..1 share as a percentage: "14 %", "2.5 %", "0.3 %", "0 %", "100 %". Small non-zero shares keep a digit. */
export function fmtShare(share: number): string {
  const p = share * 100;
  if (p === 0 || p >= 10) return `${Math.round(p)} %`;
  if (p < 0.1) return '<0.1 %';
  return `${Number(p.toFixed(1))} %`;
}

/** Bucket `i`'s tooltip line: "unknown: 14 % (220 MiB of 1.5 GiB)", or "no traffic". */
export function unknownText(u: ThroughputUnknown, i: number): string {
  const s = u.share[i];
  if (s === null || s === undefined) return 'no traffic';
  return `unknown: ${fmtShare(s)} (${fmtBytes(u.bytes[i] ?? 0)} of ${fmtBytes(u.total[i] ?? 0)})`;
}

/** The click-through: the chart filtered to unknown traffic, stacked by destination. */
export const UNKNOWN_DRILL: Record<string, string> = { [filterParam('app')]: 'unknown', by: 'dest' };

export type SharePoint = { value: [number, number | null]; symbol?: 'circle' };

/**
 * One point per bucket for a time-axis line; null shares break the line. A
 * point between two gaps (or the edges) would draw nothing as a line, so it
 * gets a dot.
 */
export function sharePoints(t: readonly number[], u: ThroughputUnknown): SharePoint[] {
  const s = (i: number) => u.share[i] ?? null;
  return t.map((ts, i) => {
    const v = s(i);
    const alone = v !== null && s(i - 1) === null && s(i + 1) === null;
    return alone ? { value: [ts, v], symbol: 'circle' } : { value: [ts, v] };
  });
}
