import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRange } from './range.ts';

const NOW = Date.UTC(2026, 8, 18, 12);
const H = 3600_000;
const D = 24 * H;
const q = (o: Record<string, number | string | undefined>) =>
  Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));

test('defaults to the last hour of raw flows at 10 s', () => {
  assert.deepEqual(parseRange({}, NOW), { from: NOW - H, to: NOW, step: 10, table: 'flows', col: 'ts' });
});

test('picks table and default step by span', () => {
  const at = (span: number) => parseRange(q({ from: NOW - span, to: NOW }), NOW);
  assert.deepEqual([at(2 * H).table, at(2 * H).step], ['flows', 10]);
  assert.deepEqual([at(2 * H + 1).table, at(2 * H + 1).col], ['flows_1m', 'minute']);
  assert.equal(at(6 * H).step, 60);
  assert.equal(at(3 * D).step, 300); // 60 s would be 4320 points; >= 173 s, rounded to 5 min
  assert.equal(at(7 * D).step, 900);
  assert.equal(at(30 * D).step, 1800);
  assert.equal(at(90 * D).step, 7200);
});

test('never exceeds ~1500 points', () => {
  for (const span of [1000, H, 2 * H, 5 * H, 2 * D, 3 * D, 29 * D, 400 * D, 800 * D]) {
    for (const step of [undefined, 1, 7, 60, 3600]) {
      const r = parseRange(q({ from: NOW - span, to: NOW, step }), NOW);
      assert.ok((r.to - r.from) / 1000 / r.step <= 1500, `span ${span} step ${step} -> ${r.step}`);
      if (r.table === 'flows_1m') assert.equal(r.step % 60, 0, 'flows_1m steps are whole minutes');
    }
  }
});

test('honors an explicit step, rounded up to a round width', () => {
  assert.equal(parseRange(q({ from: NOW - H, to: NOW, step: 1 }), NOW).step, 5); // 3600 s / 1500 -> 3 -> 5
  assert.equal(parseRange(q({ from: NOW - 10 * 60_000, to: NOW, step: 1 }), NOW).step, 1);
  assert.equal(parseRange(q({ from: NOW - 10 * 60_000, to: NOW, step: 7 }), NOW).step, 10);
  assert.equal(parseRange(q({ from: NOW - D, to: NOW, step: 30 }), NOW).step, 60); // rollup minimum
  assert.equal(parseRange(q({ from: NOW - D, to: NOW, step: 3600 }), NOW).step, 3600);
});

test('clamps the span to two years', () => {
  const r = parseRange(q({ from: 0, to: NOW }), NOW);
  assert.equal(r.to, NOW);
  assert.equal(r.to - r.from, 2 * 366 * D);
});

test('rejects bad input with 400', () => {
  const bad = [{ from: NOW, to: NOW }, { from: NOW, to: NOW - 1 }, { from: '1.5', to: NOW }, { from: 'abc' }, { to: '-5' }, { step: '0x10' }, { step: 0 }, { from: '1e12' }];
  for (const b of bad) {
    assert.throws(() => parseRange(q(b), NOW), (e: Error & { statusCode?: number }) => e.statusCode === 400, JSON.stringify(b));
  }
  assert.throws(() => parseRange({ from: ['1', '2'] }, NOW), /from/);
});
