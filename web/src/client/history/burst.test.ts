import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BurstResponse } from '../../shared/api.ts';
import { fmtRate } from '../charts/format.ts';
import { bandSpanOk, BURST_ID, burstAt, burstRatio, burstSeries, burstText, fmtRatio, parseBandParam, sideOf } from './burst.ts';

const M = 60_000;
const res = (over: Partial<BurstResponse> = {}): BurstResponse => ({
  step: 60,
  from: 0,
  to: 3 * M,
  dir: 'both',
  t: [0, M, 2 * M],
  tx: { mean: [10, 0, 5], p95: [40, 0, 2], max: [90, 0, 30] },
  rx: { mean: [1, 2, 0], p95: [3, 2, 0], max: [8, 4, 0] },
  ...over,
});

type S = { id: string; stack?: string; data: [number, number][] };

test('parseBandParam: band=1 only', () => {
  assert.equal(parseBandParam(''), false);
  assert.equal(parseBandParam('?band=1'), true);
  assert.equal(parseBandParam('?by=name&band=0'), false);
  assert.equal(parseBandParam('?band=yes'), false);
});

test('bandSpanOk: up to 24 h', () => {
  assert.ok(bandSpanOk({ from: 0, to: 86_400_000 }));
  assert.ok(!bandSpanOk({ from: 0, to: 86_400_001 }));
});

test('sideOf: the sum stack reads the total', () => {
  assert.equal(sideOf('sum'), 'total');
  assert.equal(sideOf('tx'), 'tx');
  assert.equal(sideOf('rx'), 'rx');
});

test('burstSeries: mirrored, a transparent mean + stacked p95 − mean (never negative) + dotted max per side', () => {
  const s = burstSeries(res(), 'both', '#123') as S[];
  assert.deepEqual(
    s.map((x) => x.id),
    ['burst:lo:tx', 'burst:hi:tx', 'burst:max:tx', 'burst:lo:rx', 'burst:hi:rx', 'burst:max:rx'],
  );
  assert.ok(s.every((x) => x.id.startsWith(BURST_ID)));
  assert.equal(s[0]!.stack, s[1]!.stack);
  assert.notEqual(s[0]!.stack, s[3]!.stack);
  assert.equal(s[2]!.stack, undefined);
  assert.deepEqual(s[0]!.data, [[0, 10], [M, 0], [2 * M, 5]]);
  // p95 below the mean (one short burst in a quiet minute) leaves no band.
  assert.deepEqual(s[1]!.data, [[0, 30], [M, 0], [2 * M, 0]]);
  // rx below zero, no negative zeros.
  assert.deepEqual(s[3]!.data, [[0, -1], [M, -2], [2 * M, 0]]);
  assert.ok(!Object.is(s[3]!.data[2]![1], -0));
  assert.deepEqual(s[5]!.data, [[0, -8], [M, -4], [2 * M, 0]]);
});

test('burstSeries: one stack for total/tx/rx; rx stays positive alone; missing side draws nothing', () => {
  const total = res({ dir: 'total', tx: undefined, rx: undefined, total: { mean: [1, 1, 1], p95: [2, 2, 2], max: [3, 3, 3] } });
  assert.deepEqual((burstSeries(total, 'total', '#123') as S[]).map((x) => x.id), ['burst:lo:sum', 'burst:hi:sum', 'burst:max:sum']);
  const rx = burstSeries(res({ dir: 'rx', tx: undefined }), 'rx', '#123') as S[];
  assert.deepEqual(rx[2]!.data, [[0, 8], [M, 4], [2 * M, 0]]);
  // An answer for another direction (stale while refetching) draws nothing.
  assert.deepEqual(burstSeries(res(), 'total', '#123'), []);
});

test('burstAt: the bucket holding ts, null outside or for a missing side', () => {
  assert.deepEqual(burstAt(res(), 'tx', M + 30_000), { mean: 0, p95: 0, max: 0 });
  assert.deepEqual(burstAt(res(), 'rx', 0), { mean: 1, p95: 3, max: 8 });
  assert.equal(burstAt(res(), 'tx', 3 * M), null);
  assert.equal(burstAt(res(), 'tx', -1), null);
  assert.equal(burstAt(res(), 'sum', 0), null);
});

test('burstRatio / fmtRatio / burstText', () => {
  assert.equal(burstRatio(0, 5), null);
  assert.equal(burstRatio(2, 18), 9);
  assert.equal(fmtRatio(8.57), '8.6×');
  assert.equal(fmtRatio(9), '9×');
  assert.equal(fmtRatio(123.4), '123×');
  assert.equal(burstText({ mean: 2100, p95: 18_000, max: 94_000 }, fmtRate), 'mean 2.10 Mbps · p95 18.0 Mbps · max 94.0 Mbps · burst ratio 8.6×');
  assert.equal(burstText({ mean: 0, p95: 0, max: 0 }, fmtRate), 'mean 0 bps · p95 0 bps · max 0 bps');
});
