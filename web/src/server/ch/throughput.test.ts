import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THROUGHPUT_OTHER } from '../../shared/api.ts';
import type { Range } from './range.ts';
import {
  alignRange,
  buildCompare,
  buildThroughput,
  compareQuery,
  compareStep,
  kbps,
  parseCompare,
  buildUnknown,
  buildCalls,
  callsQuery,
  coveredSeconds,
  parseCalls,
  perSecond,
  parseDir,
  parseUnknown,
  throughputQuery,
  unknownQuery,
  type CallsRow,
  type ThroughputRow,
  type UnknownRow,
} from './throughput.ts';

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

// ---------------------------------------------------------------------------
// compare (11)

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const crow = (tMs: number, tx: number, rx: number) => ({ t: tMs / 1000, tx: String(tx), rx: String(rx) });

test('parseCompare: 1d or 1w, default off', () => {
  assert.equal(parseCompare(undefined), null);
  assert.equal(parseCompare(''), null);
  assert.equal(parseCompare('1d'), '1d');
  assert.equal(parseCompare('1w'), '1w');
  for (const bad of ['2w', '1W', 'toString', ['1d']]) assert.throws(() => parseCompare(bad), (e: Error & { statusCode?: number }) => e.statusCode === 400);
});

test('compareStep: whole minutes, at least one', () => {
  assert.equal(compareStep(raw(T0, T0 + 3600 * S, 5)), 60);
  assert.equal(compareStep(rollup(T0, T0 + DAY, 60)), 60);
  assert.equal(compareStep(rollup(T0, T0 + 30 * DAY, 1800)), 1800);
});

test('compareQuery: flows_1m over the shifted window, totals only, bucketed after the shift', () => {
  const r = raw(T0 + 30 * S, T0 + 3600 * S, 10);
  const q = compareQuery(r, WEEK, { app: "x' OR 1=1 --" });
  assert.match(q.sql, /FROM flows_1m\s/);
  assert.doesNotMatch(q.sql, /JOIN|key|GROUP BY t,/);
  assert.match(q.sql, /toStartOfInterval\(minute \+ INTERVAL \{offset_s:UInt32\} SECOND, INTERVAL \{g_step:UInt32\} SECOND\)/);
  assert.ok(!q.sql.includes("x' OR"));
  // from rounded down to the ghost's minute step, then shifted back
  assert.deepEqual(q.params, { f_app: "x' OR 1=1 --", g_from: T0 - WEEK, g_to: T0 + 3600 * S - WEEK, g_step: 60, offset_s: 604800 });
  // uid needs the processes join, even when the range itself reads raw flows
  assert.match(compareQuery(r, DAY, { uid: 1000 }).sql, /LEFT JOIN .*FROM processes.*g_from/s);
});

test('buildCompare: null when the whole earlier window predates the data', () => {
  const r = rollup(T0, T0 + 3 * 3600 * S, 60);
  assert.equal(buildCompare([], r, WEEK, null), null);
  assert.equal(buildCompare([], r, WEEK, T0 + 3 * 3600 * S - WEEK), null); // first minute == window end
  assert.equal(buildCompare([], r, DAY, T0 - DAY + 3600 * S)?.since, T0 + 3600 * S);
});

test('buildCompare: zero-filled kbps per shifted bucket', () => {
  const r = rollup(T0, T0 + 5 * 60 * S, 60);
  const c = buildCompare([crow(T0 + 60 * S, 7500, 750), crow(T0 + 60 * S, 7500, 0), crow(T0 + 600 * S, 1, 1)], r, DAY, T0 - 30 * DAY)!;
  assert.deepEqual(
    c.t,
    [0, 1, 2, 3, 4].map((i) => T0 + i * 60 * S),
  );
  assert.deepEqual(c.tx, [0, 2, 0, 0, 0]); // 15 kB over 60 s = 2 kbps
  assert.deepEqual(c.rx, [0, 0.1, 0, 0, 0]);
  assert.deepEqual([c.offset, c.step, c.since], [DAY, 60, T0]);
});

test('buildCompare: null before the first minute, a partly covered bucket divided by its covered part', () => {
  const r = rollup(T0, T0 + 3600 * S, 900); // 15 min buckets
  // data starts 20 min into the earlier window: bucket 0 null, bucket 1 covers 10 of 15 min
  const c = buildCompare([crow(T0 + 1200 * S, 75_000, 0), crow(T0 + 1800 * S, 90_000, 0)], r, WEEK, T0 - WEEK + 1200 * S)!;
  assert.equal(c.since, T0 + 1200 * S);
  assert.deepEqual(c.tx, [null, kbps(75_000, 600), kbps(90_000, 900), 0]);
  assert.deepEqual(c.rx, [null, 0, 0, 0]);
});

test('buildCompare: a raw range gets minute buckets, the last one whole (minute rows)', () => {
  const r = raw(T0, T0 + 150 * S, 5);
  const c = buildCompare([crow(T0 + 120 * S, 3750, 0)], r, DAY, 0)!;
  assert.equal(c.t.length, 3);
  assert.equal(c.tx[2], kbps(3750, 60));
});

// ---------------------------------------------------------------------------
// unknown share (16)

const urow = (tMs: number, unk: number, total: number): UnknownRow => ({ t: tMs / 1000, unk: String(unk), total: String(total) });

