// Periodicity of a destination's active ticks (15). Pure, so node --test
// covers it.
//
// A 3-second download is 3 consecutive active ticks, not 3 beacons: runs of
// consecutive ticks are merged into bursts first, and only the gaps between
// burst starts say whether the traffic is periodic.

/** Ticks at most this many collector intervals apart belong to the same burst (ticks jitter by a few ms). */
export const CONSECUTIVE_FACTOR = 1.5;
/** Fewer bursts than this never score. */
export const MIN_BURSTS = 6;
/** A coefficient of variation at or above this never scores. */
export const MAX_CV = 0.15;

export interface Periodicity {
  /** Median gap between burst starts, s; null with fewer than 2 bursts. */
  period_s: number | null;
  /** stddev / mean of the gaps between burst starts; null with fewer than 3 bursts (one gap has no spread). */
  cv: number | null;
  bursts: number;
  /** 1 - cv with at least MIN_BURSTS bursts and cv < MAX_CV, else 0. */
  score: number;
}

/** Whether `gap` (ms) continues a burst at this collector interval. */
const continues = (gap: number, intervalMs: number) => gap <= intervalMs * CONSECUTIVE_FACTOR;

/** Indexes of the ticks that start a burst. `ts` is sorted ascending (ms). */
export function burstStarts(ts: readonly number[], intervalMs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < ts.length; i++) if (i === 0 || !continues(ts[i]! - ts[i - 1]!, intervalMs)) out.push(i);
  return out;
}

/**
 * Per tick, the gap (ms) since the previous burst's start: 0 for a tick that
 * continues a burst, null for the first burst.
 */
export function burstGaps(ts: readonly number[], intervalMs: number): (number | null)[] {
  const out: (number | null)[] = [];
  let start: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    if (i > 0 && continues(ts[i]! - ts[i - 1]!, intervalMs)) {
      out.push(0);
      continue;
    }
    out.push(start === null ? null : ts[i]! - start);
    start = ts[i]!;
  }
  return out;
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/** The periodicity of sorted tick times `ts` (ms) at collector interval `intervalMs`. */
export function periodicity(ts: readonly number[], intervalMs: number): Periodicity {
  const starts = burstStarts(ts, intervalMs).map((i) => ts[i]!);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  if (gaps.length === 0) return { period_s: null, cv: null, bursts: starts.length, score: 0 };
  const period_s = round(median(gaps) / 1000, 3);
  if (gaps.length < 2) return { period_s, cv: null, bursts: starts.length, score: 0 };
  const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  const cv = round(sd / mean, 4);
  const score = starts.length >= MIN_BURSTS && cv < MAX_CV ? round(1 - cv, 4) : 0;
  return { period_s, cv, bursts: starts.length, score };
}
