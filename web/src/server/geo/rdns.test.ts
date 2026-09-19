import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Lru, Rdns, RDNS_MAX_PER_REQUEST } from './rdns.ts';

test('Lru: evicts the least recently used, expires after the TTL', () => {
  let now = 0;
  const c = new Lru<number>(2, 100, () => now);
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1); // a is now the most recent
  c.set('c', 3);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.size, 2);
  now = 100;
  assert.equal(c.get('a'), undefined);
});

test('Rdns: disabled does nothing', async () => {
  let calls = 0;
  const r = new Rdns(false, async () => (calls++, ['x']));
  assert.deepEqual(await r.lookup(['1.1.1.1']), { names: {}, pending: [] });
  assert.equal(calls, 0);
});

test('Rdns: names, NXDOMAIN as null, cache hits, per-request cap, budget', async () => {
  const asked: string[] = [];
  const resolve = (ip: string) => {
    asked.push(ip);
    if (ip === 'slow') return new Promise<string[]>((res) => setTimeout(() => res(['late.example']), 800));
    if (ip.startsWith('nx')) return Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
    if (ip === 'fail') return Promise.reject(Object.assign(new Error('t'), { code: 'ETIMEOUT' }));
    return Promise.resolve([`${ip}.example`, 'second']);
  };
  const r = new Rdns(true, resolve);
  const first = await r.lookup(['a', 'nx1', 'a', 'slow', 'fail']);
  assert.deepEqual(first.names, { a: 'a.example', nx1: null, fail: null });
  assert.deepEqual(first.pending, ['slow']);

  asked.length = 0;
  const again = await r.lookup(['a', 'nx1', 'fail']);
  assert.deepEqual(again.names, { a: 'a.example', nx1: null, fail: null });
  // A failure other than "no such name" is not cached.
  assert.deepEqual(asked, ['fail']);

  const many = Array.from({ length: RDNS_MAX_PER_REQUEST + 5 }, (_, i) => `h${i}`);
  const capped = await r.lookup(many);
  assert.equal(Object.keys(capped.names).length, RDNS_MAX_PER_REQUEST);
  assert.equal(capped.pending.length, 5);

  // The slow answer lands in the cache for the next request.
  await new Promise((res) => setTimeout(res, 400));
  assert.deepEqual((await r.lookup(['slow'])).names, { slow: 'late.example' });
});
