import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDest } from './sql.ts';

test('parses ip:port destinations, IPv4 and IPv6', () => {
  assert.equal(parseDest(undefined), null);
  assert.equal(parseDest(''), null);
  assert.deepEqual(parseDest('1.2.3.4:443'), { dest_ip: '1.2.3.4', dest_port: 443 });
  assert.deepEqual(parseDest('2001:db8::1:443'), { dest_ip: '2001:db8::1', dest_port: 443 });
  assert.deepEqual(parseDest('[2001:db8::1]:53'), { dest_ip: '2001:db8::1', dest_port: 53 });
  assert.deepEqual(parseDest('0.0.0.0:0'), { dest_ip: '0.0.0.0', dest_port: 0 });
});

test('rejects anything else with 400', () => {
  for (const bad of ['1.2.3.4', ':443', '1.2.3.4:', '1.2.3.4:65536', '1.2.3.4:-1', 'example.com:443', "1.2.3.4' OR 1:1", ['1.2.3.4:1']]) {
    assert.throws(() => parseDest(bad), (e: Error & { statusCode?: number }) => e.statusCode === 400, JSON.stringify(bad));
  }
});
