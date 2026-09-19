// Week-over-week ghost (11), the pure part: the `compare` URL param, the
// ghost line series, the tooltip lookup and the deviation shading. No DOM, so
// node --test covers it; ThroughputChart draws it.
import type { CompareOffset, ThroughputCompare, ThroughputDir } from '../../shared/api.ts';
import type { Point, Stack } from '../charts/mirroredStack.ts';
import { stacksOf } from './throughputSeries.ts';

export const COMPARE_VALUES: readonly CompareOffset[] = ['1d', '1w'];

/** How the earlier window is named: "same time last week". */
export const COMPARE_NOUN: Record<CompareOffset, string> = { '1d': 'yesterday', '1w': 'last week' };

/** Series id prefix of the ghost lines; the stack tooltip omits them and adds its own rows per section. */
export const GHOST_ID = 'ghost:';

/** Reads `compare` from a query string; anything but 1d/1w is off. */
export function parseCompareParam(search: string): CompareOffset | null {
  const v = new URLSearchParams(search).get('compare');
  return COMPARE_VALUES.includes(v as CompareOffset) ? (v as CompareOffset) : null;
}

/** The ghost's values for one drawn stack; rx is negated when mirrored below zero. Null where there is no data. */
export function ghostValues(c: ThroughputCompare, stack: Stack, dir: ThroughputDir): (number | null)[] {
  if (stack === 'tx') return c.tx;
  if (stack === 'rx') return dir === 'both' ? c.rx.map((v) => (v ? -v : v)) : c.rx;
  return c.tx.map((v, i) => (v === null ? null : v + (c.rx[i] ?? 0)));
}

/**
 * One dashed line per drawn stack (tx above, rx mirrored below), unstacked,
 * behind the bands (z 1), in `color`. `areas` (deviation runs, [from, to] ms)
 * go on the first line as a subtle markArea.
 */
export function ghostSeries(c: ThroughputCompare, dir: ThroughputDir, color: string, name: string, areas: readonly [number, number][] = []): object[] {
  return stacksOf(dir).map((stack, i) => {
    const v = ghostValues(c, stack, dir);
    const data: Point[] = c.t.map((t, j) => [t, v[j] ?? null]);
    return {
      id: `${GHOST_ID}${stack}`,
      name,
      type: 'line',
      data,
      color,
      lineStyle: { type: 'dashed', width: 1.5, opacity: 0.6, color },
      symbol: 'none',
      showSymbol: false,
      connectNulls: false,
      silent: true,
      z: 1,
      emphasis: { disabled: true },
      ...(i === 0 &&
        areas.length > 0 && {
          markArea: {
            silent: true,
            itemStyle: { color, opacity: 0.1 },
            data: areas.map(([from, to]) => [{ xAxis: from }, { xAxis: to }]),
          },
        }),
    };
  });
}

/** The ghost's rate (≥ 0) for a stack in the bucket holding `ts`; null outside it or before its data. */
export function ghostAt(c: ThroughputCompare, stack: Stack, ts: number): number | null {
  const i = Math.floor((ts - c.t[0]!) / (c.step * 1000));
  if (!(i >= 0 && i < c.t.length)) return null;
  const tx = c.tx[i] ?? null;
  const rx = c.rx[i] ?? null;
  if (stack === 'tx') return tx;
  if (stack === 'rx') return rx;
  return tx === null || rx === null ? null : tx + rx;
}

/** Change from the ghost to now, as a fraction; null when the ghost is 0 (no base to compare to). */
export function pctChange(current: number, ghost: number): number | null {
  return ghost > 0 ? (current - ghost) / ghost : null;
}

/** "+12 %", "−42 %" (a real minus), "±0 %"; ≥ 10× shows as "×12". */
export function fmtPct(p: number): string {
  if (p >= 9) return `×${Math.round(p + 1)}`;
  const n = Math.round(p * 100);
  return n === 0 ? '±0 %' : `${n > 0 ? '+' : '−'}${Math.abs(n)} %`;
}

/** The tooltip's value text: "3.1 Mbps (−42 %)", or "no data". */
export function ghostText(current: number | null, ghost: number | null, fmtRate: (kbps: number) => string): string {
  if (ghost === null) return 'no data';
  const p = current === null ? null : pctChange(Math.abs(current), ghost);
  return p === null ? fmtRate(ghost) : `${fmtRate(ghost)} (${fmtPct(p)})`;
}

/** Deviation runs need current above this multiple of the ghost… */
export const DEVIATION_FACTOR = 2;
/** …for at least this many ghost buckets in a row. */
export const DEVIATION_BUCKETS = 3;

/**
 * Time spans ([from, to] ms) where the current total (summed over the drawn
 * stacks, as magnitudes) is above DEVIATION_FACTOR × the ghost for at least
 * DEVIATION_BUCKETS of the ghost's buckets in a row. `totals` are the chart's
 * per-stack total lines, bucketed by `stepMs` (never coarser than the ghost's).
 * Buckets without ghost data break a run.
 */
export function deviationRuns(
  totals: Partial<Record<Stack, readonly Point[]>>,
  stacks: readonly Stack[],
  c: ThroughputCompare,
  stepMs: number,
): [number, number][] {
  const lines = stacks.map((s) => totals[s] ?? []);
  const n = Math.min(...lines.map((l) => l.length));
  const minSpan = DEVIATION_BUCKETS * c.step * 1000;
  const out: [number, number][] = [];
  let start: number | null = null;
  const close = (end: number) => {
    if (start !== null && end - start >= minSpan) out.push([start, end]);
    start = null;
  };
  for (let i = 0; i < n; i++) {
    const t = lines[0]![i]![0];
    let cur = 0;
    let ghost: number | null = 0;
    for (let k = 0; k < stacks.length; k++) {
      cur += Math.abs(lines[k]![i]![1] ?? 0);
      const g = ghostAt(c, stacks[k]!, t);
      ghost = g === null || ghost === null ? null : ghost + g;
    }
    const above = ghost !== null && cur > 0 && cur > DEVIATION_FACTOR * ghost;
    if (above && start === null) start = t;
    if (!above) close(t);
  }
  if (n > 0) close(lines[0]![n - 1]![0] + stepMs);
  return out;
}
