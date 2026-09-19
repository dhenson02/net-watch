import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lifetimesQuery, toLifetimeBar } from './lifetimes.ts';

test('lifetimesQuery: user input only as params, filters only when set, latest start first', () => {
  const plain = lifetimesQuery({ from: 1, to: 2, limit: 501 });
  assert.deepEqual(plain.params, { from: 1, to: 2, limit: 501 });
  assert.doesNotMatch(plain.sql, /name =|uid =/);
  assert.match(plain.sql, /HAVING en IS NULL OR en >= /);
  assert.match(plain.sql, /ORDER BY st DESC/);
  const q = lifetimesQuery({ from: 1, to: 2, limit: 10, name: "o'brien", uid: 1000 });
  assert.match(q.sql, /name = \{name:String\}/);
  assert.match(q.sql, /uid = \{uid:UInt32\}/);
  assert.doesNotMatch(q.sql, /o'brien/);
  assert.deepEqual(q.params, { from: 1, to: 2, limit: 10, name: "o'brien", uid: 1000 });
});

test('toLifetimeBar: id stays a string, 64-bit values become numbers, null end kept, first I/O not before start', () => {
  const row = {
    pid: 42,
    start_ns: '18446744073709551615',
    pname: 'curl',
    cmd: 'curl https://x',
    puid: 1000,
    start_ms_: '1000',
    first_seen_ms: '1500',
    last_seen_ms: '1800',
    ended_ms: null,
    tx: '123',
    rx: '9007199254740993',
  };
  assert.deepEqual(toLifetimeBar(row), {
    id: '42:18446744073709551615',
    pid: 42,
    name: 'curl',
    cmdline: 'curl https://x',
    uid: 1000,
    startMs: 1000,
    firstSeenMs: 1500,
    lastSeenMs: 1800,
    endedMs: null,
    tx: 123,
    rx: 9007199254740992,
  });
  const skew = toLifetimeBar({ ...row, first_seen_ms: '900', ended_ms: '2000' });
  assert.equal(skew.firstSeenMs, 1000);
  assert.equal(skew.endedMs, 2000);
});
