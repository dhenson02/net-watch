// Process lifetime Gantt (09): the pure layout. Instances are grouped into one
// lane per process name; instances of a name that overlap in time get their
// own sub-rows (greedy interval partitioning, the fewest rows possible).
import type { LifetimeBar } from '../../shared/api.ts';

export type GanttSort = 'start' | 'bytes';
/** URL param: `gantt_sort=bytes` orders lanes by total bytes; default by first start. */
export const SORT_PARAM = 'gantt_sort';

export function parseSort(raw: string | null): GanttSort {
  return raw === 'bytes' ? 'bytes' : 'start';
}

/**
 * Where a bar ends on the chart: its end, else now (a running process), never
 * before its first or last I/O. The collector can record an end a little
 * before the first I/O of a short-lived process (clock granularity).
 */
export function barEnd(b: LifetimeBar, now: number): number {
  return Math.max(b.endedMs ?? now, b.firstSeenMs, b.lastSeenMs);
}

/**
 * Sub-row per interval (in input order) so that no two intervals in a row
 * overlap. Intervals that merely touch (end == start) may share a row.
 * Greedy by start time: each goes into the free row with the lowest index,
 * which uses the fewest rows (the maximum overlap).
 */
export function subRows(intervals: readonly { start: number; end: number }[]): number[] {
  const order = intervals.map((_, i) => i).sort((a, b) => intervals[a]!.start - intervals[b]!.start || a - b);
  const rowEnd: number[] = [];
  const out = new Array<number>(intervals.length);
  for (const i of order) {
    const { start, end } = intervals[i]!;
    let row = rowEnd.findIndex((e) => e <= start);
    if (row < 0) row = rowEnd.push(end) - 1;
    else rowEnd[row] = end;
    out[i] = row;
  }
  return out;
}

export interface LaneStats {
  /** Instances in the lane. */
  n: number;
  /** Ended instances, the ones the median counts. */
  ended: number;
  /** Median of start → end over the ended instances; null when none ended. */
  medianLifetimeMs: number | null;
  /** Mean gap between consecutive starts; null with fewer than 2 instances. */
  meanGapMs: number | null;
  /** Coefficient of variation (std / mean) of the start gaps; null with fewer than 3 instances. */
  gapCv: number | null;
  /** n ≥ 5 and CV < 0.1: starts on a schedule, every `meanGapMs`. */
  scheduled: boolean;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The lane tooltip's pattern callouts. */
export function laneStats(bars: readonly LifetimeBar[]): LaneStats {
  const lifetimes = bars.filter((b) => b.endedMs !== null).map((b) => barEnd(b, 0) - b.startMs);
  const starts = bars.map((b) => b.startMs).sort((a, b) => a - b);
  const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
  let cv: number | null = null;
  if (gaps.length >= 2 && mean !== null && mean > 0) {
    const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
    cv = Math.sqrt(variance) / mean;
  }
  return {
    n: bars.length,
    ended: lifetimes.length,
    medianLifetimeMs: median(lifetimes),
    meanGapMs: mean,
    gapCv: cv,
    scheduled: bars.length >= 5 && cv !== null && cv < 0.1,
  };
}

export interface Lane {
  name: string;
  /** The lane's instances, by start. */
  bars: LifetimeBar[];
  /** Index of the lane's first row among all rows. */
  row0: number;
  /** Sub-rows the lane needs (1 when no instances overlap). */
  rows: number;
  /** Sum of the instances' lifetime totals. */
  bytes: number;
  firstStart: number;
  stats: LaneStats;
}

export interface PackedBar {
  bar: LifetimeBar;
  /** Row among all rows (lane row0 + sub-row). */
  row: number;
  lane: number;
  /** Chart end (see barEnd). */
  end: number;
}

export interface Packed {
  lanes: Lane[];
  /** Every bar with its row, lanes in order. */
  bars: PackedBar[];
  /** Total rows. */
  rows: number;
}

/**
 * Groups `bars` into lanes by name, sorts the lanes (first start, or total
 * bytes descending; ties by name) and gives every bar a row.
 */
export function packLanes(bars: readonly LifetimeBar[], sort: GanttSort, now: number): Packed {
  const byName = new Map<string, LifetimeBar[]>();
  for (const b of bars) {
    let l = byName.get(b.name);
    if (!l) byName.set(b.name, (l = []));
    l.push(b);
  }
  const lanes: Lane[] = [...byName].map(([name, list]) => {
    list.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
    return {
      name,
      bars: list,
      row0: 0,
      rows: 0,
      bytes: list.reduce((s, b) => s + b.tx + b.rx, 0),
      firstStart: list[0]!.startMs,
      stats: laneStats(list),
    };
  });
  const byNameCmp = (a: Lane, b: Lane) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  lanes.sort(sort === 'bytes' ? (a, b) => b.bytes - a.bytes || byNameCmp(a, b) : (a, b) => a.firstStart - b.firstStart || byNameCmp(a, b));

  const out: PackedBar[] = [];
  let row = 0;
  lanes.forEach((lane, li) => {
    const ends = lane.bars.map((b) => barEnd(b, now));
    const sub = subRows(lane.bars.map((b, i) => ({ start: b.startMs, end: ends[i]! })));
    lane.row0 = row;
    lane.rows = Math.max(...sub) + 1;
    lane.bars.forEach((bar, i) => out.push({ bar, row: row + sub[i]!, lane: li, end: ends[i]! }));
    row += lane.rows;
  });
  return { lanes, bars: out, rows: row };
}

/** "cron-backup ×48"; a single instance is just the name. */
export function laneLabel(lane: Pick<Lane, 'name' | 'bars'>): string {
  return lane.bars.length > 1 ? `${lane.name} ×${lane.bars.length}` : lane.name;
}

/** The color scale's value: log10 of the lifetime bytes (0 for 0 or 1 byte). */
export function logBytes(bytes: number): number {
  return Math.log10(Math.max(1, bytes));
}

/** The visualMap's [min, max] over `values`, never empty (a single value gets a unit span). */
export function colorExtent(values: readonly number[]): [number, number] {
  if (!values.length) return [0, 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return hi > lo ? [lo, hi] : [Math.max(0, lo - 0.5), lo + 0.5];
}
