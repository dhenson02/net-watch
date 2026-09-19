import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNewDests, firstHourQuery, newDestsQuery, WARMUP_MS, type FirstHourRow, type NewDestRow } from './newDests.ts';

const base = { from: 1_000_000, to: 2_000_000, ports: false, loopback: false, warmup: false, limit: 501 };

test('newDestsQuery: input only as params, key and name filter per option', () => {
  const plain = newDestsQuery(base);
  assert.deepEqual(plain.params, { from: 1_000_000, to: 2_000_000, limit: 501, show_lo: 0, show_warm: 0, warmup_s: WARMUP_MS / 1000 });
  assert.match(plain.sql, /GROUP BY name, raddr\n/);
  assert.match(plain.sql, /argMin\(rport, minute\) AS port/);
  assert.doesNotMatch(plain.sql, /names/);
  // No-peer receivers never count; loopback and warm-up are flagged, not dropped.
  assert.match(plain.sql, /raddr NOT IN \(toIPv6\('::'\), toIPv6\('0\.0\.0\.0'\)\)/);
  assert.match(plain.sql, /ORDER BY hidden, first_s/);

  const q = newDestsQuery({ ...base, names: ["o'brien"], ports: true, loopback: true, warmup: true });
  assert.match(q.sql, /GROUP BY name, raddr, rport\n/);
  assert.match(q.sql, /rport AS port/);
  assert.match(q.sql, /name IN \{names:Array\(String\)\}/);
  assert.doesNotMatch(q.sql, /o'brien/);
  assert.equal(q.params.show_lo, 1);
  assert.equal(q.params.show_warm, 1);
  assert.deepEqual(q.params.names, ["o'brien"]);
});

test('firstHourQuery: the same key set, an hour past the range', () => {
  const q = firstHourQuery({ from: 1, to: 2, ports: true, names: ['curl'] });
  assert.match(q.sql, /\(name, raddr, rport\) IN \(/);
  assert.match(q.sql, /\+ INTERVAL 1 HOUR/);
  assert.match(q.sql, /HAVING min\(minute\) >= /);
  assert.deepEqual(q.params, { from: 1, to: 2, names: ['curl'] });
  const p = firstHourQuery({ from: 1, to: 2, ports: false });
  assert.match(p.sql, /\(name, raddr\) IN \(/);
  assert.match(p.sql, /0 AS port/);
  assert.deepEqual(p.params, { from: 1, to: 2 });
});

const row = (o: Partial<NewDestRow>): NewDestRow => ({
  name: 'curl',
  ip: '1.2.3.4',
  port: 443,
  app: 'HTTPS',
  proto: 'TCP',
  first_s: 1000,
  iid: '42:18446744073709551615',
  lo: 0,
  warm: 0,
  n_lo: '1',
  n_warm: '2',
  n_vis: '2',
  ...o,
});

test('buildNewDests: first-hour bytes, hidden rows dropped, counts from the window columns', () => {
  const rows = [row({}), row({ name: 'ssh', ip: '2001:db8::1', port: 22, app: 'SSH', first_s: 2000, iid: '7:1' }), row({ ip: '127.0.0.1', lo: 1 })];
  const hours: FirstHourRow[] = [
    { name: 'curl', ip: '1.2.3.4', port: 0, m: 1000, bytes: '100' },
    { name: 'curl', ip: '1.2.3.4', port: 0, m: 4540, bytes: 10 }, // 59 min later: in the first hour
    { name: 'curl', ip: '1.2.3.4', port: 0, m: 4600, bytes: 1000 }, // an hour later: not
    { name: 'ssh', ip: '2001:db8::1', port: 0, m: 2000, bytes: '5' },
  ];
  const out = buildNewDests(rows, hours, { ...base, limit: 500 }, 500_000);
  assert.equal(out.dests.length, 2);
  const [a, b] = out.dests;
  assert.deepEqual(a, {
    name: 'curl',
    ip: '1.2.3.4',
    port: 443,
    dest: '1.2.3.4:443',
    app: 'HTTPS',
    proto: 'TCP',
    firstMs: 1_000_000,
    firstHourBytes: 110,
    id: '42:18446744073709551615',
    pid: 42,
    loopback: false,
    warmup: false,
  });
  assert.equal(b!.dest, '[2001:db8::1]:22');
  assert.equal(b!.firstHourBytes, 5);
  assert.deepEqual(out.hidden, { loopback: 1, warmup: 2 });
  assert.equal(out.truncated, false);
  assert.equal(out.warmupUntil, 500_000 + WARMUP_MS);
});

test('buildNewDests: truncation from the visible count; ports keep per-port first-hour sums; empty table', () => {
  const rows = [row({ n_vis: 3 }), row({ port: 80, n_vis: 3 }), row({ port: 8080, n_vis: 3 })];
  const hours: FirstHourRow[] = [
    { name: 'curl', ip: '1.2.3.4', port: 443, m: 1000, bytes: 1 },
    { name: 'curl', ip: '1.2.3.4', port: 80, m: 1000, bytes: 2 },
  ];
  const out = buildNewDests(rows, hours, { ...base, ports: true, limit: 2 }, null);
  assert.equal(out.dests.length, 2);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.dests.map((d) => d.firstHourBytes), [1, 2]);
  assert.equal(out.warmupUntil, null);
  const none = buildNewDests([], [], base, null);
  assert.deepEqual(none.hidden, { loopback: 0, warmup: 0 });
  assert.equal(none.truncated, false);
});

test('buildNewDests: with loopback and warm-up shown, flagged rows stay', () => {
  const rows = [row({ lo: 1, warm: 1, n_lo: 0, n_warm: 0, n_vis: 1 })];
  const out = buildNewDests(rows, [], { ...base, loopback: true, warmup: true }, 0);
  assert.equal(out.dests.length, 1);
  assert.equal(out.dests[0]!.loopback, true);
  assert.equal(out.dests[0]!.warmup, true);
  // Asked without them, the same row is hidden.
  assert.equal(buildNewDests(rows, [], base, 0).dests.length, 0);
});
