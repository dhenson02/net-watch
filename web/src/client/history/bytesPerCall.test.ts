import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BPC_BUCKETS, type BytesPerCallRow } from '../../shared/api.ts';
import {
  BUCKET_TICKS,
  bucketRange,
  bucketTick,
  cellText,
  fmtShare,
  heatCells,
  heatRows,
  medianOf,
  medianX,
  parseBpcBy,
  parseBpcDir,
  rowLabel,
  shares,
} from './bytesPerCall.ts';

function hist(key: string | null, cells: Record<number, [number, number]>): BytesPerCallRow {
  const calls = new Array<number>(BPC_BUCKETS).fill(0);
  const bytes = new Array<number>(BPC_BUCKETS).fill(0);
  for (const [b, [c, y]] of Object.entries(cells)) {
    calls[Number(b)] = c;
    bytes[Number(b)] = y;
  }
  return { key, calls, bytes, totalCalls: calls.reduce((a, v) => a + v, 0), totalBytes: bytes.reduce((a, v) => a + v, 0) };
}

test('URL params: tx and app by default', () => {
  assert.equal(parseBpcDir(null), 'tx');
  assert.equal(parseBpcDir('rx'), 'rx');
  assert.equal(parseBpcDir('bogus'), 'tx');
  assert.equal(parseBpcBy(null), 'app');
  assert.equal(parseBpcBy('name'), 'name');
});

test('bucket labels: ticks from 1 B to 1 MiB+, ranges in one unit where they can', () => {
  assert.equal(BUCKET_TICKS.length, BPC_BUCKETS);
  assert.deepEqual([bucketTick(0), bucketTick(1), bucketTick(9), bucketTick(10), bucketTick(19), bucketTick(20)], ['1 B', '2 B', '512 B', '1 KiB', '512 KiB', '1 MiB+']);
  assert.equal(bucketRange(0), 'under 2 B');
  assert.equal(bucketRange(1), '2–4 B');
  assert.equal(bucketRange(9), '512 B–1 KiB');
  assert.equal(bucketRange(10), '1–2 KiB');
  assert.equal(bucketRange(19), '512 KiB–1 MiB');
  assert.equal(bucketRange(20), '1 MiB or more');
});

test('rowLabel: all, keys and the folded rest', () => {
  assert.equal(rowLabel({ key: '' }, 'app', 0), 'all');
  assert.equal(rowLabel({ key: 'HTTPS' }, 'app', 0), 'HTTPS');
  assert.equal(rowLabel({ key: null }, 'app', 3), 'other (3 apps)');
  assert.equal(rowLabel({ key: null }, 'name', 1), 'other (1 process)');
});

test('shares and the tooltip text: calls and bytes shares apart', () => {
  const https = hist('HTTPS', { 6: [66, 66 * 64], 10: [34, 34 * 1500] });
  const s = shares(https);
  assert.equal(s.calls[6], 0.66);
  assert.ok(Math.abs(s.bytes[10]! - 51_000 / (51_000 + 4224)) < 1e-12);
  assert.equal(cellText('HTTPS', https, 10), 'HTTPS · 1–2 KiB per call · 34 % of calls · 92 % of bytes');
  const empty = hist('x', {});
  assert.ok(shares(empty).calls.every((v) => v === 0));
});

test('fmtShare', () => {
  assert.deepEqual([0, 0.0004, 0.024, 0.34, 1].map(fmtShare), ['0 %', '<0.1 %', '2.4 %', '34 %', '100 %']);
});

test('heatRows and heatCells: an "all" row over several keys, cells only where there are calls', () => {
  const a = hist('A', { 3: [3, 30], 5: [1, 40] });
  const b = hist('B', { 5: [2, 80] });
  const total = hist('', { 3: [3, 30], 5: [3, 120] });
  assert.deepEqual(heatRows({ total, rows: [a, b] }).map((r) => r.key), ['', 'A', 'B']);
  assert.deepEqual(heatRows({ total, rows: [a] }).map((r) => r.key), ['A']);
  assert.deepEqual(heatRows({ total, rows: [] }), []);
  const { data, max } = heatCells([a, b]);
  assert.deepEqual(data, [
    [3, 0, 0.75],
    [5, 0, 0.25],
    [5, 1, 1],
  ]);
  assert.equal(max, 1);
});

test('medianOf: calls-weighted, log-interpolated inside its bucket', () => {
  assert.equal(medianOf(new Array(BPC_BUCKETS).fill(0)), null);
  // All in bucket 10: half way in → 2^10.5.
  const one = medianOf(hist('', { 10: [10, 0] }).calls)!;
  assert.deepEqual([one.bucket, one.frac], [10, 0.5]);
  assert.ok(Math.abs(one.bytes - 2 ** 10.5) < 1e-9);
  // 60 keepalives at 64 B and 40 bulk calls: the median lies among the small ones.
  const m = medianOf(hist('', { 6: [60, 0], 16: [40, 0] }).calls)!;
  assert.equal(m.bucket, 6);
  assert.ok(Math.abs(m.frac - 50 / 60) < 1e-12);
  // Exactly at a bucket edge: the end of the lower bucket.
  const edge = medianOf(hist('', { 2: [5, 0], 4: [5, 0] }).calls)!;
  assert.deepEqual([edge.bucket, edge.frac], [2, 1]);
  assert.equal(medianX({ bucket: 6, frac: 0.5 }), 6);
  assert.equal(medianX({ bucket: 6, frac: 0 }), 5.5);
});
