import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  axisExtent,
  clamp1,
  colorSlots,
  fmtDecadeBytes,
  inRect,
  lifetimeMs,
  parseBasis,
  parseGroup,
  ratioText,
  refLines,
  symbolSize,
  topNames,
} from './scatterPoints.ts';

test('URL params: unknown values fall back to the defaults', () => {
  assert.equal(parseGroup(null), 'instance');
  assert.equal(parseGroup('name'), 'name');
  assert.equal(parseGroup('x'), 'instance');
  assert.equal(parseBasis(null), 'lifetime');
  assert.equal(parseBasis('range'), 'range');
});

test('topNames: distinct names in order, at most n', () => {
  const pts = ['a', 'b', 'a', 'c', 'd'].map((name) => ({ name }));
  assert.deepEqual(topNames(pts, 3), ['a', 'b', 'c']);
  assert.deepEqual(topNames([], 3), []);
});

test('colorSlots: page slots are kept, the rest fill the lowest free ones', () => {
  const page = new Map([
    ['b', 0],
    ['c', 2],
  ]);
  const m = colorSlots(['a', 'b', 'c', 'd'], (n) => page.get(n) ?? -1, 4);
  assert.deepEqual([...m], [
    ['b', 0],
    ['c', 2],
    ['a', 1],
    ['d', 3],
  ]);
  // Two names on one page slot (impossible, but safe): the second gets a free one.
  const dup = colorSlots(['a', 'b'], () => 0, 4);
  assert.deepEqual([...dup], [
    ['a', 0],
    ['b', 1],
  ]);
  // More names than slots: the extra ones get none (grey).
  assert.equal(colorSlots(['a', 'b', 'c'], () => -1, 2).has('c'), false);
});

test('axisExtent: whole decades over clamped tx and rx, at least one decade', () => {
  assert.deepEqual(axisExtent([]), [1, 1000]);
  assert.deepEqual(axisExtent([{ tx: 0, rx: 5500 }]), [1, 10000]);
  assert.deepEqual(axisExtent([{ tx: 1000, rx: 1000 }]), [1000, 10000]);
  assert.deepEqual(axisExtent([{ tx: 150, rx: 2_000_000 }, { tx: 30_000, rx: 900 }]), [100, 10_000_000]);
});

test('refLines: the diagonal always, the 10× lines when the extent spans more than a decade', () => {
  assert.deepEqual(refLines([10, 100]).map((l) => l.id), ['even']);
  const lines = refLines([1, 1e6]);
  assert.deepEqual(lines.map((l) => [l.id, l.from, l.to]), [
    ['even', [1, 1], [1e6, 1e6]],
    ['up10', [1, 10], [1e5, 1e6]],
    ['down10', [10, 1], [1e6, 1e5]],
  ]);
  // Every end stays in the extent.
  for (const l of lines) for (const v of [...l.from, ...l.to]) assert.ok(v >= 1 && v <= 1e6);
});

test('ratioText', () => {
  assert.equal(ratioText(100, 10), '10× upload');
  assert.equal(ratioText(10, 34), '3.4× download');
  assert.equal(ratioText(100, 99), 'even');
  assert.equal(ratioText(5, 0), 'sent only');
  assert.equal(ratioText(0, 5), 'received only');
  assert.equal(ratioText(0, 0), '—');
});

test('lifetimeMs: to the end, else to the last I/O; null without a start', () => {
  assert.equal(lifetimeMs({ startMs: 1000, endedMs: 5000, lastSeenMs: 4000 }), 4000);
  assert.equal(lifetimeMs({ startMs: 1000, endedMs: null, lastSeenMs: 3000 }), 2000);
  assert.equal(lifetimeMs({ startMs: null, endedMs: 5000, lastSeenMs: 4000 }), null);
  assert.equal(lifetimeMs({ startMs: 1000, endedMs: null, lastSeenMs: null }), null);
});

test('symbolSize: fixed per instance, grows with √instances per name, capped', () => {
  assert.equal(symbolSize('instance', 50), 8);
  assert.equal(symbolSize('name', 1), 7);
  assert.equal(symbolSize('name', 4), 14);
  assert.equal(symbolSize('name', 10_000), 40);
});

test('fmtDecadeBytes', () => {
  assert.equal(fmtDecadeBytes(1), '1 B');
  assert.equal(fmtDecadeBytes(100), '100 B');
  assert.equal(fmtDecadeBytes(1000), '1 kB');
  assert.equal(fmtDecadeBytes(1e7), '10 MB');
  assert.equal(fmtDecadeBytes(1e12), '1 TB');
});

test('inRect: on the clamped (received, sent) values, corners in any order', () => {
  const pts = [
    { tx: 0, rx: 0 },
    { tx: 100, rx: 10 },
    { tx: 5000, rx: 5000 },
  ];
  assert.deepEqual(inRect(pts, [[1, 20], [50, 200]]), [1]);
  assert.deepEqual(inRect(pts, [[20, 1], [200, 50]]), [1]);
  assert.deepEqual(inRect(pts, [[1, 1], [1, 1]]), [0]);
  assert.deepEqual(inRect(pts, [[1, 1e4], [1, 1e4]]), [0, 1, 2]);
  assert.equal(clamp1(0), 1);
});
