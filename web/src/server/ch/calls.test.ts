import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProcessCalls, processCallsQuery, rawRange, type ProcessCallsRow } from './calls.ts';
import { parseRange } from './range.ts';

const T0 = Date.UTC(2026, 8, 18, 12);
const S = 1000;
const row = (tMs: number, tx: number, rx: number, txc: number, rxc: number): ProcessCallsRow => ({
  t: tMs / 1000,
  tx: String(tx),
  rx: String(rx),
  txc: String(txc),
  rxc: String(rxc),
});

test('rawRange: raw flows whatever the span, from aligned to the step', () => {
  const day = rawRange(parseRange({ from: String(T0 + 7 * S), to: String(T0 + 86_400 * S) }));
  assert.equal(day.table, 'flows');
  assert.equal(day.col, 'ts');
  assert.equal(day.step % 60, 0);
  assert.equal(day.from % (day.step * 1000), 0);
  const short = rawRange(parseRange({ from: String(T0 + 7 * S), to: String(T0 + 600 * S), step: '10' }));
  assert.deepEqual([short.table, short.step, short.from], ['flows', 10, T0]);
});

test('processCallsQuery: one instance by the primary key, ids as params', () => {
  const r = rawRange(parseRange({ from: String(T0), to: String(T0 + 3 * 3600 * S) }));
  const q = processCallsQuery(r, { pid: 42, start: '18446744073709551615' });
  assert.match(q.sql, /FROM flows\s/);
  assert.match(q.sql, /pid = \{pid:UInt32\} AND proc_start = \{start:UInt64\} AND ts >= /);
  assert.match(q.sql, /toStartOfInterval\(ts, INTERVAL \{step:UInt32\} SECOND\)/);
  assert.match(q.sql, /sum\(tx_calls\) AS txc, sum\(rx_calls\) AS rxc/);
  assert.ok(!q.sql.includes('18446744073709551615'));
  assert.deepEqual(q.params, { from: r.from, to: r.to, step: r.step, pid: 42, start: '18446744073709551615' });
});

test('buildProcessCalls: kbps and calls per second per bucket, zero-filled', () => {
  const r = rawRange(parseRange({ from: String(T0), to: String(T0 + 35 * S), step: '10' }));
  const out = buildProcessCalls([row(T0, 1250, 0, 10, 0), row(T0 + 20 * S, 0, 2500, 0, 5), row(T0 + 30 * S, 625, 0, 5, 0), row(T0 - 10 * S, 1, 1, 1, 1)], r);
  assert.deepEqual(out.t, [T0, T0 + 10 * S, T0 + 20 * S, T0 + 30 * S]);
  assert.deepEqual(out.tx, [1, 0, 0, 1]); // the last bucket covers 5 s
  assert.deepEqual(out.rx, [0, 0, 2, 0]);
  assert.deepEqual(out.calls, { tx: [1, 0, 0, 1], rx: [0, 0, 0.5, 0] });
  assert.deepEqual([out.step, out.from, out.to], [10, T0, T0 + 35 * S]);
});
