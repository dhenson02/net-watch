import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseTable } from '../geo/asn.ts';
import type { ParsedIp } from '../geo/ip.ts';
import { buildDestinations, buildGeoBreakdown, destinationsQuery, ipTotalsQueries, parseDestSelection, parseGeoDir, type DestQueryRow } from './geo.ts';
import { parseRange } from './range.ts';

const { table } = await parseTable(await readFile(new URL('../geo/fixtures/ip2asn-test.tsv', import.meta.url), 'utf8'));
const lookup = (ip: ParsedIp) => table.lookupParsed(ip);
const r = parseRange({ from: '0', to: String(24 * 3_600_000) });

test('parseGeoDir / parseDestSelection: defaults and validation', () => {
  assert.equal(parseGeoDir(undefined), 'total');
  assert.equal(parseGeoDir('rx'), 'rx');
  assert.throws(() => parseGeoDir('both'), /dir/);
  assert.deepEqual(parseDestSelection({}), { scope: 'all' });
  assert.deepEqual(parseDestSelection({ asn: '15169', cc: 'US', scope: 'public' }), { asn: 15169, cc: 'US', scope: 'public' });
  assert.throws(() => parseDestSelection({ asn: '0' }), /asn/);
  assert.throws(() => parseDestSelection({ asn: 'AS1' }), /asn/);
  assert.throws(() => parseDestSelection({ cc: 'us' }), /cc/);
  assert.throws(() => parseDestSelection({ scope: 'x' }), /scope/);
});

