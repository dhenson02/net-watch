import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LifecycleProc } from '../../shared/api.ts';
import { clusterMarkers, clusterTitle, lifecycleEvents, parseEventsMode, processPath, type LifecycleEvent } from './clusterMarkers.ts';

const proc = (id: string, name: string, firstSeenMs: number, endedMs: number | null, bytes = 0): LifecycleProc => ({
  id,
  pid: Number(id.split(':')[0]),
  name,
  cmdline: name,
  firstSeenMs,
  endedMs,
  bytes,
});
const ev = (t: number, name = 'a', bytes = 0): LifecycleEvent => ({ kind: 'start', t, proc: proc(`1:${t}`, name, t, null, bytes) });

test('parseEventsMode: known values, else off', () => {
  assert.equal(parseEventsMode('starts'), 'starts');
  assert.equal(parseEventsMode('all'), 'all');
  assert.equal(parseEventsMode(null), 'off');
  assert.equal(parseEventsMode('ends'), 'off');
});

test('lifecycleEvents: only events inside [from, to), per mode, oldest first', () => {
  const procs = [
    proc('1:1', 'early', 50, 150), // started before the range, ended in it
    proc('2:2', 'inside', 120, 180),
    proc('3:3', 'running', 110, null),
    proc('4:4', 'late', 190, 200), // ends exactly at `to`: excluded
  ];
  const r = { from: 100, to: 200 };
  assert.deepEqual(lifecycleEvents(procs, r, 'off'), { start: [], end: [] });
  const starts = lifecycleEvents(procs, r, 'starts');
  assert.deepEqual(
    starts.start.map((e) => [e.proc.name, e.t]),
    [
      ['running', 110],
      ['inside', 120],
      ['late', 190],
    ],
  );
  assert.deepEqual(starts.end, []);
  const all = lifecycleEvents(procs, r, 'all');
  assert.deepEqual(
    all.end.map((e) => [e.proc.name, e.kind, e.t]),
    [
      ['early', 'end', 150],
      ['inside', 'end', 180],
    ],
  );
});

test('clusterMarkers: events closer than 4 px merge, no marker spans 4 px or more', () => {
  // 10 ms per px: 4 px = 40 ms.
  const events = [ev(0), ev(10), ev(39), ev(40), ev(45), ev(200)];
  const out = clusterMarkers(events, 10);
  assert.deepEqual(
    out.map((c) => c.items.map((e) => e.t).sort((a, b) => a - b)),
    [[0, 10, 39], [40, 45], [200]],
  );
  assert.deepEqual(
    out.map((c) => c.t),
    [16, 43, 200], // mean times, rounded
  );
});

test('clusterMarkers: items largest first, name only when shared', () => {
  const [mixed, same] = clusterMarkers([ev(0, 'a', 5), ev(1, 'b', 50), ev(100, 'c', 1), ev(101, 'c', 2)], 1);
  assert.deepEqual(
    mixed!.items.map((e) => e.proc.name),
    ['b', 'a'],
  );
  assert.equal(mixed!.name, null);
  assert.equal(same!.name, 'c');
  assert.deepEqual(
    same!.items.map((e) => e.proc.bytes),
    [2, 1],
  );
});

test('clusterMarkers: a zero or tiny scale still keeps distinct times apart', () => {
  assert.equal(clusterMarkers([ev(0), ev(1), ev(2)], 0).length, 3);
  assert.equal(clusterMarkers([ev(5), ev(5)], 0).length, 2);
  assert.deepEqual(clusterMarkers([], 10), []);
});

test('clusterTitle and processPath', () => {
  const [one] = clusterMarkers([ev(0, 'curl')], 1);
  assert.equal(clusterTitle(one!), 'curl started talking');
  const [many] = clusterMarkers([ev(0), ev(1), ev(2)], 10);
  assert.equal(clusterTitle(many!), '3 starts');
  assert.equal(clusterTitle({ ...many!, kind: 'end' }), '3 ends');
  assert.equal(processPath('42:18446744073709551615'), '/process/42/18446744073709551615');
});
