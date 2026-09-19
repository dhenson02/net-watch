// Bytes-per-call distribution (10): URL state, bucket labels, per-row shares,
// the weighted median and the tooltip text. Pure, so node --test covers it.
import { BPC_BUCKETS, type BytesPerCallBy, type BytesPerCallDir, type BytesPerCallResponse, type BytesPerCallRow } from '../../shared/api.ts';

export const BPC_DIR_PARAM = 'bpc_dir';
export const BPC_BY_PARAM = 'bpc_by';

export const parseBpcDir = (raw: string | null): BytesPerCallDir => (raw === 'rx' ? 'rx' : 'tx');
export const parseBpcBy = (raw: string | null): BytesPerCallBy => (raw === 'name' ? 'name' : 'app');

/** A power of two in bytes, short: 512 → "512 B", 2048 → "2 KiB". */
function pow2(b: number): string {
  if (b < 10) return `${2 ** b} B`;
  if (b < 20) return `${2 ** (b - 10)} KiB`;
  return `${2 ** (b - 20)} MiB`;
}

const unitOf = (b: number) => (b < 10 ? 0 : b < 20 ? 1 : 2);

/** Axis label of a bucket: its lower bound, the last one open-ended ("1 MiB+"). */
export function bucketTick(b: number): string {
  return b >= BPC_BUCKETS - 1 ? `${pow2(b)}+` : pow2(b);
}

/** The bucket's range: "1–2 KiB", "512 B–1 KiB", "under 2 B", "1 MiB or more". */
export function bucketRange(b: number): string {
  if (b <= 0) return 'under 2 B';
  if (b >= BPC_BUCKETS - 1) return `${pow2(b)} or more`;
  const lo = pow2(b);
  const hi = pow2(b + 1);
  return unitOf(b) === unitOf(b + 1) ? `${lo.replace(/ .*/, '')}–${hi}` : `${lo}–${hi}`;
}

/** All bucket ticks, for a category axis. */
export const BUCKET_TICKS: readonly string[] = Array.from({ length: BPC_BUCKETS }, (_, b) => bucketTick(b));

/** A row's name: '' is every key, null the folded rest. */
export function rowLabel(row: Pick<BytesPerCallRow, 'key'>, by: BytesPerCallBy, folded: number): string {
  if (row.key === '') return 'all';
  if (row.key === null) return `other (${folded} ${by === 'app' ? (folded === 1 ? 'app' : 'apps') : folded === 1 ? 'process' : 'processes'})`;
  return row.key;
}

/** Per bucket, the share (0..1) of the row's calls and of its bytes; 0 everywhere for an empty row. */
export function shares(row: BytesPerCallRow): { calls: number[]; bytes: number[] } {
  const c = row.totalCalls;
  const b = row.totalBytes;
  return { calls: row.calls.map((v) => (c > 0 ? v / c : 0)), bytes: row.bytes.map((v) => (b > 0 ? v / b : 0)) };
}

/** The heatmap's rows, top to bottom: every key summed ("all"), then the keys, then the rest. */
export function heatRows(d: Pick<BytesPerCallResponse, 'total' | 'rows'>): BytesPerCallRow[] {
  return d.rows.length > 1 || d.rows[0]?.key === null ? [d.total, ...d.rows] : [...d.rows];
}

/**
 * Heatmap cells `[bucket, row, share of the row's calls]`, only where the row
 * has calls, and the largest share (the color scale's top).
 */
export function heatCells(rows: readonly BytesPerCallRow[]): { data: [number, number, number][]; max: number } {
  const data: [number, number, number][] = [];
  let max = 0;
  rows.forEach((row, y) => {
    const s = shares(row).calls;
    for (let b = 0; b < BPC_BUCKETS; b++) {
      if (!(row.calls[b]! > 0)) continue;
      data.push([b, y, s[b]!]);
      if (s[b]! > max) max = s[b]!;
    }
  });
  return { data, max };
}

/**
 * The calls-weighted median, interpolated on the log scale inside its bucket:
 * `bucket`, how far into it (`frac`, 0..1) and the bytes (2^(bucket + frac)).
 * Null without calls.
 */
export function medianOf(calls: readonly number[]): { bucket: number; frac: number; bytes: number } | null {
  const total = calls.reduce((a, v) => a + v, 0);
  if (!(total > 0)) return null;
  const half = total / 2;
  let before = 0;
  for (let b = 0; b < calls.length; b++) {
    const n = calls[b]!;
    if (n > 0 && before + n >= half) {
      const frac = Math.min(1, Math.max(0, (half - before) / n));
      return { bucket: b, frac, bytes: 2 ** (b + frac) };
    }
    before += n;
  }
  return null;
}

/**
 * The median's x on a category axis whose band `b` spans `b - 0.5 .. b + 0.5`
 * (ECharts places category index b at the band's centre).
 */
export const medianX = (m: { bucket: number; frac: number }) => m.bucket - 0.5 + m.frac;

/** A share as a percentage: "34 %", "2.4 %", "<0.1 %", "0 %". */
export function fmtShare(s: number): string {
  if (!(s > 0)) return '0 %';
  const p = s * 100;
  if (p < 0.1) return '<0.1 %';
  if (p < 10) return `${p.toFixed(1)} %`;
  return `${Math.round(p)} %`;
}

/** "HTTPS · 1–2 KiB per call · 34 % of calls · 2 % of bytes". */
export function cellText(label: string, row: BytesPerCallRow, b: number): string {
  const s = shares(row);
  return `${label} · ${bucketRange(b)} per call · ${fmtShare(s.calls[b]!)} of calls · ${fmtShare(s.bytes[b]!)} of bytes`;
}

/** The footnote's caveat: what one sample of the histogram is. */
export function meanNote(table: 'flows' | 'flows_1m'): string {
  return table === 'flows'
    ? 'each flow-tick adds its mean bytes per call (raw flows), weighted by its calls: a distribution of per-tick means, not of single calls'
    : 'each flow-minute adds its mean bytes per call (per-minute rollup), weighted by its calls: a distribution of per-flow-minute means, not of single calls';
}
