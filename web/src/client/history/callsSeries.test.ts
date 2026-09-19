import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ThroughputResponse } from '../../shared/api.ts';
import { gridLayout, smallMultiplesOption } from '../charts/smallMultiples.ts';
import { bytesPerCall, callsPoints, dotIsolated, fmtCalls, fromThroughput, hasTraffic, parseCallsParam, processCallsRange, type CallsData } from './callsSeries.ts';

const T0 = Date.UTC(2026, 8, 18, 12);

const answer = (calls?: ThroughputResponse['calls']): ThroughputResponse => ({
  step: 10,
  from: T0,
  to: T0 + 30_000,
  table: 'flows',
  keys: ['HTTPS', '__other'],
  labels: {},
  t: [T0, T0 + 10_000, T0 + 20_000],
  tx: { HTTPS: [1, 0.1, 0], __other: [0.2, 0.2, 0] },
  rx: { HTTPS: [8, 0, 0], __other: [0, 0.3, 0] },
  ...(calls && { calls }),
});

test('parseCallsParam: only 1 opens the panel', () => {
  assert.equal(parseCallsParam('?calls=1'), true);
  for (const s of ['', '?calls=0', '?calls=true', '?calls']) assert.equal(parseCallsParam(s), false, s);
});

test('fromThroughput: totals over every key, null without calls', () => {
  assert.equal(fromThroughput(answer()), null);
  const d = fromThroughput(answer({ tx: [2, 1, 0], rx: [4, 1, 0] }))!;
  assert.deepEqual(d.tx, [1.2, 0.3, 0]);
  assert.deepEqual(d.rx, [8, 0.3, 0]);
  assert.deepEqual(d.calls, { tx: [2, 1, 0], rx: [4, 1, 0] });
  assert.deepEqual([d.step, d.from, d.to, d.t.length], [10, T0, T0 + 30_000, 3]);
});

test('bytesPerCall: kbps * 125 / calls per second, null without calls or bytes', () => {
  assert.equal(bytesPerCall(8, 1), 1000); // 1000 B/s over one call a second
  assert.equal(bytesPerCall(8, 4), 250);
  assert.equal(bytesPerCall(8, 0), null);
  assert.equal(bytesPerCall(0, 3), null);
});

test('callsPoints: mirrored bytes and calls, positive bytes per call, every bucket', () => {
  const d: CallsData = { step: 10, from: T0, to: T0 + 20_000, t: [T0, T0 + 10_000], tx: [8, 0], rx: [16, 0], calls: { tx: [2, 0], rx: [0, 1] } };
  const p = callsPoints(d);
  assert.deepEqual(p.bytes.tx, [[T0, 8], [T0 + 10_000, 0]]);
  assert.deepEqual(p.bytes.rx, [[T0, -16], [T0 + 10_000, 0]]);
  assert.deepEqual(p.calls.rx, [[T0, 0], [T0 + 10_000, -1]]);
  assert.deepEqual(p.perCall.tx, [[T0, 500], [T0 + 10_000, null]]);
  assert.deepEqual(p.perCall.rx, [[T0, null], [T0 + 10_000, null]]); // bytes without calls, calls without bytes
  assert.equal(hasTraffic(d), true);
  assert.equal(hasTraffic({ ...d, tx: [0, 0], rx: [0, 0], calls: { tx: [0, 0], rx: [0, 0] } }), false);
});

test('dotIsolated: a dot only between gaps', () => {
  const d = dotIsolated([
    [1, 5],
    [2, null],
    [3, 7],
    [4, 8],
    [5, null],
  ]);
  assert.deepEqual(
    d.map((p) => p.symbol ?? '-'),
    ['circle', '-', '-', '-', '-'],
  );
  assert.deepEqual(d[2]!.value, [3, 7]);
});

test('fmtCalls: per second, per minute or per hour', () => {
  assert.equal(fmtCalls(0), '0');
  assert.equal(fmtCalls(250), '250/s');
  assert.equal(fmtCalls(12.34), '12.3/s');
  assert.equal(fmtCalls(2), '2/s');
  assert.equal(fmtCalls(-2.5), '2.5/s');
  assert.equal(fmtCalls(0.5), '30/min');
  assert.equal(fmtCalls(42), '42/s');
  assert.equal(fmtCalls(0.1 / 3600), '0.1/h');
  assert.equal(fmtCalls(1 / 60), '1/min');
  assert.equal(fmtCalls(1 / 3600), '1/h');
});

test('processCallsRange: the traffic window padded, at least a minute, not past now', () => {
  const H = 3_600_000;
  const long = processCallsRange({ first_seen_ms: T0, last_seen_ms: T0 + 10 * H, ended_ms: T0 + 10 * H + 1000 }, T0 + 20 * H);
  const pad = (10 * H + 1000) * 0.02;
  assert.deepEqual(long, { from: Math.round(T0 - pad), to: Math.round(T0 + 10 * H + 1000 + pad) });
  const running = processCallsRange({ first_seen_ms: T0, last_seen_ms: T0 + H, ended_ms: null }, T0 + H + 10);
  assert.equal(running.to, T0 + H + 10);
  const blip = processCallsRange({ first_seen_ms: T0, last_seen_ms: T0, ended_ms: T0 - 1000 }, T0 + H);
  assert.deepEqual(blip, { from: T0 - 30_000, to: T0 + 30_000 });
});

test('gridLayout: weights split the plotting height, gaps between panels', () => {
  const g = gridLayout([40, 30, 30], { height: 400, top: 20, bottom: 20, gap: 30 });
  // 400 - 20 - 20 - 2 * 30 = 300 px to split
  assert.deepEqual(g, [
    { top: 20, height: 120 },
    { top: 170, height: 90 },
    { top: 290, height: 90 },
  ]);
  assert.deepEqual(gridLayout([1], { height: 10, top: 20, bottom: 20 }), [{ top: 20, height: 0 }]);
});

test('smallMultiplesOption: one grid, x and y axis per panel, linked pointer, one zoom over all', () => {
  const o = smallMultiplesOption(
    {
      panels: [
        { name: 'a', weight: 2, series: [{ id: 's1' }, { id: 's2' }] },
        { name: 'b', weight: 1, yAxis: { type: 'log' }, series: [{ id: 's3' }] },
      ],
      x: { min: 1, max: 2 },
    },
    { height: 300 },
    '#888',
  ) as any;
  assert.equal(o.grid.length, 2);
  assert.deepEqual(
    o.xAxis.map((x: any) => [x.gridIndex, x.min, x.max, x.axisLabel.show]),
    [
      [0, 1, 2, false],
      [1, 1, 2, true],
    ],
  );
  assert.deepEqual(
    o.yAxis.map((y: any) => [y.gridIndex, y.name, y.type]),
    [
      [0, 'a', 'value'],
      [1, 'b', 'log'],
    ],
  );
  assert.deepEqual(
    o.series.map((s: any) => [s.id, s.xAxisIndex, s.yAxisIndex]),
    [
      ['s1', 0, 0],
      ['s2', 0, 0],
      ['s3', 1, 1],
    ],
  );
  assert.deepEqual(o.axisPointer.link, [{ xAxisIndex: 'all' }]);
  assert.deepEqual(o.dataZoom[0].xAxisIndex, [0, 1]);
});
