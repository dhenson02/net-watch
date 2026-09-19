import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBurst, burstQuery, burstSpanOk, paddedStats, parseBurstDir, type BurstRow } from './burst.ts';
import { rawRange } from './calls.ts';
import { parseRange } from './range.ts';

const T0 = Date.UTC(2026, 8, 18, 12);
const S = 1000;

test('parseBurstDir: total by default, both/tx/rx/total, else 400', () => {
  assert.equal(parseBurstDir(undefined), 'total');
  assert.equal(parseBurstDir(''), 'total');
  for (const d of ['both', 'tx', 'rx', 'total']) assert.equal(parseBurstDir(d), d);
  assert.throws(() => parseBurstDir('sum'), /dir: expected one of/);
});

test('burstSpanOk: up to 24 h', () => {
  assert.ok(burstSpanOk(T0, T0 + 86_400 * S));
  assert.ok(!burstSpanOk(T0, T0 + 86_400 * S + 1));
});

test('paddedStats: idle ticks count as zero for p95 and max', () => {
  // 60 ticks, 3 active: p95 is the 57th smallest = the 4th largest = 0.
  assert.deepEqual(paddedStats([100, 50, 10], 60), { p95: 0, max: 100 });
  // 20 ticks, 3 active: p95 is the 19th smallest = the 2nd largest.
  assert.deepEqual(paddedStats([10, 100, 50], 20), { p95: 50, max: 100 });
  // Every tick active: no padding, nearest rank.
  const all = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual(paddedStats(all, 100), { p95: 95, max: 100 });
  // More samples than expected ticks (interval jitter): no padding, no loss.
  assert.deepEqual(paddedStats([5, 5, 5], 2), { p95: 5, max: 5 });
  assert.deepEqual(paddedStats([], 0), { p95: 0, max: 0 });
  assert.deepEqual(paddedStats([], 10), { p95: 0, max: 0 });
});

test('burstQuery: per-tick sums then per-bucket arrays, input only as params', () => {
  const r = rawRange(parseRange({ from: String(T0), to: String(T0 + 6 * 3600 * S) }));
  const q = burstQuery({ r, dir: 'total', filters: { name: "x'); DROP", uid: 1000 } });
  assert.match(q.sql, /FROM flows\s/);
  assert.match(q.sql, /sum\(tx_bytes \+ rx_bytes\) AS b_total/);
  assert.match(q.sql, /GROUP BY ts\s/);
  assert.match(q.sql, /groupArray\(b_total \* 8 \/ greatest\(iv, 1\)\) AS kbps_total/);
  assert.match(q.sql, /toStartOfInterval\(ts, INTERVAL \{step:UInt32\} SECOND\)/);
  assert.ok(!q.sql.includes('DROP'));
  assert.equal(q.params.f_name, "x'); DROP");
  assert.match(q.sql, /AND uid = \{f_uid:UInt32\}/);
  assert.deepEqual([q.params.from, q.params.to, q.params.step], [r.from, r.to, r.step]);

  const both = burstQuery({ r, dir: 'both', filters: {} });
  assert.match(both.sql, /sum\(tx_bytes\) AS b_tx, sum\(rx_bytes\) AS b_rx/);
  assert.match(both.sql, /kbps_tx/);
  assert.match(both.sql, /kbps_rx/);
  assert.doesNotMatch(both.sql, /pid = /);

  const one = burstQuery({ r, dir: 'rx', filters: {}, instance: { pid: 42, start: '18446744073709551615' } });
  assert.match(one.sql, /WHERE pid = \{pid:UInt32\} AND proc_start = \{start:UInt64\} AND ts >= /);
  assert.ok(!one.sql.includes('18446744073709551615'));
  assert.equal(one.params.start, '18446744073709551615');
});

test('buildBurst: true mean over the bucket, padded p95/max, zero-filled, cut-short last bucket', () => {
  // 10 s buckets of 1 s ticks; the range ends 5 s into the third bucket.
  const r = rawRange(parseRange({ from: String(T0 + 3 * S), to: String(T0 + 25 * S), step: '10' }));
  assert.equal(r.from, T0);
  const rows: BurstRow[] = [
    // One busy tick of 12.5 kB in the first bucket: 100 kbps for 1 s, mean 10 kbps.
    { t: T0 / 1000, interval_ms: 1000, bytes_total: '12500', kbps_total: [100] },
    // Last bucket covers 5 s: two ticks of 8 and 16 kbps → mean (1000+2000) B * 8 / 5 s.
    { t: (T0 + 20 * S) / 1000, interval_ms: 1000, bytes_total: '3000', kbps_total: [8, 16] },
    // Outside the range: ignored.
    { t: (T0 + 60 * S) / 1000, interval_ms: 1000, bytes_total: '999', kbps_total: [999] },
  ];
  const out = buildBurst(rows, r, 'total');
  assert.deepEqual(out.t, [T0, T0 + 10 * S, T0 + 20 * S]);
  assert.equal(out.dir, 'total');
  assert.equal(out.tx, undefined);
  assert.deepEqual(out.total!.mean, [10, 0, 4.8]);
  // Bucket 0: 10 ticks, one active → p95 is the largest (rank 10 of 10) = 100.
  assert.deepEqual(out.total!.p95, [100, 0, 16]);
  assert.deepEqual(out.total!.max, [100, 0, 16]);
});

test('buildBurst: both answers tx and rx; 60 s buckets hide a 1-tick burst from p95 but not max', () => {
  const r = rawRange(parseRange({ from: String(T0), to: String(T0 + 120 * S), step: '60' }));
  const rows: BurstRow[] = [{ t: T0 / 1000, interval_ms: 1000, bytes_tx: '60000', kbps_tx: [480], bytes_rx: '0', kbps_rx: [0] }];
  const out = buildBurst(rows, r, 'both');
  assert.deepEqual(out.tx!.mean, [8, 0]);
  assert.deepEqual(out.tx!.p95, [0, 0]);
  assert.deepEqual(out.tx!.max, [480, 0]);
  assert.deepEqual(out.rx!.max, [0, 0]);
});
