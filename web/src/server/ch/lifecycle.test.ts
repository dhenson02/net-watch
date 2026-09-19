import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lifecycleQuery, MAX_NAMES, parseNames, toLifecycleProc } from './lifecycle.ts';

test('parseNames: comma list or repeated params, deduped; empty is no filter', () => {
  assert.equal(parseNames(undefined), undefined);
  assert.equal(parseNames(''), undefined);
  assert.equal(parseNames(','), undefined);
  assert.deepEqual(parseNames('curl,firefox,curl'), ['curl', 'firefox']);
  assert.deepEqual(parseNames(['a,b', 'c']), ['a', 'b', 'c']);
  assert.throws(() => parseNames(Array.from({ length: MAX_NAMES + 1 }, (_, i) => `n${i}`).join(',')), /at most/);
  assert.throws(() => parseNames('x'.repeat(300)), /longer/);
  assert.throws(() => parseNames({}), /comma-separated/);
});

test('lifecycleQuery: user input only as params, filters only when set', () => {
  const plain = lifecycleQuery({ from: 1, to: 2, limit: 201 });
  assert.deepEqual(plain.params, { from: 1, to: 2, limit: 201 });
  assert.doesNotMatch(plain.sql, /names|uid =/);
  const q = lifecycleQuery({ from: 1, to: 2, limit: 10, names: ["o'brien"], uid: 1000 });
  assert.match(q.sql, /name IN \{names:Array\(String\)\}/);
  assert.match(q.sql, /uid = \{uid:UInt32\}/);
  assert.doesNotMatch(q.sql, /o'brien/);
  assert.deepEqual(q.params, { from: 1, to: 2, limit: 10, names: ["o'brien"], uid: 1000 });
});

test('toLifecycleProc: id stays a string, 64-bit values become numbers, null end kept', () => {
  const p = toLifecycleProc({
    pid: 42,
    start_ns: '18446744073709551615',
    pname: 'curl',
    cmd: 'curl https://x',
    first_seen_ms: '1789785354733',
    ended_ms: null,
    bytes: '123456',
  });
  assert.deepEqual(p, { id: '42:18446744073709551615', pid: 42, name: 'curl', cmdline: 'curl https://x', firstSeenMs: 1789785354733, endedMs: null, bytes: 123456 });
  assert.equal(toLifecycleProc({ pid: 1, start_ns: '5', pname: 'a', cmd: '', first_seen_ms: '1', ended_ms: '9', bytes: '0' }).endedMs, 9);
});
