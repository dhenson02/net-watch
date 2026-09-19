import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THROUGHPUT_OTHER, type ThroughputResponse } from '../../shared/api.ts';
import { CATEGORICAL, OTHER } from '../charts/palette.ts';
import { bandColors, buildSeries, drillDown, keyLabel, parseThroughputParams, stacksOf } from './throughputSeries.ts';

const res = (over: Partial<ThroughputResponse> = {}): ThroughputResponse => ({
  step: 60,
  from: 0,
  to: 180_000,
  table: 'flows_1m',
  keys: ['a', 'b', THROUGHPUT_OTHER],
  labels: { b: 'bee' },
  t: [0, 60_000, 120_000],
  tx: { a: [1, 2, 3], b: [0, 1, 0], [THROUGHPUT_OTHER]: [1, 0, 0] },
  rx: { a: [4, 0, 1], b: [2, 0, 0], [THROUGHPUT_OTHER]: [0, 0, 5] },
  ...over,
});

test('parseThroughputParams: defaults, whitelists, filters', () => {
  assert.deepEqual(parseThroughputParams(''), { by: 'app', dir: 'both', top: 8, filters: {} });
  assert.deepEqual(parseThroughputParams('?by=dest&dir=total&top=20&filter.name=chrome&filter.dest=%5B%3A%3A1%5D%3A53&filter.x=1'), {
    by: 'dest',
    dir: 'total',
    top: 20,
    filters: { name: 'chrome', dest: '[::1]:53' },
  });
  assert.deepEqual(parseThroughputParams('?by=raddr&dir=up&top=4&filter.uid=root&filter.app='), { by: 'app', dir: 'both', top: 8, filters: {} });
  assert.equal(parseThroughputParams('?top=21').top, 8);
  assert.equal(parseThroughputParams('?top=5').top, 5);
});

test('drillDown: filter to the key, then app → name → dest', () => {
  const p = parseThroughputParams('');
  assert.deepEqual(drillDown(p, 'HTTPS'), { 'filter.app': 'HTTPS', by: 'name' });
  assert.deepEqual(drillDown({ ...p, by: 'name', filters: { app: 'HTTPS' } }, 'chrome'), { 'filter.name': 'chrome', by: 'dest' });
  assert.deepEqual(drillDown({ ...p, by: 'dest' }, '1.2.3.4:443'), { 'filter.dest': '1.2.3.4:443', by: 'name' });
  assert.deepEqual(drillDown({ ...p, by: 'uid' }, '1000'), { 'filter.uid': '1000', by: 'name' });
  // proto drills into app, the default `by`, which the URL leaves out
  assert.deepEqual(drillDown({ ...p, by: 'proto' }, 'UDP'), { 'filter.proto': 'UDP', by: null });
  // the usual next dimension is already filtered: the first free one instead
  assert.deepEqual(drillDown({ ...p, by: 'dest', filters: { name: 'chrome' } }, '1.2.3.4:443'), { 'filter.dest': '1.2.3.4:443', by: null });
  // every dimension filtered: `by` stays
  assert.deepEqual(drillDown({ ...p, by: 'dest', filters: { app: 'a', name: 'n', proto: 'p', uid: '1' } }, 'x:1'), { 'filter.dest': 'x:1' });
  assert.equal(drillDown(p, THROUGHPUT_OTHER), null);
});

test('keyLabel and stacksOf', () => {
  assert.equal(keyLabel(THROUGHPUT_OTHER, {}), 'other');
  assert.equal(keyLabel('1000', { 1000: 'jay (1000)' }), 'jay (1000)');
  assert.equal(keyLabel('HTTPS', {}), 'HTTPS');
  assert.deepEqual(stacksOf('both'), ['tx', 'rx']);
  assert.deepEqual(stacksOf('tx'), ['tx']);
  assert.deepEqual(stacksOf('rx'), ['rx']);
  assert.deepEqual(stacksOf('total'), ['sum']);
});

test('bandColors: slot hues, grey other, faded reuse past the palette', () => {
  const c = bandColors(['a', 'b', 'c', THROUGHPUT_OTHER], new Map([['a', 0], ['b', -1]]), 'light');
  assert.deepEqual(c.get('a'), { color: CATEGORICAL.light[0], faded: false });
  // no slot: the hues 'a' does not use, at full strength
  assert.deepEqual(c.get('b'), { color: CATEGORICAL.light[1], faded: false });
  assert.deepEqual(c.get('c'), { color: CATEGORICAL.light[2], faded: false });
  assert.deepEqual(c.get(THROUGHPUT_OTHER), { color: OTHER.light, faded: false });
  // more keys than hues: the palette repeats, faded
  const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
  const many = bandColors(keys, new Map([['k0', 3]]), 'dark');
  assert.deepEqual(many.get('k0'), { color: CATEGORICAL.dark[3], faded: false });
  assert.deepEqual(
    keys.slice(1).map((k) => many.get(k)!.faded),
    [false, false, false, false, false, false, false, true, true],
  );
  assert.equal(new Set(keys.slice(0, 8).map((k) => many.get(k)!.color)).size, 8, 'first 8 all distinct');
});

test('buildSeries both: tx up, rx mirrored down, totals per stack', () => {
  const s = buildSeries(res(), 'both', new Map());
  assert.deepEqual(s.stacks, ['tx', 'rx']);
  assert.deepEqual(
    s.bands.map((b) => [b.key, b.label]),
    [
      ['a', 'a'],
      ['b', 'bee'],
      [THROUGHPUT_OTHER, 'other'],
    ],
  );
  assert.deepEqual(s.bands[0]!.data.tx, [
    [0, 1],
    [60_000, 2],
    [120_000, 3],
  ]);
  assert.deepEqual(s.bands[0]!.data.rx, [
    [0, -4],
    [60_000, 0],
    [120_000, -1],
  ]);
  assert.deepEqual(
    s.totals.tx!.map((p) => p[1]),
    [2, 3, 3],
  );
  assert.deepEqual(
    s.totals.rx!.map((p) => p[1]),
    [-6, 0, -6],
  );
  assert.equal(s.keyOf.get('bee'), 'b');
  assert.equal(s.keyOf.get('other'), THROUGHPUT_OTHER);
});

test('buildSeries single stacks: rx above zero, total sums both', () => {
  const rx = buildSeries(res(), 'rx', new Map());
  assert.deepEqual(rx.stacks, ['rx']);
  assert.deepEqual(
    rx.bands[0]!.data.rx!.map((p) => p[1]),
    [4, 0, 1],
  );
  assert.equal(rx.bands[0]!.data.tx, undefined);
  const total = buildSeries(res(), 'total', new Map());
  assert.deepEqual(
    total.bands[0]!.data.sum!.map((p) => p[1]),
    [5, 2, 4],
  );
  assert.deepEqual(
    total.totals.sum!.map((p) => p[1]),
    [8, 3, 9],
  );
});
