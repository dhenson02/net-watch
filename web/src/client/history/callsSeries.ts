// Bytes vs calls (14): the pure part of the calls panel. Its input comes
// from a throughput answer requested with `calls=1` (History) or from
// /api/process/:pid/:start/calls (Process page), whose ProcessCallsResponse
// is a CallsData as it is.
import type { ProcessInfo, ThroughputCalls, ThroughputResponse } from '../../shared/api.ts';
import type { TimeRange } from '../api.ts';

/** Totals per bucket: kbps and calls per second, aligned with `t`. */
export interface CallsData {
  step: number;
  from: number;
  to: number;
  t: number[];
  tx: number[];
  rx: number[];
  calls: ThroughputCalls;
}

/** The History page's URL param opening the panel (closed by default). */
export const CALLS_PARAM = 'calls';

export function parseCallsParam(search: string): boolean {
  return new URLSearchParams(search).get(CALLS_PARAM) === '1';
}

/** A throughput answer's totals over every key, or null when it was asked without `calls=1`. */
export function fromThroughput(a: ThroughputResponse): CallsData | null {
  if (!a.calls) return null;
  const sum = (m: Record<string, number[]>) => {
    const out = new Array<number>(a.t.length).fill(0);
    for (const k of a.keys) m[k]?.forEach((v, i) => (out[i]! += v));
    return out.map((v) => Math.round(v * 1000) / 1000);
  };
  return { step: a.step, from: a.from, to: a.to, t: a.t, tx: sum(a.tx), rx: sum(a.rx), calls: a.calls };
}

/** Mean payload bytes per call from kbps and calls/s; null without calls or bytes (a log axis has no 0). */
export function bytesPerCall(kbps: number, perSec: number): number | null {
  if (!(perSec > 0) || !(kbps > 0)) return null;
  return (kbps * 125) / perSec;
}

type Pt = [number, number | null];

/**
 * The points of the three panels: bytes and calls mirrored (tx above zero, rx
 * below), bytes per call per direction (both positive, for the log axis).
 * Every series has every bucket, so a data index is a bucket in each.
 */
export function callsPoints(d: CallsData): {
  bytes: { tx: Pt[]; rx: Pt[] };
  calls: { tx: Pt[]; rx: Pt[] };
  perCall: { tx: Pt[]; rx: Pt[] };
} {
  const pts = (f: (i: number) => number | null): Pt[] => d.t.map((t, i) => [t, f(i)]);
  const neg = (v: number) => (v ? -v : 0);
  return {
    bytes: { tx: pts((i) => d.tx[i]!), rx: pts((i) => neg(d.rx[i]!)) },
    calls: { tx: pts((i) => d.calls.tx[i]!), rx: pts((i) => neg(d.calls.rx[i]!)) },
    perCall: { tx: pts((i) => bytesPerCall(d.tx[i]!, d.calls.tx[i]!)), rx: pts((i) => bytesPerCall(d.rx[i]!, d.calls.rx[i]!)) },
  };
}

/**
 * Line data with a dot on each point between two gaps (or an edge), which a
 * line alone would not draw.
 */
export function dotIsolated(pts: readonly Pt[]): { value: Pt; symbol?: string }[] {
  const v = (i: number) => pts[i]?.[1] ?? null;
  return pts.map((p, i) => (p[1] !== null && v(i - 1) === null && v(i + 1) === null ? { value: p, symbol: 'circle' } : { value: p }));
}

/** Whether any bucket had traffic. */
export const hasTraffic = (d: CallsData) => d.tx.some((v) => v > 0) || d.rx.some((v) => v > 0) || d.calls.tx.some((v) => v > 0) || d.calls.rx.some((v) => v > 0);

/** A call rate: "12.5/s", "3/min" or "2/h" below one a minute, "0" for none. */
export function fmtCalls(perSec: number): string {
  const v = Math.abs(perSec);
  if (v === 0) return '0';
  // Three significant digits at most, trailing zeros dropped: 42/s, 12.3/s, 2.5/s.
  const n = (x: number) => {
    const t = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(2);
    return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
  };
  if (v >= 1) return `${n(v)}/s`;
  if (v * 60 >= 1) return `${n(v * 60)}/min`;
  return `${n(v * 3600)}/h`;
}

/**
 * The Process page's window: the instance's traffic (first to last network
 * I/O, or its end), padded by 2 % on both sides, at least a minute, and never
 * past `now`.
 */
export function processCallsRange(p: Pick<ProcessInfo, 'first_seen_ms' | 'last_seen_ms' | 'ended_ms'>, now: number): TimeRange {
  const end = Math.max(p.first_seen_ms, p.ended_ms ?? p.last_seen_ms);
  const span = end - p.first_seen_ms;
  const pad = Math.max(5_000, span * 0.02, (60_000 - span) / 2);
  const to = Math.min(now, Math.round(end + pad));
  const from = Math.round(Math.min(p.first_seen_ms - pad, to - 60_000));
  return { from, to };
}