test('parseUnknown: 1 or 0, default off', () => {
  assert.equal(parseUnknown(undefined), false);
  assert.equal(parseUnknown(''), false);
  assert.equal(parseUnknown('0'), false);
  assert.equal(parseUnknown('1'), true);
  for (const bad of ['true', 'yes', '2', ['1']]) assert.throws(() => parseUnknown(bad), /unknown/);
});

test('unknownQuery: the main buckets and table, filters in params only', () => {
  const r = raw(T0, T0 + 3600 * S, 10);
  const q = unknownQuery(r, { app: "x' OR 1=1 --", name: 'curl' });
  assert.ok(!q.sql.includes("x' OR"));
  assert.match(q.sql, /sumIf\(tx_bytes \+ rx_bytes, app = 'unknown'\) AS unk/);
  assert.match(q.sql, /sum\(tx_bytes \+ rx_bytes\) AS total/);
  assert.match(q.sql, /toStartOfInterval\(ts, INTERVAL \{step:UInt32\} SECOND\)/);
  assert.match(q.sql, /FROM flows\s/);
  assert.match(q.sql, /AND app = \{f_app:String\}/);
  assert.deepEqual(q.params, { from: r.from, to: r.to, step: 10, f_app: "x' OR 1=1 --", f_name: 'curl' });
  const long = rollup(T0, T0 + 86400 * S, 60);
  assert.match(unknownQuery(long, {}).sql, /FROM flows_1m\s/);
  assert.match(unknownQuery(long, { uid: 1000 }).sql, /LEFT JOIN/);
});

test('buildUnknown: per bucket on the throughput grid, share null without traffic', () => {
  const r = raw(T0, T0 + 40 * S, 10);
  const rows = [urow(T0, 25, 100), urow(T0 + 20 * S, 0, 50), urow(T0 + 30 * S, 3, 3), urow(T0 + 30 * S, 0, 3), urow(T0 + 90 * S, 1, 1)];
  const out = buildUnknown(rows, r);
  assert.deepEqual(out.bytes, [25, 0, 0, 3]);
  assert.deepEqual(out.total, [100, 0, 50, 6]);
  assert.deepEqual(out.share, [0.25, null, 0, 0.5]);
  assert.equal(out.share.length, buildThroughput([], r, 'both').t.length);
  assert.equal(buildUnknown([urow(T0, 1, 3)], r).share[0], 0.3333);
});

// ---------------------------------------------------------------------------
// bytes vs calls (14)

const callRow = (tMs: number, tx: number, rx: number): CallsRow => ({ t: tMs / 1000, tx: String(tx), rx: String(rx) });

test('parseCalls: 1 or 0, default off', () => {
  assert.equal(parseCalls(undefined), false);
  assert.equal(parseCalls('0'), false);
  assert.equal(parseCalls('1'), true);
  for (const bad of ['true', 'yes', '2', ['1']]) assert.throws(() => parseCalls(bad), /calls/);
});

test('perSecond: calls over seconds, 6 decimals', () => {
  assert.equal(perSecond(50, 10), 5);
  assert.equal(perSecond(1, 3600), 0.000278);
  assert.equal(perSecond(3, 0), 0);
});

test('coveredSeconds: the step, less for a bucket cut short by to', () => {
  assert.deepEqual(coveredSeconds(raw(T0, T0 + 25 * S, 10), [T0, T0 + 10 * S, T0 + 20 * S]), [10, 10, 5]);
  // the rollup covers up to the minute after `to`
  assert.deepEqual(coveredSeconds(rollup(T0, T0 + 90 * S, 60), [T0, T0 + 60 * S]), [60, 60]);
  assert.deepEqual(coveredSeconds(rollup(T0, T0 + 150 * S, 120), [T0, T0 + 120 * S]), [120, 60]);
});

test('callsQuery: the main buckets and table, filters in params only', () => {
  const r = raw(T0, T0 + 3600 * S, 10);
  const q = callsQuery(r, { name: "x' OR 1=1 --" });
  assert.ok(!q.sql.includes("x' OR"));
  assert.match(q.sql, /sum\(tx_calls\) AS tx, sum\(rx_calls\) AS rx/);
  assert.match(q.sql, /toStartOfInterval\(ts, INTERVAL \{step:UInt32\} SECOND\)/);
  assert.match(q.sql, /FROM flows\s/);
  assert.deepEqual(q.params, { from: r.from, to: r.to, step: 10, f_name: "x' OR 1=1 --" });
  const long = rollup(T0, T0 + 86400 * S, 60);
  assert.match(callsQuery(long, {}).sql, /FROM flows_1m\s/);
  assert.match(callsQuery(long, { uid: 1000 }).sql, /LEFT JOIN/);
});

test('buildCalls: calls per second on the throughput grid, zero-filled', () => {
  const r = raw(T0, T0 + 35 * S, 10);
  const rows = [callRow(T0, 20, 5), callRow(T0 + 20 * S, 0, 10), callRow(T0 + 30 * S, 5, 0), callRow(T0 + 30 * S, 5, 0), callRow(T0 + 90 * S, 1, 1)];
  const out = buildCalls(rows, r);
  assert.deepEqual(out.tx, [2, 0, 0, 2]); // the last bucket covers 5 s
  assert.deepEqual(out.rx, [0.5, 0, 1, 0]);
  assert.equal(out.tx.length, buildThroughput([], r, 'both').t.length);
});