test('queries: input only as params, ranking follows dir, filters and uid join', () => {
  const q = ipTotalsQueries(r, 'rx', { name: "o'brien", uid: 1000 });
  assert.match(q.perIp.sql, /GROUP BY raddr/);
  assert.match(q.perIp.sql, /ORDER BY rx DESC/);
  assert.match(q.perIp.sql, /LIMIT \{limit:UInt32\}/);
  assert.match(q.totals.sql, /uniqExactIf\(raddr, rx_bytes > 0\)/);
  assert.match(q.perIp.sql, /LEFT JOIN/, 'uid on the rollup joins processes');
  assert.doesNotMatch(q.perIp.sql, /o'brien/);
  assert.equal((q.perIp.params as Record<string, unknown>).f_name, "o'brien");
  assert.equal(q.perIp.params.limit, 5000);
  const d = destinationsQuery(r, 'total', {}, 11);
  assert.match(d.sql, /GROUP BY raddr, rport\n/);
  assert.match(d.sql, /ORDER BY tx \+ rx DESC/);
  assert.equal(d.params.limit, 11);
});

const ips = [
  { ip: '2607:f8b0:4002:c0f::5f', tx: '100', rx: '900' }, // Google, US
  { ip: '2001:4860:482c:7700::', tx: '50', rx: '50' }, // Google, US
  { ip: '127.0.0.1', tx: '5000', rx: '5000' }, // loopback
  { ip: '192.168.1.254', tx: '10', rx: '20' }, // private
  { ip: '2a06:98c1:52::3', tx: '300', rx: '0' }, // Cloudflare spectrum, DE
  { ip: '2606:7100:1:67::26', tx: '7', rx: '3' }, // public, unknown to the table
  { ip: '1.1.1.1', tx: '40', rx: '60' }, // Cloudflare US
  { ip: '2803:f800:53::3', tx: '1', rx: '1' }, // Cloudflare BR
];

test('buildGeoBreakdown: ASNs and countries, local and unmatched apart, coverage', () => {
  const b = buildGeoBreakdown(ips, { tx: '6000', rx: '6100', ips: '20' }, { r, dir: 'total', lookup });
  assert.equal(b.base.geo, true);
  assert.deepEqual(b.base.local, { tx: 5010, rx: 5020, bytes: 10030, ips: 2 });
  assert.deepEqual(b.base.unmatched, { tx: 7, rx: 3, bytes: 10, ips: 1 });
  assert.deepEqual(
    b.asns.map((a) => [a.asn, a.bytes, a.ips, a.country]),
    [
      [15169, 1100, 2, 'US'],
      [209242, 300, 1, 'DE'],
      [13335, 102, 2, 'US'],
    ],
  );
  assert.deepEqual(b.asns[0]!, { asn: 15169, org: 'Google LLC', country: 'US', tx: 150, rx: 950, bytes: 1100, ips: 2 });
  assert.deepEqual(
    b.countries.map((c) => [c.country, c.bytes]),
    [
      ['US', 1200],
      ['DE', 300],
      ['BR', 2],
    ],
  );
  const covered = 1000 + 100 + 10000 + 30 + 300 + 10 + 100 + 2;
  assert.deepEqual(b.base.coverage, { ips: 8, totalIps: 20, bytes: covered, totalBytes: 12100 });

  // One direction: ranks and sums by it.
  const tx = buildGeoBreakdown(ips, { tx: '6000', rx: '6100', ips: '20' }, { r, dir: 'tx', lookup });
  assert.deepEqual(
    tx.asns.map((a) => [a.asn, a.bytes]),
    [
      [209242, 300],
      [15169, 150],
      [13335, 41],
    ],
  );
  assert.equal(tx.base.coverage.totalBytes, 6000);

  // No table: everything public is unmatched.
  const none = buildGeoBreakdown(ips, undefined, { r, dir: 'total', lookup: null });
  assert.equal(none.base.geo, false);
  assert.deepEqual(none.asns, []);
  assert.deepEqual(none.countries, []);
  assert.equal(none.base.unmatched.ips, 6);
  assert.equal(none.base.coverage.totalBytes, covered, 'never below what was examined');
});

const dest = (o: Partial<DestQueryRow>): DestQueryRow => ({ ip: '1.1.1.1', rport: 443, tx: '1', rx: '2', app: 'tls', proto: 'TCP', procs: '1', names: ['curl'], ...o });

test('buildDestinations: geo, local flag, selections, limit and matched', () => {
  const rows = [
    dest({ ip: '2607:f8b0:4002:c0f::5f', rport: 443, tx: '10', rx: '90', procs: '3', names: ['chrome', 'curl'] }),
    dest({ ip: '127.0.0.53', rport: 53, app: 'dns', proto: 'UDP' }),
    dest({ ip: '1.1.1.1', rport: 53, app: 'dns', proto: 'UDP' }),
    dest({ ip: '2606:7100:1:67::26' }),
    dest({ ip: '2001:4860:482c:7700::', rport: 443 }),
  ];
  const all = buildDestinations(rows, { scope: 'all' }, lookup, 10);
  assert.equal(all.matched, 5);
  assert.deepEqual(all.rows[0], {
    ip: '2607:f8b0:4002:c0f::5f',
    port: 443,
    dest: '[2607:f8b0:4002:c0f::5f]:443',
    geo: { asn: 15169, org: 'Google LLC', cc: 'US' },
    local: false,
    app: 'tls',
    proto: 'TCP',
    tx: 10,
    rx: 90,
    procs: 3,
    names: ['chrome', 'curl'],
  });
  assert.equal(all.rows[1]!.local, true);
  assert.ok(!('geo' in all.rows[1]!));
  assert.equal(all.rows[2]!.dest, '1.1.1.1:53');

  const google = buildDestinations(rows, { asn: 15169, scope: 'all' }, lookup, 1);
  assert.equal(google.matched, 2);
  assert.equal(google.rows.length, 1);
  assert.deepEqual(buildDestinations(rows, { cc: 'US', scope: 'all' }, lookup, 10).matched, 3);
  assert.deepEqual(buildDestinations(rows, { scope: 'local' }, lookup, 10).rows.map((d) => d.ip), ['127.0.0.53']);
  assert.deepEqual(buildDestinations(rows, { scope: 'unmatched' }, lookup, 10).rows.map((d) => d.ip), ['2606:7100:1:67::26']);
  assert.equal(buildDestinations(rows, { scope: 'public' }, lookup, 10).matched, 4);
  // Without a table nothing has geo, and an ASN selection matches nothing.
  assert.equal(buildDestinations(rows, { scope: 'all' }, null, 10).rows.filter((d) => d.geo).length, 0);
  assert.equal(buildDestinations(rows, { asn: 15169, scope: 'all' }, null, 10).matched, 0);
});
