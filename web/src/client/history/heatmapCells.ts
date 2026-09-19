// Pure logic of the hour × weekday heatmap (06): URL params, the heatmap's own
// window, cell data on a log scale, labels, and the click target (the most
// recent occurrence of a weekday-hour).
import type { HeatmapGrid, HeatmapMetric, HeatmapSplit } from '../../shared/api.ts';

export const METRIC_PARAM = 'heat_metric';
export const SPLIT_PARAM = 'heat_split';
export const WEEKS_PARAM = 'heat_weeks';

export const WEEKS_VALUES = ['1', '4', '12'] as const;
export type HeatWeeks = (typeof WEEKS_VALUES)[number];

export const parseMetric = (raw: string | null): HeatmapMetric => (raw === 'tx' || raw === 'rx' ? raw : 'total');
export const parseSplit = (raw: string | null): HeatmapSplit => (raw === 'app' ? 'app' : 'none');
export const parseWeeks = (raw: string | null): HeatWeeks => ((WEEKS_VALUES as readonly string[]).includes(raw ?? '') ? (raw as HeatWeeks) : '4');

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

const HOUR = 3600_000;
const WEEK = 7 * 24 * HOUR;

/**
 * The heatmap's window: `weeks` whole weeks ending at the start of the hour
 * `now` falls in, so the URL (and the query) stays the same while the page is
 * open, and every cell gets `weeks` samples. Independent of the page range,
 * which a cell click narrows to one hour.
 */
export function heatWindow(weeks: number, now: number): { from: number; to: number } {
  const to = Math.floor(now / HOUR) * HOUR;
  return { from: to - weeks * WEEK, to };
}

/** The visualMap's value: log10(kbps + 1), since traffic spans several orders of magnitude. */
export const toLog = (kbps: number) => Math.log10(kbps + 1);
/** Back from toLog. */
export const fromLog = (v: number) => Math.max(0, 10 ** v - 1);

/**
 * Heatmap items `[hour, dow, log value, cell]` for the cells with samples
 * (cells without are left out, drawn empty) and the largest log value (at
 * least toLog(1), so an idle grid still has a scale).
 */
export function heatData(grid: HeatmapGrid): { data: [number, number, number, number][]; max: number } {
  const data: [number, number, number, number][] = [];
  let max = toLog(1);
  grid.kbps.forEach((v, i) => {
    if (v === null) return;
    const l = toLog(v);
    if (l > max) max = l;
    data.push([i % 24, Math.floor(i / 24), l, i]);
  });
  return { data, max };
}

/** "Tue 03:00–04:00" for a cell. */
export function cellLabel(cell: number): string {
  const h = cell % 24;
  return `${DAYS[Math.floor(cell / 24)]} ${HOURS[h]}:00–${h === 23 ? '24' : HOURS[h + 1]}:00`;
}

/** "4 weeks", "1 week": the cell's sample count, one per week. */
export const samplesText = (n: number) => `${n} week${n === 1 ? '' : 's'}`;

const fmts = new Map<string, Intl.DateTimeFormat>();
const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Weekday (0 = Monday), hour and minute of `t` in `tz`. */
function local(t: number, tz: string): { dow: number; hour: number; minute: number } {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmts.set(tz, f);
  }
  const out = { dow: -1, hour: -1, minute: -1 };
  for (const p of f.formatToParts(t)) {
    if (p.type === 'weekday') out.dow = DOW[p.value] ?? -1;
    else if (p.type === 'hour') out.hour = Number(p.value) % 24;
    else if (p.type === 'minute') out.minute = Number(p.value);
  }
  return out;
}

/**
 * The most recent whole occurrence of a cell's weekday-hour in `tz` that
 * ends by `before`: `{from, to}` one hour apart, or null if there is none in
 * the last 8 days (an hour a DST change skips). Every UTC offset is a
 * multiple of 15 minutes, so local hour starts lie on 15-minute steps.
 */
export function lastOccurrence(cell: number, before: number, tz: string): { from: number; to: number } | null {
  const dow = Math.floor(cell / 24);
  const hour = cell % 24;
  const Q = 15 * 60_000;
  for (let t = Math.floor((before - HOUR) / Q) * Q, stop = before - 8 * 24 * HOUR; t > stop; t -= Q) {
    const l = local(t, tz);
    if (l.minute === 0 && l.hour === hour && l.dow === dow) return { from: t, to: t + HOUR };
  }
  return null;
}

/** Days the covered part of the window spans; under 7 some cells have no or a single sample. */
export function coveredDays(from: number, to: number, coveredFrom: number | null): number {
  const start = coveredFrom === null ? to : Math.max(from, coveredFrom);
  return Math.max(0, to - start) / (24 * HOUR);
}
