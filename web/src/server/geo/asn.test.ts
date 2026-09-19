import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { Geo } from '../../shared/api.ts';
import { GeoDb, orgName, parseTable } from './asn.ts';
import { ipScope, parseIp, parseV4, parseV6 } from './ip.ts';

const FIXTURE = new URL('./fixtures/ip2asn-test.tsv', import.meta.url);

test('parseV4 / parseV6: valid forms, compressed zeros, dotted tails; junk is null', () => {
  assert.equal(parseV4('0.0.0.0'), 0);
  assert.equal(parseV4('255.255.255.255'), 0xffffffff);
  assert.equal(parseV4('1.2.3.4'), 0x01020304);
  for (const bad of ['1.2.3', '1.2.3.256', '1.2.3.4.5', 'a.b.c.d', '']) assert.equal(parseV4(bad), null, bad);

  assert.equal(parseV6('::'), 0n);
  assert.equal(parseV6('::1'), 1n);
  assert.equal(parseV6('2001:db8::1'), (0x20010db8n << 96n) | 1n);
  assert.equal(parseV6('2001:db8:0:0:0:0:0:1'), parseV6('2001:db8::1'));
  assert.equal(parseV6('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), (1n << 128n) - 1n);
  assert.equal(parseV6('fe80::'), 0xfe80n << 112n);
  assert.equal(parseV6('::ffff:1.2.3.4'), (0xffffn << 32n) | 0x01020304n);
  assert.equal(parseV6('64:ff9b::192.0.2.1'), (0x64ff9bn << 96n) | 0xc0000201n);
  for (const bad of ['1.2.3.4', '1::2::3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '::1:2:3:4:5:6:7:8', 'g::1', '12345::', '::ffff:1.2.3.999']) {
    assert.equal(parseV6(bad), null, bad);
  }
});

test('parseIp: IPv4-mapped IPv6 becomes IPv4', () => {
  assert.deepEqual(parseIp('::ffff:10.1.2.3'), { v: 4, n: parseV4('10.1.2.3') });
  assert.deepEqual(parseIp('10.1.2.3'), { v: 4, n: parseV4('10.1.2.3') });
  assert.deepEqual(parseIp('2606:4700::1'), { v: 6, n: parseV6('2606:4700::1') });
  assert.equal(parseIp('example.com'), null);
});

test('ipScope: local ranges vs public', () => {
  const scope = (s: string) => ipScope(parseIp(s)!);
  assert.equal(scope('0.0.0.0'), 'unspecified');
  assert.equal(scope('::'), 'unspecified');
  assert.equal(scope('127.0.0.53'), 'loopback');
  assert.equal(scope('::1'), 'loopback');
  assert.equal(scope('10.75.167.1'), 'private');
  assert.equal(scope('172.16.0.1'), 'private');
  assert.equal(scope('172.31.255.255'), 'private');
  assert.equal(scope('172.32.0.1'), 'public');
  assert.equal(scope('192.168.1.255'), 'private');
  assert.equal(scope('100.64.0.1'), 'private');
  assert.equal(scope('169.254.1.1'), 'link-local');
  assert.equal(scope('fe80::e88:32ff:fe36:5d81'), 'link-local');
  assert.equal(scope('239.255.255.250'), 'multicast');
  assert.equal(scope('224.0.0.251'), 'multicast');
  assert.equal(scope('255.255.255.255'), 'multicast');
  assert.equal(scope('ff02::fb'), 'multicast');
  assert.equal(scope('fd12:3456::1'), 'private');
  assert.equal(scope('1.1.1.1'), 'public');
  assert.equal(scope('::ffff:140.82.114.4'), 'public');
  assert.equal(scope('2607:f8b0:4002:c0f::5f'), 'public');
});

test('orgName: the org part after " - ", else the whole description', () => {
  assert.equal(orgName('AMAZON-02 - Amazon.com, Inc.'), 'Amazon.com, Inc.');
  assert.equal(orgName('GOOGLE'), 'GOOGLE');
  assert.equal(orgName('CLOUDFLARESPECTRUM Cloudflare'), 'CLOUDFLARESPECTRUM Cloudflare');
  assert.equal(orgName('  X - '), 'X -');
});

test('parseTable: v4 and v6 ranges, bounds inclusive, unrouted and gaps miss', async () => {
  const { table, skipped } = await parseTable(await readFile(FIXTURE, 'utf8'));
  assert.equal(skipped, 0);
  // 23 lines, 3 "Not routed".
  assert.equal(table.size, 20);
  const g = (ip: string) => table.lookup(ip);
  assert.deepEqual(g('1.1.1.1'), { asn: 13335, org: 'Cloudflare, Inc.', cc: 'US' });
  assert.deepEqual(g('::ffff:1.1.1.1'), g('1.1.1.1'));
  assert.equal(g('1.1.1.0')?.asn, 13335);
  assert.equal(g('1.1.1.255')?.asn, 13335);
  assert.equal(g('1.1.2.0'), null);
  assert.equal(g('1.1.0.255'), null);
  assert.equal(g('10.1.2.3'), null, 'not routed');
  assert.equal(g('0.0.0.0'), null);
  assert.equal(g('3.165.181.8')?.asn, 16509);
  assert.equal(g('162.254.199.184')?.cc, 'NL');
  assert.equal(g('2607:f8b0:4002:c0f::5f')?.asn, 15169);
  assert.equal(g('2607:f8b0::')?.asn, 15169);
  assert.equal(g('2607:f8b0:ffff:ffff:ffff:ffff:ffff:ffff')?.asn, 15169);
  assert.equal(g('2607:f8b1::'), null);
  assert.equal(g('2607:f8af:ffff::'), null);
  assert.deepEqual(g('2a06:98c1:52::3'), { asn: 209242, org: 'CLOUDFLARESPECTRUM Cloudflare', cc: 'DE' });
  assert.equal(g('2606:7100:1:67::26'), null, 'no range');
  assert.equal(g('::'), null);
  assert.equal(g('not an ip'), null);
  // One info entry per distinct (asn, cc, org).
  assert.equal(table.infos.filter((i) => i.asn === 15169).length, 1);
  assert.equal(table.infos.filter((i) => i.asn === 13335).length, 2, 'US and BR');
});

test('parseTable: unsorted input, CRLF, short lines and bad addresses are skipped', async () => {
  const text = ['9.0.0.0\t9.0.0.255\t9\tUS\tNINE', '1.0.0.0\t1.0.0.255\t1\tAU\tONE\r', 'junk', '5.0.0.9\t5.0.0.1\t5\tUS\tBACKWARDS', 'x::\ty::\t7\tUS\tBAD', '2001::\t2001::ff\t8\tUnknown\tEIGHT'].join('\n');
  const { table, skipped } = await parseTable(text, async () => {}, 2);
  assert.equal(skipped, 3);
  assert.equal(table.lookup('1.0.0.7')?.org, 'ONE');
  assert.equal(table.lookup('9.0.0.7')?.asn, 9);
  assert.equal(table.lookup('2001::7')?.cc, '');
});

test('GeoDb: loads plain and gzipped files, enrich only sets geo on known IPs, missing file is not loaded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'geo-'));
  try {
    const text = await readFile(FIXTURE);
    await writeFile(join(dir, 't.tsv.gz'), gzipSync(text));
    for (const f of [FIXTURE.pathname, join(dir, 't.tsv.gz')]) {
      const db = new GeoDb(f);
      await db.start();
      db.stop();
      const s = db.status();
      assert.equal(s.loaded, true);
      assert.equal(s.entries, 20);
      assert.equal(s.error, null);
      assert.ok(s.fileDate! > 0);
      const rows = db.enrich<{ ip: string; geo?: Geo }>([{ ip: '140.82.114.4' }, { ip: '192.168.1.66' }, { ip: '2607:6bc0::10' }]);
      assert.equal(rows[0]!.geo?.org, 'GitHub, Inc.');
      assert.ok(!('geo' in rows[1]!));
      assert.equal(rows[2]!.geo?.asn, 399358);
    }
    const none = new GeoDb(join(dir, 'missing.tsv'));
    await none.start();
    none.stop();
    assert.equal(none.loaded, false);
    assert.match(none.status().error!, /not found/);
    const rows = none.enrich([{ ip: '1.1.1.1' }]);
    assert.ok(!('geo' in rows[0]!));
    assert.equal(none.lookup('1.1.1.1'), null);

    await writeFile(join(dir, 'empty.tsv'), 'nothing here\n');
    const empty = new GeoDb(join(dir, 'empty.tsv'));
    await empty.start();
    empty.stop();
    assert.equal(empty.loaded, false);
    assert.match(empty.status().error!, /no ranges/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
