import assert from 'node:assert/strict';
import { test } from 'node:test';
import { burstGaps, burstStarts, median, periodicity } from './periodicity.ts';

const T0 = 1_700_000_000_000;
/** `n` ticks `every` ms apart from T0, each shifted by `jitter(i)` ms. */
const ticks = (n: number, every: number, jitter: (i: number) => number = () => 0) => Array.from({ length: n }, (_, i) => T0 + i * every + jitter(i));

test('a perfect period scores 1', () => {
  const p = periodicity(ticks(10, 30_000), 1000);
  assert.deepEqual(p, { period_s: 30, cv: 0, bursts: 10, score: 1 });
});

test('tick jitter of a few ms keeps a high score; large jitter scores 0', () => {
  const small = periodicity(
    ticks(20, 60_000, (i) => (i % 2 ? 3 : -2)),
    1000,
  );
  assert.equal(small.bursts, 20);
  assert.ok(small.cv! < 0.001 && small.score > 0.999, JSON.stringify(small));
  assert.ok(Math.abs(small.period_s! - 60) < 0.01, String(small.period_s));

  // Gaps alternating 20 s and 40 s: cv about 1/3.
  const big = periodicity(
    ticks(12, 30_000, (i) => (i % 2 ? -10_000 : 0)),
    1000,
  );
  assert.equal(big.score, 0);
  assert.ok(big.cv! > 0.3 && big.cv! < 0.35, String(big.cv));
});

test('consecutive ticks merge into one burst; only burst starts count', () => {
  // A 3-tick burst every 30 s (ticks 999..1001 ms apart, as the collector writes them).
  const ts: number[] = [];
  for (let k = 0; k < 8; k++) ts.push(T0 + k * 30_000, T0 + k * 30_000 + 999, T0 + k * 30_000 + 2000);
  assert.deepEqual(
    burstStarts(ts, 1000),
    Array.from({ length: 8 }, (_, k) => 3 * k),
  );
  const p = periodicity(ts, 1000);
  assert.deepEqual([p.bursts, p.period_s, p.cv, p.score], [8, 30, 0, 1]);
  // Without merging, the 1 s gaps inside the bursts would dominate: one continuous run is one burst.
  assert.deepEqual(periodicity(ticks(100, 1000), 1000), { period_s: null, cv: null, bursts: 1, score: 0 });
  // 1.5 intervals still continue a burst; more starts a new one.
  assert.deepEqual(burstStarts([0, 1500, 3001], 1000), [0, 2]);
});

test('too few bursts never score', () => {
  assert.deepEqual(periodicity([], 1000), { period_s: null, cv: null, bursts: 0, score: 0 });
  assert.deepEqual(periodicity([T0], 1000), { period_s: null, cv: null, bursts: 1, score: 0 });
  assert.deepEqual(periodicity(ticks(2, 10_000), 1000), { period_s: 10, cv: null, bursts: 2, score: 0 });
  // Five perfectly even bursts: cv 0, still below MIN_BURSTS.
  assert.deepEqual(periodicity(ticks(5, 10_000), 1000), { period_s: 10, cv: 0, bursts: 5, score: 0 });
  assert.equal(periodicity(ticks(6, 10_000), 1000).score, 1);
});

test('the period is the median gap, robust to one missed beacon', () => {
  const ts = ticks(10, 30_000).filter((_, i) => i !== 5);
  const p = periodicity(ts, 1000);
  assert.equal(p.period_s, 30);
  assert.equal(p.bursts, 9);
  // One doubled gap out of 8 lifts cv to ~0.31: not scored.
  assert.equal(p.score, 0);
});

test('burstGaps: gap since the previous burst start, 0 inside a burst, null first', () => {
  assert.deepEqual(burstGaps([0, 1000, 2000, 30_000, 31_000, 60_000], 1000), [null, 0, 0, 30_000, 0, 30_000]);
  assert.deepEqual(burstGaps([], 1000), []);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
