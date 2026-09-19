import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThroughputUnknown } from '../../shared/api.ts';
import { fmtShare, medianShare, parseUnknownParam, sharePoints, UNKNOWN_DRILL, unknownText } from './unknownShare.ts';

const u: ThroughputUnknown = {
  share: [0.14, null, 0, 1],
  bytes: [220 * 1024 * 1024, 0, 0, 10],
  total: [1.5 * 1024 ** 3, 0, 5, 10],
};

test('parseUnknownParam: only 1 is on', () => {
  assert.equal(parseUnknownParam('?unknown=1'), true);
  assert.equal(parseUnknownParam('unknown=1&by=dest'), true);
  for (const s of ['', '?unknown=0', '?unknown=true', '?unknown']) assert.equal(parseUnknownParam(s), false, s);
});

test('medianShare: skips buckets without traffic', () => {
  assert.equal(medianShare([]), null);
  assert.equal(medianShare([null, null]), null);
  assert.equal(medianShare([0.5, null, 0.1, 0.3]), 0.3);
  assert.equal(medianShare([0.4, 0.1, null, 0.2, 0.3]), 0.25);
  assert.equal(medianShare([0]), 0);
});

test('fmtShare: whole percent from 10 %, one digit below, never a false 0', () => {
  assert.equal(fmtShare(0), '0 %');
  assert.equal(fmtShare(1), '100 %');
  assert.equal(fmtShare(0.14), '14 %');
  assert.equal(fmtShare(0.1449), '14 %');
  assert.equal(fmtShare(0.025), '2.5 %');
  assert.equal(fmtShare(0.03), '3 %');
  assert.equal(fmtShare(0.0004), '<0.1 %');
});

test('unknownText: share with the bytes behind it', () => {
  assert.equal(unknownText(u, 0), 'unknown: 14 % (220.00 MiB of 1.50 GiB)');
  assert.equal(unknownText(u, 1), 'no traffic');
  assert.equal(unknownText(u, 2), 'unknown: 0 % (0 B of 5 B)');
  assert.equal(unknownText(u, 9), 'no traffic');
});

test('sharePoints: one point per bucket, nulls kept to break the line, isolated points dotted', () => {
  assert.deepEqual(sharePoints([0, 1, 2, 3], u), [
    { value: [0, 0.14], symbol: 'circle' },
    { value: [1, null] },
    { value: [2, 0] },
    { value: [3, 1] },
  ]);
  const one: ThroughputUnknown = { share: [null, 0.5, null], bytes: [0, 1, 0], total: [0, 2, 0] };
  assert.deepEqual(sharePoints([0, 1, 2], one)[1], { value: [1, 0.5], symbol: 'circle' });
});

test('UNKNOWN_DRILL filters to unknown and stacks by destination', () => {
  assert.deepEqual(UNKNOWN_DRILL, { 'filter.app': 'unknown', by: 'dest' });
});
