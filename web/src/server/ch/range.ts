import type { RangeInfo } from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MAX_SPAN = 2 * 366 * DAY;
const MAX_POINTS = 1500;
const DEFAULT_SPAN = HOUR;

/** Bucket widths (s) a step is rounded up to, so buckets land on round times. */
const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];

export interface Range extends RangeInfo {
  /** Time column of `table`. Fixed per table, never taken from input. */
  col: 'ts' | 'minute';
}

function intParam(q: Record<string, unknown>, name: string, min = 0): number | undefined {
  const raw = q[name];
  if (raw === undefined || raw === '') return undefined;
  const n = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < min) throw badRequest(`${name}: expected an integer >= ${min}`);
  return n;
}

function defaultStep(span: number): number {
  if (span <= 2 * HOUR) return 10;
  if (span <= 3 * DAY) return 60;
  if (span <= 30 * DAY) return 900;
  return 3600;
}

/**
 * Parses `from`, `to` (ms since epoch) and `step` (s) from a query string.
 * Missing `to` means now, missing `from` means one hour before `to`. The span
 * is clamped to two years and the step raised so there are at most ~1500
 * buckets. Spans up to 2 h read raw `flows`; longer ones read `flows_1m`,
 * whose steps are whole minutes.
 */
export function parseRange(q: Record<string, unknown>, now = Date.now()): Range {
  const to = intParam(q, 'to') ?? now;
  let from = intParam(q, 'from') ?? to - DEFAULT_SPAN;
  if (from >= to) throw badRequest('from must be before to');
  from = Math.max(from, to - MAX_SPAN);

  const span = to - from;
  const raw = span <= 2 * HOUR;
  const minStep = Math.max(raw ? 1 : 60, Math.ceil(span / 1000 / MAX_POINTS));
  const wanted = Math.max(intParam(q, 'step', 1) ?? defaultStep(span), minStep);
  let step = NICE_STEPS.find((s) => s >= wanted) ?? Math.ceil(wanted / 86400) * 86400;
  if (!raw) step = Math.ceil(step / 60) * 60;

  return raw ? { from, to, step, table: 'flows', col: 'ts' } : { from, to, step, table: 'flows_1m', col: 'minute' };
}

/** The part of a Range that responses echo back. */
export const rangeInfo = ({ from, to, step, table }: Range): RangeInfo => ({ from, to, step, table });

/** `query_params` for the fragments below. */
export const rangeParams = (r: Range) => ({ from: r.from, to: r.to, step: r.step });

/** WHERE condition selecting the range: `{from}` inclusive, `{to}` exclusive. */
export function timeFilter(r: Range): string {
  return r.col === 'ts'
    ? 'ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})'
    : 'minute >= toDateTime(intDiv({from:Int64}, 1000)) AND minute < toDateTime(intDiv({to:Int64}, 1000))';
}

/**
 * Bucket start as UInt32 seconds. (A 64-bit ms value would arrive as a JSON
 * string; multiply by 1000 in JS.)
 */
export function bucketSeconds(r: Range): string {
  return `toUnixTimestamp(toStartOfInterval(${r.col}, INTERVAL {step:UInt32} SECOND))`;
}
