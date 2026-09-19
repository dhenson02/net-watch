import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThroughputCompare } from '../../shared/api.ts';
import { fmtRate } from '../charts/format.ts';
import type { Point } from '../charts/mirroredStack.ts';
import { deviationRuns, fmtPct, ghostAt, ghostSeries, ghostText, ghostValues, parseCompareParam, pctChange } from './ghost.ts';

const M = 60_000;
// Four minute buckets; the first predates the data.
const cmp = (over: Partial<ThroughputCompare> = {}): ThroughputCompare => ({
  offset: 7 * 86_400_000,
  step: 60,
  since: M,
  t: [0, M, 2 * M, 3 * M],
  tx: [null, 10, 20, 0],
  rx: [null, 5, 0, 1],
  ...over,
});

test('parseCompareParam: 1d or 1w, else off', () => {
  assert.equal(parseCompareParam(''), null);
  assert.equal(parseCompareParam('?compare=1d'), '1d');
  assert.equal(parseCompareParam('?by=name&compare=1w'), '1w');
  assert.equal(parseCompareParam('?compare=2w'), null);
});

test('ghostValues: tx as is, rx mirrored only for both, sum adds, null stays null', () => {
  const c = cmp();
  assert.deepEqual(ghostValues(c, 'tx', 'both'), [null, 10, 20, 0]);
  assert.deepEqual(ghostValues(c, 'rx', 'both'), [null, -5, 0, -1]);
  assert.deepEqual(ghostValues(c, 'rx', 'rx'), [null, 5, 0, 1]);
  assert.deepEqual(ghostValues(c, 'sum', 'total'), [null, 15, 20, 1]);
});

test('ghostSeries: one dashed unstacked line per stack, behind the bands, areas on the first', () => {
  const s = ghostSeries(cmp(), 'both', '#888', 'same time last week', [[M, 3 * M]]) as any[];
  assert.deepEqual(
    s.map((x) => x.id),
    ['ghost:tx', 'ghost:rx'],
  );
  for (const x of s) {
    assert.equal(x.stack, undefined);
    assert.equal(x.areaStyle, undefined);
    assert.equal(x.z, 1);
    assert.deepEqual(x.lineStyle, { type: 'dashed', width: 1.5, opacity: 0.6, color: '#888' });
  }
  assert.deepEqual(s[1].data, [
    [0, null],
    [M, -5],
    [2 * M, 0],
    [3 * M, -1],
  ]);
  assert.deepEqual(s[0].markArea.data, [[{ xAxis: M }, { xAxis: 3 * M }]]);
  assert.equal(s[1].markArea, undefined);
  assert.equal((ghostSeries(cmp(), 'total', '#888', 'x') as any[]).length, 1);
  assert.equal((ghostSeries(cmp(), 'tx', '#888', 'x') as any[])[0].markArea, undefined);
});

test('ghostAt: the bucket holding ts, null outside or before the data', () => {
  const c = cmp();
  assert.equal(ghostAt(c, 'tx', M), 10);
  assert.equal(ghostAt(c, 'tx', M + 59_999), 10);
  assert.equal(ghostAt(c, 'rx', 2 * M + 10_000), 0);
  assert.equal(ghostAt(c, 'sum', M + 1), 15);
  assert.equal(ghostAt(c, 'tx', 10), null); // before `since`
  assert.equal(ghostAt(c, 'sum', 10), null);
  assert.equal(ghostAt(c, 'tx', -1), null);
  assert.equal(ghostAt(c, 'tx', 4 * M), null);
});

test('pctChange / fmtPct / ghostText', () => {
  assert.equal(pctChange(5, 10), -0.5);
  assert.equal(pctChange(5, 0), null);
  assert.equal(fmtPct(-0.42), '−42 %');
  assert.equal(fmtPct(0.124), '+12 %');
  assert.equal(fmtPct(0.001), '±0 %');
  assert.equal(fmtPct(11), '×12');
  assert.equal(ghostText(1800, 3100, fmtRate), '3.10 Mbps (−42 %)');
  assert.equal(ghostText(-1800, 3100, fmtRate), '3.10 Mbps (−42 %)'); // mirrored rx total
  assert.equal(ghostText(5, 0, fmtRate), '0 bps');
  assert.equal(ghostText(null, 1, fmtRate), '1.00 kbps');
  assert.equal(ghostText(5, null, fmtRate), 'no data');
});

test('deviationRuns: over 2× the ghost for 3+ ghost buckets in a row', () => {
  const n = 10;
  const t = Array.from({ length: n }, (_, i) => i * M);
  const c = cmp({ since: 0, t, tx: new Array(n).fill(10), rx: new Array(n).fill(5) });
  const line = (v: number[]): Point[] => t.map((ts, i) => [ts, v[i]!]);
  //                 0   1   2   3   4   5   6   7   8   9
  const txNow = line([10, 25, 25, 25, 10, 25, 25, 10, 25, 25]);
  const rxNow = line([-5, -6, -6, -6, -5, -6, -6, -5, -6, -6]);
  // both: |tx| + |rx| (31) vs 2 × (10 + 5): runs 1–3 (3 buckets) kept, 5–6 (2) dropped, 8–9 runs to the end but is 2
  assert.deepEqual(deviationRuns({ tx: txNow, rx: rxNow }, ['tx', 'rx'], c, M), [[M, 4 * M]]);
  // a run reaching the end closes one step after the last bucket
  assert.deepEqual(deviationRuns({ tx: line([0, 0, 0, 0, 0, 0, 0, 30, 30, 30]) }, ['tx'], c, M), [[7 * M, 10 * M]]);
  // exactly 2× is not above
  assert.deepEqual(deviationRuns({ tx: line(new Array(n).fill(20)) }, ['tx'], c, M), []);
  // no ghost data breaks a run; a zero ghost with traffic counts as above
  const gaps = cmp({ since: 0, t, tx: [0, 0, 0, null, 0, 0, 0, 0, 0, 0], rx: new Array(n).fill(0) });
  assert.deepEqual(deviationRuns({ tx: line([1, 1, 1, 1, 1, 1, 0, 1, 1, 1]) }, ['tx'], gaps, M), [
    [0, 3 * M],
    [7 * M, 10 * M],
  ]);
  // finer chart buckets (10 s) need 3 ghost minutes, not 3 of their own
  const fine = Array.from({ length: 30 }, (_, i) => [i * 10_000, i >= 6 && i < 18 ? 100 : 0] as Point);
  assert.deepEqual(deviationRuns({ tx: fine }, ['tx'], c, 10_000), []);
  const longer = fine.map(([ts]) => [ts, ts >= 60_000 && ts < 240_000 ? 100 : 0] as Point);
  assert.deepEqual(deviationRuns({ tx: longer }, ['tx'], c, 10_000), [[M, 4 * M]]);
});
