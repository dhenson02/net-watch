import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BY_COLUMNS, DEST_FILTER, DIMENSIONS, filterSql, flowSource, parseBy, parseDest, parseFilters, UNKNOWN_UID } from './sql.ts';

test('parses ip:port destinations, IPv4 and IPv6', () => {
  assert.equal(parseDest(undefined), null);
  assert.equal(parseDest(''), null);
  assert.deepEqual(parseDest('1.2.3.4:443'), { dest_ip: '1.2.3.4', dest_port: 443 });
  assert.deepEqual(parseDest('2001:db8::1:443'), { dest_ip: '2001:db8::1', dest_port: 443 });
  assert.deepEqual(parseDest('[2001:db8::1]:53'), { dest_ip: '2001:db8::1', dest_port: 53 });
  assert.deepEqual(parseDest('0.0.0.0:0'), { dest_ip: '0.0.0.0', dest_port: 0 });
});

const is400 = (e: Error & { statusCode?: number }) => e.statusCode === 400;

test('parseBy: whitelisted dimensions only', () => {
  assert.equal(parseBy(undefined), 'app');
  assert.equal(parseBy(''), 'app');
  for (const d of DIMENSIONS) assert.equal(parseBy(d), d);
  for (const bad of ['toString(uid)', 'App', 'raddr', ['app']]) assert.throws(() => parseBy(bad), is400, JSON.stringify(bad));
  assert.deepEqual(Object.keys(BY_COLUMNS).sort(), [...DIMENSIONS].sort());
});

test('parseFilters: exact strings, integer uid, ip:port dest', () => {
  assert.deepEqual(parseFilters({}), {});
  assert.deepEqual(parseFilters({ name: '', app: '', uid: '', dest: '' }), {});
  assert.deepEqual(parseFilters({ name: 'chrome', app: 'HTTPS', proto: 'TCP', uid: '1000', dest: '[::1]:53', other: 'x' }), {
    name: 'chrome',
    app: 'HTTPS',
    proto: 'TCP',
    uid: 1000,
    dest: { dest_ip: '::1', dest_port: 53 },
  });
  for (const bad of [{ uid: '-1' }, { uid: '1e3' }, { uid: '4294967296' }, { name: 'x'.repeat(257) }, { app: ['a', 'b'] }, { dest: 'host:1' }]) {
    assert.throws(() => parseFilters(bad), is400, JSON.stringify(bad));
  }
});

test('filterSql: one constant fragment per set filter, values only in params', () => {
  assert.deepEqual(filterSql({}), { sql: '', params: {} });
  const f = filterSql({ name: "a' OR 1=1", uid: 0, dest: { dest_ip: '1.2.3.4', dest_port: 80 } });
  assert.equal(f.sql, ` AND name = {f_name:String} AND uid = {f_uid:UInt32} AND ${DEST_FILTER}`);
  assert.deepEqual(f.params, { f_name: "a' OR 1=1", f_uid: 0, dest_ip: '1.2.3.4', dest_port: 80 });
});

test('flowSource: the table, or the rollup joined to processes for uid', () => {
  assert.equal(flowSource('flows', 'T', true), 'flows');
  assert.equal(flowSource('flows_1m', 'T', false), 'flows_1m');
  const joined = flowSource('flows_1m', 'minute >= 1', true);
  assert.match(joined, /^\(SELECT .* AS uid\s+FROM flows_1m\s+LEFT JOIN .* USING \(pid, proc_start\)\s+WHERE minute >= 1\)$/s);
  assert.ok(joined.includes(String(UNKNOWN_UID)));
});

test('rejects anything else with 400', () => {
  for (const bad of ['1.2.3.4', ':443', '1.2.3.4:', '1.2.3.4:65536', '1.2.3.4:-1', 'example.com:443', "1.2.3.4' OR 1:1", ['1.2.3.4:1']]) {
    assert.throws(() => parseDest(bad), (e: Error & { statusCode?: number }) => e.statusCode === 400, JSON.stringify(bad));
  }
});
