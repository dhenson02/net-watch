import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NewDest } from '../../shared/api.ts';
import { focusRows, scrollStart } from '../process/beaconStrip.ts';
import {
  clusterNewDests,
  clusterTitle,
  dailyCounts,
  dayStart,
  hiddenText,
  namesByCount,
  nextDay,
  OTHER_NAME,
  parseNewDestOptions,
  parseNewDestTrack,
} from './newDests.ts';

const nd = (o: Partial<NewDest>): NewDest => ({
  name: 'curl',
  ip: '1.2.3.4',
  port: 443,
  dest: '1.2.3.4:443',
  app: 'HTTPS',
  proto: 'TCP',
  firstMs: 0,
  firstHourBytes: 0,
  id: '1:2',
  pid: 1,
  loopback: false,
  warmup: false,
  ...o,
});

test('URL params: the track and the three options, off unless 1', () => {
  assert.equal(parseNewDestTrack(''), false);
  assert.equal(parseNewDestTrack('?newdests=1'), true);
  assert.equal(parseNewDestTrack('?newdests=yes'), false);
  assert.deepEqual(parseNewDestOptions(''), { ports: false, loopback: false, warmup: false });
  assert.deepEqual(parseNewDestOptions('?nd_ports=1&nd_lo=1&nd_warmup=0'), { ports: true, loopback: true, warmup: false });
});

test('clusterNewDests: markers within the pixel gap merge, largest first hour first, out-of-range dropped', () => {
  const dests = [
    nd({ firstMs: 1000, firstHourBytes: 5 }),
    nd({ firstMs: 1500, firstHourBytes: 50, ip: '5.6.7.8' }),
    nd({ firstMs: 9000, name: 'ssh' }),
    nd({ firstMs: 20_000 }), // at `to`: out
  ];
  // 100 ms per px, 6 px: 600 ms gap.
  const c = clusterNewDests(dests, { from: 0, to: 20_000 }, 100);
  assert.equal(c.length, 2);
  assert.equal(c[0]!.t, 1250);
  assert.deepEqual(c[0]!.items.map((d) => d.ip), ['5.6.7.8', '1.2.3.4']);
  assert.equal(c[0]!.name, 'curl');
  assert.equal(clusterTitle(c[0]!), 'curl: 2 new destinations');
  assert.equal(clusterTitle(c[1]!), 'ssh → 1.2.3.4:443');
  const mixed = clusterNewDests([nd({ firstMs: 10 }), nd({ firstMs: 20, name: 'ssh' })], { from: 0, to: 100 }, 10);
  assert.equal(mixed[0]!.name, null);
  assert.equal(clusterTitle(mixed[0]!), '2 new destinations');
});

test('namesByCount: most destinations first, ties by name', () => {
  assert.deepEqual(namesByCount([{ name: 'b' }, { name: 'a' }, { name: 'c' }, { name: 'c' }]), ['c', 'a', 'b']);
});

test('dailyCounts: every local day of the range, top programs and the rest folded', () => {
  const d0 = new Date(2026, 8, 1, 0, 0).getTime();
  const d1 = nextDay(d0);
  const d2 = nextDay(d1);
  assert.equal(dayStart(d0 + 5 * 3_600_000), d0);
  const dests = [
    { name: 'a', firstMs: d0 + 1000 },
    { name: 'a', firstMs: d2 + 1000 },
    { name: 'b', firstMs: d0 + 2000 },
    { name: 'c', firstMs: d2 + 5 },
    { name: 'a', firstMs: d0 - 1 }, // before the range's first day: dropped
  ];
  const out = dailyCounts(dests, { from: d0 + 3_600_000, to: d2 + 10 }, 1);
  assert.deepEqual(out.days, [d0, d1, d2]);
  assert.deepEqual(out.series, [
    { name: 'a', counts: [1, 0, 1] },
    { name: OTHER_NAME, counts: [1, 0, 1] },
  ]);
  assert.deepEqual(dailyCounts([], { from: d0, to: d1 }).series, []);
});

test('hiddenText: what the exclusions left out, or null', () => {
  assert.equal(hiddenText({ hidden: { loopback: 0, warmup: 0 }, warmupUntil: null }), null);
  assert.equal(hiddenText({ hidden: { loopback: 3, warmup: 0 }, warmupUntil: 5 }), '3 loopback hidden');
  assert.match(hiddenText({ hidden: { loopback: 1, warmup: 2 }, warmupUntil: 5 })!, /^2 first seen in the first 24 h of data \(until .+\) hidden · 1 loopback hidden$/);
});

test('beacon strip focus: rows of the address at any port, scrolled near the top', () => {
  const dests = [{ ip: '1.2.3.4' }, { ip: '::1' }, { ip: '1.2.3.4' }];
  assert.deepEqual(focusRows(dests, '1.2.3.4'), [0, 2]);
  assert.deepEqual(focusRows(dests, null), []);
  assert.deepEqual(focusRows(dests, '9.9.9.9'), []);
  assert.equal(scrollStart(0, 100, 30), 0);
  assert.equal(scrollStart(50, 100, 30), 48);
  assert.equal(scrollStart(99, 100, 30), 70);
});
