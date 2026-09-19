import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THROUGHPUT_OTHER } from '../../shared/api.ts';
import type { Range } from './range.ts';
import { alignRange, buildThroughput, kbps, parseDir, throughputQuery, type ThroughputRow } from './throughput.ts';

const T0 = Date.UTC(2026, 8, 18, 12); // on every step boundary used here
const S = 1000;
const raw = (from: number, to: number, step: number): Range => ({ from, to, step, table: 'flows', col: 'ts' });
const rollup = (from: number, to: number, step: number): Range => ({ from, to, step, table: 'flows_1m', col: 'minute' });
const row = (tMs: number, key: string, tx: number, rx: number): ThroughputRow => ({ t: tMs / 1000, key, tx: String(tx), rx: String(rx) });

test('kbps: bytes * 8 / 1000 / seconds', () => {
  assert.equal(kbps(1250, 10), 1); // 10 kbit over 10 s
  assert.equal(kbps(0, 10), 0);
  assert.equal(kbps(100, 0), 0);
  assert.equal(kbps(1, 3), 0.003); // rounded to whole bps
});

test('alignRange rounds from down to a bucket start', () => {
  assert.equal(alignRange(raw(T0 + 7 * S, T0 + 100 * S, 10)).from, T0);
  assert.equal(alignRange(rollup(T0 + 61 * S, T0 + 3600 * S, 900)).from, T0);
  assert.equal(alignRange(raw(T0, T0 + 100 * S, 10)).from, T0);
});

test('pads every key to every bucket and converts to kbps', () => {
  const r = raw(T0, T0 + 40 * S, 10);
  const out = buildThroughput([row(T0, 'a', 1250, 0), row(T0 + 20 * S, 'b', 0, 2500), row(T0 + 30 * S, 'a', 125, 125)], r, 'both');
  assert.deepEqual(out.t, [T0, T0 + 10 * S, T0 + 20 * S, T0 + 30 * S]);
  assert.deepEqual(out.keys, ['b', 'a']); // b: 2500 bytes, a: 1500
  assert.deepEqual(out.tx, { a: [1, 0, 0, 0.1], b: [0, 0, 0, 0] });
  assert.deepEqual(out.rx, { a: [0, 0, 0, 0.1], b: [0, 0, 2, 0] });
  assert.deepEqual([out.step, out.from, out.to, out.table], [10, T0, T0 + 40 * S, 'flows']);
});

test('ranks by the requested direction, other last, ties by key', () => {
  const r = raw(T0, T0 + 10 * S, 10);
  const rows = [row(T0, THROUGHPUT_OTHER, 9999, 9999), row(T0, 'up', 300, 0), row(T0, 'down', 0, 500), row(T0, 'mid', 100, 100), row(T0, 'eq', 100, 100)];
  assert.deepEqual(buildThroughput(rows, r, 'tx').keys, ['up', 'eq', 'mid', 'down', THROUGHPUT_OTHER]);
  assert.deepEqual(buildThroughput(rows, r, 'rx').keys, ['down', 'eq', 'mid', 'up', THROUGHPUT_OTHER]);
  assert.deepEqual(buildThroughput(rows, r, 'total').keys, ['down', 'up', 'eq', 'mid', THROUGHPUT_OTHER]);
});

test('a bucket cut short by `to` is divided by the time it covers', () => {
  // raw flows: the last bucket covers 5 s of its 10
  const a = buildThroughput([row(T0 + 10 * S, 'k', 1250, 0)], raw(T0, T0 + 15 * S, 10), 'both');
  assert.deepEqual(a.t.length, 2);
  assert.deepEqual(a.tx.k, [0, 2]);
  // rollup: minute rows cover up to the minute after `to` (here 2 of 15 min)
  const b = buildThroughput([row(T0 + 900 * S, 'k', 15_000, 0)], rollup(T0, T0 + 1000 * S, 900), 'both');
  assert.equal(b.t.length, 2);
  assert.equal(b.tx.k![1], kbps(15_000, 120));
});

test('ignores rows outside the grid, keeps summing repeated cells, passes labels for present keys', () => {
  const r = raw(T0, T0 + 20 * S, 10);
  const out = buildThroughput([row(T0 - 10 * S, 'x', 1, 1), row(T0, 'k', 625, 0), row(T0, 'k', 625, 0), row(T0 + 20 * S, 'y', 1, 1)], r, 'both', {
    k: 'label k',
    gone: 'unused',
  });
  assert.deepEqual(out.keys, ['k']);
  assert.deepEqual(out.tx.k, [1, 0]);
  assert.deepEqual(out.labels, { k: 'label k' });
});

test('no rows: an empty key list over a full grid', () => {
  const out = buildThroughput([], raw(T0, T0 + 30 * S, 10), 'both');
  assert.deepEqual(out.keys, []);
  assert.equal(out.t.length, 3);
});

test('parseDir: whitelist, default both', () => {
  assert.equal(parseDir(undefined), 'both');
  assert.equal(parseDir('total'), 'total');
  for (const bad of ['sum', 'TX', ['tx']]) assert.throws(() => parseDir(bad), (e: Error & { statusCode?: number }) => e.statusCode === 400);
});

test('throughputQuery: fixed SQL per by/dir, input only in params', () => {
  const r = raw(T0, T0 + 3600 * S, 10);
  const q = throughputQuery(r, 'name', 'tx', 8, { app: "x' OR 1=1 --", dest: { dest_ip: '1.2.3.4', dest_port: 443 } });
  assert.ok(!q.sql.includes("x' OR"));
  assert.match(q.sql, /AND app = \{f_app:String\}/);
  assert.match(q.sql, /raddr = toIPv6\(\{dest_ip:String\}\) AND rport = \{dest_port:UInt16\}/);
  assert.match(q.sql, /ORDER BY sum\(tx_bytes\) DESC/);
  assert.match(q.sql, /FROM flows\s/);
  assert.deepEqual(q.params, { from: r.from, to: r.to, step: 10, f_app: "x' OR 1=1 --", dest_ip: '1.2.3.4', dest_port: 443, top: 8 });
  // the filters and the time range apply to both passes
  assert.equal(q.sql.match(/AND app = /g)?.length, 2);
  assert.equal(q.sql.match(/ts >= /g)?.length, 2);
});

test('throughputQuery: uid on the rollup joins processes; raw flows has the column', () => {
  const long = rollup(T0, T0 + 86400 * S, 60);
  assert.match(throughputQuery(long, 'uid', 'both', 8, {}).sql, /LEFT JOIN .*FROM processes/s);
  assert.match(throughputQuery(long, 'app', 'both', 8, { uid: 1000 }).sql, /LEFT JOIN/);
  assert.doesNotMatch(throughputQuery(long, 'app', 'both', 8, {}).sql, /JOIN/);
  assert.doesNotMatch(throughputQuery(raw(T0, T0 + 3600 * S, 10), 'uid', 'both', 8, {}).sql, /JOIN/);
});
