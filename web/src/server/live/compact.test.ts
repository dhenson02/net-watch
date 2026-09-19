import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { LiveSnapshot } from '../../shared/api.ts';
import { CMDLINE_MAX, compactTick, parseSnapshot, snapshotRows } from './compact.ts';
import { compareIds } from './hub.ts';

// The collector's `sample_tick()` (net-watch/src/model.rs) as serialized to
// Redis, with a fixed timestamp.
const sample = readFileSync(new URL('./fixtures/sample-tick.json', import.meta.url), 'utf8');

test('parses the collector snapshot, start_ns as a string', () => {
  const s = parseSnapshot(sample);
  assert.equal(s.ts_ms, 1789775759048);
  assert.equal(s.processes[0]!.start_ns, '1');
  assert.equal(s.flows[0]!.start_ns, '1');
  assert.equal(s.processes[0]!.ended_ms, null);
});

test('keeps 64-bit start_ns exact', () => {
  const big = '18446744073709551000'; // > 2^53: JSON.parse alone would round it
  assert.notEqual(String(JSON.parse(big)), big);
  const s = parseSnapshot(sample.replaceAll('"start_ns":1,', `"start_ns":${big},`));
  assert.equal(s.processes[0]!.start_ns, big);
  assert.equal(s.flows[0]!.start_ns, big);
  assert.equal(compactTick(s).procs[0]!.id, `4242:${big}`);
});

test('rejects JSON that is not a snapshot', () => {
  assert.throws(() => parseSnapshot('{"a":1}'), /not a net-watch snapshot/);
  assert.throws(() => parseSnapshot('null'));
});

test('compacts the sample tick', () => {
  assert.deepEqual(compactTick(parseSnapshot(sample)), {
    ts: 1789775759048,
    intervalMs: 1000,
    drops: 0,
    nProcs: 1,
    nFlows: 1,
    txKbps: 12,
    rxKbps: 512,
    procs: [{ id: '4242:1', name: 'curl', tx: 12, rx: 512 }],
    apps: { HTTPS: [12, 512] },
  });
});

test('counts live processes, lists only active ones, sums apps over flows', () => {
  const s: LiveSnapshot = parseSnapshot(sample);
  const [p] = s.processes;
  const [f] = s.flows;
  s.processes.push(
    { ...p!, pid: 1, name: 'idle', tx_kbps: 0, rx_kbps: 0 },
    { ...p!, pid: 2, name: 'ended', ended_ms: s.ts_ms - 10, tx_kbps: 0.004, rx_kbps: 0 },
  );
  s.flows.push({ ...f!, pid: 2, tx_kbps: 0.004, rx_kbps: 0 }, { ...f!, app: 'DNS', proto: 'UDP', tx_kbps: 0.1, rx_kbps: 0.2 });
  const t = compactTick(s);
  assert.equal(t.nProcs, 2); // the ended one is not live
  assert.equal(t.nFlows, 3);
  assert.deepEqual(t.procs.map((p) => p.name), ['curl', 'ended']); // idle has no traffic
  assert.equal(t.procs[1]!.tx, 0); // rounded to 0.01 kbps
  assert.deepEqual(t.apps, { HTTPS: [12, 512], DNS: [0.1, 0.2] });
});

test('orders stream ids numerically', () => {
  assert.equal(compareIds('1789775759049-0', '1789775759049-0'), 0);
  assert.equal(compareIds('999-5', '1000-0'), -1); // not lexicographic
  assert.equal(compareIds('1000-10', '1000-9'), 1);
});

test('reduces a snapshot to table rows', () => {
  const s = parseSnapshot(sample);
  const [p] = s.processes;
  const [f] = s.flows;
  s.processes.push({ ...p!, pid: 7, uid: 4321, cmdline: 'x'.repeat(1000), ended_ms: s.ts_ms - 5 });
  s.flows.push({ ...f!, rport: 80 });
  const r = snapshotRows(s, (uid) => (uid === 1000 ? 'alice' : null));
  assert.equal(r.ts, s.ts_ms);
  assert.equal(r.intervalMs, 1000);
  assert.deepEqual(r.processes[0], {
    id: '4242:1',
    pid: 4242,
    startNs: '1',
    name: 'curl',
    cmdline: 'curl https://example.com',
    uid: 1000,
    user: 'alice',
    startMs: 1789775754048,
    firstSeenMs: 1789775759048,
    lastSeenMs: 1789775759048,
    endedMs: null,
    txKbps: 12,
    rxKbps: 512,
    txTotal: 1500,
    rxTotal: 64000,
    nFlows: 2,
  });
  const q = r.processes[1]!;
  assert.equal(q.user, null);
  assert.equal(q.nFlows, 0);
  assert.equal(q.endedMs, s.ts_ms - 5);
  assert.equal(q.cmdline.length, CMDLINE_MAX);
  assert.ok(q.cmdline.endsWith('…'));
});
