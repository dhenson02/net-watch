// Series building for the live throughput chart (01): top-N ranking with
// hysteresis, grouping by name or instance, and the mirrored tx/rx stacks.
// Everything but the hook at the bottom is pure, so node --test covers it.
import { useMemo, useRef } from 'react';
import type { CompactTick } from '../../shared/api.ts';
import type { SlotAssigner } from '../charts/palette.ts';

export type GroupBy = 'name' | 'id';

/** Series key of the remainder band. Not a valid process name or id. */
export const OTHER_KEY = '\0other';

export const TOP_N = 8;
/** The ranking is recomputed this often (tick time), so the legend holds still. */
export const RANK_EVERY_MS = 5_000;
/** A series that falls out of the top N stays this much longer. */
export const HOLD_MS = 15_000;

export type Point = [ts: number, kbps: number | null];

export interface RankState {
  groupBy: GroupBy;
  windowS: number;
  /** Tick time the ranking was computed at. */
  rankedAt: number;
  /** Shown series keys, largest first. At most `n`. */
  top: string[];
  /** Last ranking each key was in the plain (no hysteresis) top N. */
  lastInTop: Map<string, number>;
}

export interface Band {
  /** Process name, or `pid:start_ns` id, or OTHER_KEY. */
  key: string;
  label: string;
  /** Color slot from the page's SlotAssigner; -1 for "other". */
  slot: number;
  /** kbps, >= 0. */
  tx: Point[];
  /** kbps, <= 0 (drawn below zero). */
  rx: Point[];
}

export interface Throughput {
  /** The top series (largest first), then "other". */
  bands: Band[];
  totalTx: Point[];
  totalRx: Point[];
  /** Series key → id of its largest instance in the window (for click-through). */
  instance: Map<string, string>;
}

const pidOf = (id: string) => id.slice(0, id.indexOf(':'));

export function keyOf(p: { id: string; name: string }, by: GroupBy): string {
  return by === 'name' ? p.name : p.id;
}

/** Σ(tx + rx) per series key over the ticks. */
export function windowSums(ticks: readonly CompactTick[], by: GroupBy): Map<string, number> {
  const sums = new Map<string, number>();
  for (const t of ticks) {
    for (const p of t.procs) {
      const k = keyOf(p, by);
      sums.set(k, (sums.get(k) ?? 0) + p.tx + p.rx);
    }
  }
  return sums;
}

/**
 * Picks the shown series. Reuses `prev` until RANK_EVERY_MS of tick time has
 * passed (or the grouping or window changed). A series that drops out of the
 * top N is kept until HOLD_MS after it was last in it; newcomers take the
 * remaining places by rank.
 */
export function rank(
  ticks: readonly CompactTick[],
  by: GroupBy,
  windowS: number,
  prev: RankState | null,
  n = TOP_N,
): RankState {
  const now = ticks.at(-1)?.ts ?? 0;
  const same = prev !== null && prev.groupBy === by && prev.windowS === windowS;
  if (same && now >= prev.rankedAt && now - prev.rankedAt < RANK_EVERY_MS) return prev;

  const sums = windowSums(ticks, by);
  const fresh = [...sums]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([k]) => k);
  const freshSet = new Set(fresh);

  const lastInTop = new Map<string, number>();
  if (same) for (const [k, at] of prev.lastInTop) if (now - at < HOLD_MS) lastInTop.set(k, at);
  for (const k of fresh) lastInTop.set(k, now);

  const kept = same ? prev.top.filter((k) => freshSet.has(k) || lastInTop.has(k)) : [];
  const keptSet = new Set(kept);
  const joined = fresh.filter((k) => !keptSet.has(k)).slice(0, Math.max(0, n - kept.length));
  const top = [...kept, ...joined].sort((a, b) => (sums.get(b) ?? 0) - (sums.get(a) ?? 0) || (a < b ? -1 : 1));

  return { groupBy: by, windowS, rankedAt: now, top, lastInTop };
}

/**
 * One band per `top` key plus "other" (the tick total minus the top keys), so
 * each stack adds up to txKbps / rxKbps. A null point before every gap tick
 * breaks the areas.
 */
