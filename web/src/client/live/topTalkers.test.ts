import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompactTick, LiveProcessRow } from '../../shared/api.ts';
import { buildSparks, isIdle, matchesFilter, nextSort, parseSort, sortRows, type Spark } from './topTalkers.ts';

function tick(ts: number, procs: [id: string, tx: number, rx: number][], gap = false): CompactTick {
  return {
    ts,
    intervalMs: 1000,
    drops: 0,
    nProcs: procs.length,
    nFlows: procs.length,
    txKbps: 0,
    rxKbps: 0,
    procs: procs.map(([id, tx, rx]) => ({ id, name: id, tx, rx })),
    apps: {},
    ...(gap && { gap: true as const }),
  };
}

function row(id: string, patch: Partial<LiveProcessRow> = {}): LiveProcessRow {
  const [pid, startNs] = id.split(':') as [string, string];
  return {
    id,
    pid: Number(pid),
    startNs,
    name: `p${pid}`,
    cmdline: '',
    uid: 0,
    user: 'root',
    startMs: 0,
    firstSeenMs: 0,
    lastSeenMs: 0,
    endedMs: null,
    txKbps: 0,
    rxKbps: 0,
    txTotal: 0,
    rxTotal: 0,
    nFlows: 0,
    ...patch,
  };
}

test('sparks: 60 s window, zeros for absent ticks, break before a gap', () => {
  const ticks = [
    tick(0, [['1:1', 99, 99]]), // outside the window
    tick(50_000, [['1:1', 1, 2]]),
    tick(51_000, []),
    tick(55_000, [['1:1', 3, 0]], true),
    tick(60_000, [['2:2', 5, 5]]),
  ];
  const s = buildSparks(ticks, ['1:1', '2:2', '3:3']);
  assert.deepEqual(s.get('1:1'), { tx: [1, 0, null, 3, 0], rx: [2, 0, null, 0, 0], sum: 6, lastActiveTs: 55_000 });
  assert.deepEqual(s.get('2:2')!.tx, [0, 0, null, 0, 5]);
  assert.equal(s.get('3:3')!.lastActiveTs, null);
  assert.equal(buildSparks([], ['1:1']).get('1:1')!.tx.length, 0);
});

test('idle: live, no rate now and no traffic for 30 s; ended rows never idle', () => {
  const spark = (lastActiveTs: number | null): Spark => ({ tx: [], rx: [], sum: 0, lastActiveTs });
  assert.equal(isIdle(row('1:1'), spark(null), 100_000), true);
  assert.equal(isIdle(row('1:1'), spark(70_000), 100_000), true);
  assert.equal(isIdle(row('1:1'), spark(71_000), 100_000), false);
  assert.equal(isIdle(row('1:1', { rxKbps: 1 }), spark(null), 100_000), false);
  assert.equal(isIdle(row('1:1', { endedMs: 1 }), spark(null), 100_000), false);
});

test('filter: case-insensitive substring of name or cmdline', () => {
  const r = row('1:1', { name: 'Chrome', cmdline: '/opt/google/chrome --type=renderer' });
  assert.ok(matchesFilter(r, 'chrome'));
  assert.ok(matchesFilter(r, ' RENDERER '));
  assert.ok(matchesFilter(r, ''));
  assert.ok(!matchesFilter(r, 'firefox'));
});

test('sort param: parse, toggle, fall back to the default', () => {
  assert.deepEqual(parseSort('-rate'), { key: 'rate', desc: true });
  assert.deepEqual(parseSort('name'), { key: 'name', desc: false });
  assert.deepEqual(parseSort('bogus'), { key: 'rate', desc: true });
  assert.deepEqual(nextSort({ key: 'rate', desc: true }, 'tx'), { key: 'tx', desc: true });
  assert.deepEqual(nextSort({ key: 'rate', desc: true }, 'name'), { key: 'name', desc: false });
  assert.deepEqual(nextSort({ key: 'tx', desc: true }, 'tx'), { key: 'tx', desc: false });
});

test('sorts by rate, text and age; ties keep id order; shared pids stay separate rows', () => {
  const rows = [
    row('7:200', { txKbps: 1, rxKbps: 1, startMs: 2000, name: 'b' }),
    row('7:100', { txKbps: 5, startMs: 1000, name: 'a', endedMs: 1500 }), // same pid, earlier instance
    row('9:1', { rxKbps: 2, startMs: 3000, name: 'B' }),
  ];
  const ids = (rs: LiveProcessRow[]) => rs.map((r) => r.id);
  const none = new Map<string, Spark>();
  assert.deepEqual(ids(sortRows(rows, parseSort('-rate'), none)), ['7:100', '7:200', '9:1']);
  assert.deepEqual(ids(sortRows(rows, parseSort('name'), none)), ['7:100', '7:200', '9:1']); // b == B: by id
  assert.deepEqual(ids(sortRows(rows, parseSort('-age'), none)), ['7:100', '7:200', '9:1']); // oldest first
  assert.deepEqual(ids(sortRows(rows, parseSort('age'), none)), ['9:1', '7:200', '7:100']);
});
