// History throughput (05), the pure part: URL params, drill-down, colors and
// series building (mirroring, totals). No DOM, so node --test covers it; the
// hooks are in useThroughput.ts.
import { THROUGHPUT_OTHER, type ThroughputBy, type ThroughputDir, type ThroughputResponse } from '../../shared/api.ts';
import type { Point, Stack } from '../charts/mirroredStack.ts';
import { CATEGORICAL, slotColor, SLOTS, type Scheme } from '../charts/palette.ts';

export const BY_VALUES: readonly ThroughputBy[] = ['app', 'name', 'proto', 'uid', 'dest'];
export const DIR_VALUES: readonly ThroughputDir[] = ['both', 'tx', 'rx', 'total'];
export const TOP_DEFAULT = 8;
export const TOP_MIN = 5;
export const TOP_MAX = 20;

/** Page-level filters, `?filter.<dim>=value` (exact match). Every dimension can be one. */
export type Filters = Partial<Record<ThroughputBy, string>>;
export const filterParam = (dim: ThroughputBy) => `filter.${dim}`;

/** The dimension a double-click drills into (app → name → dest; dest → name). */
export const DRILL_NEXT: Record<ThroughputBy, ThroughputBy> = { app: 'name', name: 'dest', dest: 'name', proto: 'app', uid: 'name' };

export interface ThroughputParams {
  by: ThroughputBy;
  dir: ThroughputDir;
  top: number;
  filters: Filters;
}

/** Reads `by`, `dir`, `top` and `filter.*` from a query string; bad values fall back to the defaults. */
export function parseThroughputParams(search: string): ThroughputParams {
  const q = new URLSearchParams(search);
  const by = q.get('by');
  const dir = q.get('dir');
  const top = Number(q.get('top'));
  const filters: Filters = {};
  for (const d of BY_VALUES) {
    const v = q.get(filterParam(d));
    if (v) filters[d] = v;
  }
  if (filters.uid !== undefined && !/^\d+$/.test(filters.uid)) delete filters.uid;
  return {
    by: BY_VALUES.includes(by as ThroughputBy) ? (by as ThroughputBy) : 'app',
    dir: DIR_VALUES.includes(dir as ThroughputDir) ? (dir as ThroughputDir) : 'both',
    top: Number.isInteger(top) && top >= TOP_MIN && top <= TOP_MAX ? top : TOP_DEFAULT,
    filters,
  };
}

/**
 * The URL patch for a double-click on `key`: filter to it and group by the
 * next dimension (DRILL_NEXT, or else the first one not filtered yet; with
 * none left, `by` stays). Null for "other", which is not one key.
 */
export function drillDown(p: ThroughputParams, key: string): Record<string, string | null> | null {
  if (key === THROUGHPUT_OTHER) return null;
  const filters = { ...p.filters, [p.by]: key };
  let next: ThroughputBy | undefined = DRILL_NEXT[p.by];
  if (filters[next] !== undefined) next = BY_VALUES.find((d) => filters[d] === undefined);
  const patch: Record<string, string | null> = { [filterParam(p.by)]: key };
  if (next !== undefined) patch.by = next === 'app' ? null : next;
  return patch;
}

/** The label a key is shown under. */
export function keyLabel(key: string, labels: Record<string, string>): string {
  return key === THROUGHPUT_OTHER ? 'other' : (labels[key] ?? key);
}

/** The stacks a direction draws: both mirrors rx below tx. */
export function stacksOf(dir: ThroughputDir): Stack[] {
  return dir === 'both' ? ['tx', 'rx'] : dir === 'total' ? ['sum'] : [dir];
}

export interface HistoryBand {
  key: string;
  label: string;
  color: string;
  /** Past the palette: a reused hue with a lighter fill. */
  faded: boolean;
  /** Points per drawn stack; rx is negative when mirrored. */
  data: Partial<Record<Stack, Point[]>>;
}

export interface HistorySeries {
  stacks: Stack[];
  bands: HistoryBand[];
  totals: Partial<Record<Stack, Point[]>>;
  /** Legend label → key, for legend events. */
  keyOf: Map<string, string>;
}

/**
 * Colors per key: its slot's hue, grey for "other". Keys with no slot take
 * the hues no slotted key here uses; past that the palette repeats with a
 * lighter fill, so up to 20 bands stay tellable apart with the legend and
 * tooltip.
 */
export function bandColors(keys: readonly string[], slotOf: ReadonlyMap<string, number>, scheme: Scheme): Map<string, { color: string; faded: boolean }> {
  const out = new Map<string, { color: string; faded: boolean }>();
  const slotted = (k: string) => {
    const slot = k === THROUGHPUT_OTHER ? -1 : (slotOf.get(k) ?? -1);
    return slot >= 0 && slot < SLOTS ? slot : -1;
  };
  // Hues not taken by a slotted key in this chart go first, then the rest in order.
  const taken = new Set(keys.map(slotted).filter((s) => s >= 0));
  const spare = [...Array(SLOTS).keys()].sort((a, b) => Number(taken.has(a)) - Number(taken.has(b)) || a - b);
  let extra = 0;
  for (const k of keys) {
    const slot = slotted(k);
    if (slot >= 0) out.set(k, { color: slotColor(slot, scheme), faded: false });
    else if (k === THROUGHPUT_OTHER) out.set(k, { color: slotColor(-1, scheme), faded: false });
    else {
      const i = extra++;
      // A spare hue is used at full strength; reuse (more keys than hues) is faded.
      out.set(k, { color: CATEGORICAL[scheme][spare[i % SLOTS]!]!, faded: i >= SLOTS - taken.size });
    }
  }
  return out;
}

/**
 * The response as chart series for `dir`: one band per key (in rank order,
 * "other" last) with [t, kbps] points, rx negated when mirrored, `total`
 * summing tx + rx; and the per-stack totals.
 */
export function buildSeries(
  res: ThroughputResponse,
  dir: ThroughputDir,
  colors: ReadonlyMap<string, { color: string; faded: boolean }>,
): HistorySeries {
  const stacks = stacksOf(dir);
  const n = res.t.length;
  const values = (key: string, stack: Stack): number[] => {
    const tx = res.tx[key] ?? [];
    const rx = res.rx[key] ?? [];
    if (stack === 'tx') return tx;
    if (stack === 'rx') return dir === 'both' ? rx.map((v) => (v ? -v : 0)) : rx;
    return tx.map((v, i) => v + (rx[i] ?? 0));
  };
  const totals: Partial<Record<Stack, Point[]>> = {};
  const sums = Object.fromEntries(stacks.map((s) => [s, new Array<number>(n).fill(0)])) as Partial<Record<Stack, number[]>>;
  const keyOf = new Map<string, string>();
  const bands = res.keys.map((key) => {
    const label = keyLabel(key, res.labels);
    keyOf.set(label, key);
    const data: Partial<Record<Stack, Point[]>> = {};
    for (const s of stacks) {
      const v = values(key, s);
      const sum = sums[s]!;
      data[s] = res.t.map((t, i) => {
        sum[i]! += v[i] ?? 0;
        return [t, v[i] ?? 0];
      });
    }
    const c = colors.get(key) ?? { color: '#898781', faded: false };
    return { key, label, color: c.color, faded: c.faded, data };
  });
  for (const s of stacks) totals[s] = res.t.map((t, i) => [t, Math.round(sums[s]![i]! * 1000) / 1000]);
  return { stacks, bands, totals, keyOf };
}