export function buildThroughput(
  ticks: readonly CompactTick[],
  by: GroupBy,
  top: readonly string[],
  slotOf: (key: string) => number = () => -1,
): Throughput {
  const index = new Map(top.map((k, i) => [k, i]));
  const labels = new Map<string, string>();
  /** Σ(tx + rx) and series key of each shown instance. */
  const perId = new Map<string, { sum: number; key: string }>();
  const tx: Point[][] = top.map(() => []);
  const rx: Point[][] = top.map(() => []);
  const otherTx: Point[] = [];
  const otherRx: Point[] = [];
  const totalTx: Point[] = [];
  const totalRx: Point[] = [];
  const all = [...tx, otherTx, totalTx];
  const allRx = [...rx, otherRx, totalRx];
  const sumTx = new Array<number>(top.length);
  const sumRx = new Array<number>(top.length);

  for (const t of ticks) {
    if (t.gap && totalTx.length) {
      for (const s of all) s.push([t.ts - 1, null]);
      for (const s of allRx) s.push([t.ts - 1, null]);
    }
    sumTx.fill(0);
    sumRx.fill(0);
    let topTx = 0;
    let topRx = 0;
    for (const p of t.procs) {
      const k = keyOf(p, by);
      const i = index.get(k);
      if (i === undefined) continue;
      sumTx[i]! += p.tx;
      sumRx[i]! += p.rx;
      topTx += p.tx;
      topRx += p.rx;
      const inst = perId.get(p.id);
      if (inst) inst.sum += p.tx + p.rx;
      else perId.set(p.id, { sum: p.tx + p.rx, key: k });
      if (!labels.has(k)) labels.set(k, by === 'name' ? p.name : `${p.name} (${pidOf(p.id)})`);
    }
    for (let i = 0; i < top.length; i++) {
      tx[i]!.push([t.ts, sumTx[i]!]);
      rx[i]!.push([t.ts, sumRx[i]! ? -sumRx[i]! : 0]);
    }
    const oRx = Math.max(0, t.rxKbps - topRx);
    otherTx.push([t.ts, Math.max(0, t.txKbps - topTx)]);
    otherRx.push([t.ts, oRx ? -oRx : 0]);
    totalTx.push([t.ts, t.txKbps]);
    totalRx.push([t.ts, t.rxKbps ? -t.rxKbps : 0]);
  }

  const instance = new Map<string, string>();
  const best = new Map<string, number>();
  for (const [id, { sum, key }] of perId) {
    if (sum > (best.get(key) ?? -1)) {
      best.set(key, sum);
      instance.set(key, id);
    }
  }

  const bands: Band[] = top.map((key, i) => ({
    key,
    label: labels.get(key) ?? (by === 'name' ? key : `${key} (${pidOf(key)})`),
    slot: slotOf(key),
    tx: tx[i]!,
    rx: rx[i]!,
  }));
  bands.push({ key: OTHER_KEY, label: 'other', slot: -1, tx: otherTx, rx: otherRx });
  return { bands, totalTx, totalRx, instance };
}

/**
 * The band under a chart position: the point nearest `ts`, then the stack on
 * the side of zero that `value` is on (tx above, rx below), skipping bands
 * whose label is hidden in the legend. Null outside every band or at a gap.
 */
export function bandAt(data: Throughput, ts: number, value: number, hidden: ReadonlySet<string> = new Set()): Band | null {
  const pts = data.totalTx;
  if (!pts.length) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]![0] < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && ts - pts[lo - 1]![0] < pts[lo]![0] - ts) lo--;
  const dir = value >= 0 ? 'tx' : 'rx';
  const want = Math.abs(value);
  let acc = 0;
  for (const b of data.bands) {
    if (hidden.has(b.label)) continue;
    const v = b[dir][lo]![1];
    if (v === null) return null;
    acc += Math.abs(v);
    if (want <= acc && v !== 0) return b;
  }
  return null;
}

/**
 * The ticks in (end - seconds, end], oldest first. `ticks` is sorted by ts.
 * Returns `prev` when the result would hold the same ticks, so a paused view
 * stays referentially stable while new ticks arrive after `end`.
 */
export function windowTicks(
  ticks: readonly CompactTick[],
  end: number,
  seconds: number,
  prev: readonly CompactTick[] | null = null,
): readonly CompactTick[] {
  let hi = ticks.length;
  while (hi > 0 && ticks[hi - 1]!.ts > end) hi--;
  let lo = hi;
  while (lo > 0 && ticks[lo - 1]!.ts > end - seconds * 1000) lo--;
  if (prev && prev.length === hi - lo && prev[0] === ticks[lo] && prev.at(-1) === ticks[hi - 1]) return prev;
  return lo === 0 && hi === ticks.length ? ticks : ticks.slice(lo, hi);
}

/**
 * Ranks and builds the chart's series from the (already windowed) ticks.
 * Colors come from the page's SlotAssigner so they survive ranking changes;
 * switching the grouping frees the slots of the old keys.
 */
export function useLiveThroughput(
  ticks: readonly CompactTick[],
  by: GroupBy,
  windowS: number,
  slots: SlotAssigner,
): Throughput & { rankedAt: number } {
  const state = useRef<RankState | null>(null);
  const assigned = useRef<{ by: GroupBy; keys: Set<string> }>({ by, keys: new Set() });

  const ranking = useMemo(() => {
    const r = rank(ticks, by, windowS, state.current);
    state.current = r;
    return r;
  }, [ticks, by, windowS]);

  return useMemo(() => {
    const mine = assigned.current;
    if (mine.by !== ranking.groupBy) {
      slots.release(mine.keys);
      assigned.current = { by: ranking.groupBy, keys: new Set() };
    }
    const slot = slots.assign(ranking.top);
    for (const k of ranking.top) assigned.current.keys.add(k);
    return { ...buildThroughput(ticks, by, ranking.top, (k) => slot.get(k) ?? -1), rankedAt: ranking.rankedAt };
  }, [ticks, by, ranking, slots]);
}
