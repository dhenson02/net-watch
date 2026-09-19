import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bytesExtent,
  dotData,
  dotSize,
  DOT_MAX,
  DOT_MIN,
  fmtPeriod,
  gapText,
  historyHref,
  isPeriodic,
  parseBeaconScope,
  periodText,
  rowLabels,
  scopeRange,
} from './beaconStrip.ts';

const H = 3_600_000;

test('parseBeaconScope defaults to the instance', () => {
  assert.equal(parseBeaconScope(null), 'instance');
  assert.equal(parseBeaconScope('bogus'), 'instance');
  assert.equal(parseBeaconScope('name'), 'name');
});

test('rowLabels are unique: the transport only when needed', () => {
  assert.deepEqual(
    rowLabels([
      { dest: '1.1.1.1:443', app: 'HTTPS', proto: 'TCP' },
      { dest: '1.1.1.1:443', app: 'QUIC', proto: 'UDP' },
      { dest: '[::1]:53', app: 'DNS', proto: 'UDP' },
      { dest: '[::1]:53', app: 'DNS', proto: 'TCP' },
    ]),
    ['1.1.1.1:443 HTTPS', '1.1.1.1:443 QUIC', '[::1]:53 DNS/UDP', '[::1]:53 DNS/TCP'],
  );
});

test('periodText and fmtPeriod', () => {
  assert.equal(periodText({ period_s: 30, cv: 0.0213, bursts: 9 }), 'every 30.0 s · cv 0.02');
  assert.equal(periodText({ period_s: 150, cv: 0.5, bursts: 9 }), 'every 2.5 min · cv 0.50');
  assert.equal(periodText({ period_s: 12, cv: null, bursts: 2 }), '2 bursts, 12.0 s apart');
  assert.equal(periodText({ period_s: null, cv: null, bursts: 1 }), '1 burst');
  assert.equal(fmtPeriod(5400), '1.5 h');
});

test('dotSize maps log(bytes) to 3–9 px', () => {
  assert.equal(dotSize(10, 10, 1e6), DOT_MIN);
  assert.equal(dotSize(1e6, 10, 1e6), DOT_MAX);
  const mid = dotSize(Math.sqrt(11 * 1_000_001) - 1, 10, 1e6);
  assert.ok(Math.abs(mid - 6) < 1e-9, String(mid));
  assert.equal(dotSize(5, 5, 5), 6);
  assert.equal(dotSize(1e9, 10, 1e6), DOT_MAX);
});

test('bytesExtent', () => {
  assert.deepEqual(bytesExtent([{ b: [5, 1] }, { b: [9] }]), [1, 9]);
  assert.deepEqual(bytesExtent([{ b: [] }]), [0, 0]);
});

test('gapText', () => {
  assert.equal(gapText(null), 'first burst');
  assert.equal(gapText(0), 'continues a burst');
  assert.equal(gapText(30_000), '30 s after the previous burst');
});

test('isPeriodic above 0.8', () => {
  assert.equal(isPeriodic({ score: 0.8 }), false);
  assert.equal(isPeriodic({ score: 0.95 }), true);
});

test('historyHref sets the range and filter.dest', () => {
  const u = new URL(historyHref('[2001:db8::1]:443', { from: 1, to: 2 }), 'http://x');
  assert.equal(u.pathname, '/history');
  assert.deepEqual([u.searchParams.get('from'), u.searchParams.get('to'), u.searchParams.get('filter.dest')], ['1', '2', '[2001:db8::1]:443']);
});

test('scopeRange cuts the name scope to its last 6 h', () => {
  assert.deepEqual(scopeRange({ from: 0, to: 10 * H }, 'name'), { from: 4 * H, to: 10 * H });
  assert.deepEqual(scopeRange({ from: 0, to: 10 * H }, 'instance'), { from: 0, to: 10 * H });
  assert.deepEqual(scopeRange({ from: 0, to: 30 * H }, 'instance'), { from: 6 * H, to: 30 * H });
});

test('dotData flattens rows', () => {
  assert.deepEqual(
    dotData([
      { t: [1, 2], b: [10, 20], gap: [null, 0] },
      { t: [3], b: [30], gap: [null] },
    ]),
    [
      [1, 0, 10, null],
      [2, 0, 20, 0],
      [3, 1, 30, null],
    ],
  );
});
