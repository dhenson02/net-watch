import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beaconsQuery, binDots, buildBeacons, capSpan, destText, lifetimeRange, type BeaconRow } from './beacons.ts';

const H = 3_600_000;

test('capSpan keeps the last maxMs', () => {
  assert.deepEqual(capSpan({ from: 0, to: 10 * H }, 6 * H), { from: 4 * H, to: 10 * H, capped: true });
  assert.deepEqual(capSpan({ from: 0, to: 6 * H }, 6 * H), { from: 0, to: 6 * H, capped: false });
});

test('lifetimeRange: first network I/O to its end, never past now', () => {
  assert.deepEqual(lifetimeRange({ first_seen_ms: 1000, last_seen_ms: 5000, ended_ms: null }, 100_000), { from: 1000, to: 6000 });
  assert.deepEqual(lifetimeRange({ first_seen_ms: 1000, last_seen_ms: 5000, ended_ms: 8000 }, 100_000), { from: 1000, to: 9000 });
  assert.deepEqual(lifetimeRange({ first_seen_ms: 1000, last_seen_ms: 99_900, ended_ms: null }, 100_000), { from: 1000, to: 100_000 });
  // Short-lived: ended before first_seen (a collector quirk); still a non-empty range.
  assert.deepEqual(lifetimeRange({ first_seen_ms: 5000, last_seen_ms: 5000, ended_ms: 4000 }, 100_000), { from: 5000, to: 6000 });
});

test('beaconsQuery: instance scope by the key, name scope by name; input only in params', () => {
  const a = beaconsQuery({ scope: 'instance', pid: 7, start: '18446744073709551615', from: 1, to: 2, limit: 101 });
  assert.match(a.sql, /pid = \{pid:UInt32\} AND proc_start = \{start:UInt64\}/);
  assert.match(a.sql, /GROUP BY raddr, rport, proto, app\n/);
  assert.deepEqual(a.params, { pid: 7, start: '18446744073709551615', from: 1, to: 2, limit: 101 });
  const b = beaconsQuery({ scope: 'name', name: "x'); DROP", from: 1, to: 2, limit: 101 });
  assert.match(b.sql, /name = \{name:String\}/);
  assert.doesNotMatch(b.sql, /DROP/);
  assert.match(b.sql, /GROUP BY raddr, rport\n/);
  assert.equal(b.params.name, "x'); DROP");
});

test('destText matches parseDest (IPv6 in brackets)', () => {
  assert.equal(destText('1.2.3.4', 443), '1.2.3.4:443');
  assert.equal(destText('2001:db8::1', 53), '[2001:db8::1]:53');
});

test('binDots merges dots per bin: first time and gap, summed bytes', () => {
  const d = { t: [0, 1000, 5000, 11_000, 12_000], b: [1, 2, 3, 4, 5], gap: [null, 0, 5000, 6000, 0] };
  assert.deepEqual(binDots(d, 0, 10_000), { t: [0, 11_000], b: [6, 9], gap: [null, 6000] });
});

const row = (ip: string, ts: number[], extra: Partial<BeaconRow> = {}): BeaconRow => ({
  ip,
  rport: 443,
  proto: 'TCP',
  app: 'HTTPS',
  ts_ms: ts,
  bytes: ts.map(() => 100),
  interval_ms: 1000,
  ...extra,
});

test('buildBeacons: stats per destination, periodic first, truncation', () => {
  const periodic = Array.from({ length: 8 }, (_, i) => 1_000_000 + i * 30_000);
  // Busier but irregular: a 5 s burst, then two stray ticks.
  const busy = [1_000_000, 1_001_000, 1_002_000, 1_003_000, 1_004_000, 1_050_000, 1_200_000, 1_210_000, 1_500_000];
  const res = buildBeacons([row('10.0.0.1', busy), row('10.0.0.2', [...periodic].reverse(), { ts_ms: periodic.map(String).reverse() }), row('10.0.0.3', [1])], { from: 0, to: 2_000_000, scope: 'instance', capped: false }, 2);
  assert.equal(res.truncated, true);
  assert.deepEqual(
    res.dests.map((d) => d.dest),
    ['10.0.0.2:443', '10.0.0.1:443'],
  );
  const p = res.dests[0]!;
  assert.deepEqual([p.ticks, p.bursts, p.period_s, p.cv, p.score, p.bytes], [8, 8, 30, 0, 1, 800]);
  assert.deepEqual(p.t, periodic);
  assert.deepEqual(p.gap, [null, ...Array(7).fill(30_000)]);
  assert.equal(p.binned_ms, null);
  const q = res.dests[1]!;
  assert.deepEqual([q.ticks, q.bursts, q.score], [9, 5, 0]);
  assert.deepEqual(q.gap.slice(0, 6), [null, 0, 0, 0, 0, 50_000]);
});

test('buildBeacons: duplicate tick times are summed; too many dots are binned', () => {
  const r = buildBeacons([row('::1', [5000, 5000, 6000], { bytes: ['1', '2', '4'] })], { from: 0, to: 10_000, scope: 'name', capped: true }, 100);
  assert.deepEqual([r.dests[0]!.t, r.dests[0]!.b, r.dests[0]!.dest, r.scope, r.capped], [[5000, 6000], [3, 4], '[::1]:443', 'name', true]);

  // One destination may keep 60k dots.
  const n = 70_000;
  const dense = Array.from({ length: n }, (_, i) => i * 1000);
  const b = buildBeacons([row('10.0.0.9', dense)], { from: 0, to: n * 1000, scope: 'instance', capped: false }, 100).dests[0]!;
  assert.equal(b.ticks, n);
  assert.equal(b.binned_ms, 2000);
  assert.equal(b.t.length, n / 2);
  assert.equal(
    b.b.reduce((a, x) => a + x, 0),
    n * 100,
  );
});
