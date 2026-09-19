import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AsnRow } from '../../shared/api.ts';
import { asnBars, asnLabel, clip, countryName, coverageText, geoAgeDays, mapData, orgDestLabel, parseDestPageParams, pctText, shortOrg } from './geoView.ts';

test('parseDestPageParams: defaults, valid values, junk ignored', () => {
  assert.deepEqual(parseDestPageParams(''), { dir: 'total', asn: null, cc: null, scope: 'all' });
  assert.deepEqual(parseDestPageParams('?dir=rx&asn=15169&cc=DE&scope=local'), { dir: 'rx', asn: 15169, cc: 'DE', scope: 'local' });
  assert.deepEqual(parseDestPageParams('?dir=both&asn=AS1&cc=de&scope=x'), { dir: 'total', asn: null, cc: null, scope: 'all' });
  assert.equal(parseDestPageParams('?asn=0').asn, null);
});

test('shortOrg / asnLabel / orgDestLabel: legal suffixes dropped, long orgs clipped', () => {
  assert.equal(shortOrg('Amazon.com, Inc.'), 'Amazon.com');
  assert.equal(shortOrg('Google LLC'), 'Google');
  assert.equal(shortOrg('Datacamp Limited'), 'Datacamp');
  assert.equal(shortOrg('Anthropic, PBC'), 'Anthropic');
  assert.equal(shortOrg('Deutsche Telekom AG'), 'Deutsche Telekom');
  assert.equal(shortOrg('GOOGLE'), 'GOOGLE');
  assert.equal(shortOrg('Inc'), 'Inc', 'never empty');
  assert.equal(asnLabel({ asn: 16509, org: 'Amazon.com, Inc.' }), 'AS16509 Amazon.com');
  assert.equal(orgDestLabel({ asn: 15169, org: 'Google LLC', cc: 'US' }, '[2607:f8b0::5f]:443'), 'Google ([2607:f8b0::5f]:443)');
  assert.equal(orgDestLabel(undefined, '10.0.0.1:53'), '10.0.0.1:53');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abc', 4), 'abc');
});

test('countryName: English names, the code when unknown', () => {
  assert.equal(countryName('DE'), 'Germany');
  assert.equal(countryName(''), 'unknown country');
  assert.equal(countryName('ZZ'), 'ZZ');
});

const asn = (n: number, tx: number, rx: number): AsnRow => ({ asn: n, org: `Org ${n}`, country: 'US', tx, rx, bytes: tx + rx, ips: 1 });

test('asnBars: top N, largest on top (last), rx negative', () => {
  const rows = [asn(1, 10, 90), asn(2, 50, 0), asn(3, 1, 1)];
  const b = asnBars(rows, 2);
  assert.deepEqual(b.asns, [2, 1]);
  assert.deepEqual(b.labels, ['AS2 Org 2', 'AS1 Org 1']);
  assert.deepEqual(b.tx, [50, 10]);
  assert.deepEqual(b.rx, [-0, -90]);
  assert.equal(b.rows[1]!.asn, 1);
});

test('mapData: log10 values, whole-decade extent, zero rows dropped', () => {
  const m = mapData([
    { country: 'US', tx: 0, rx: 0, bytes: 1_000_000, ips: 3 },
    { country: 'DE', tx: 0, rx: 0, bytes: 250, ips: 1 },
    { country: 'FR', tx: 0, rx: 0, bytes: 0, ips: 1 },
  ]);
  assert.deepEqual(
    m.data.map((d) => [d.name, Number(d.value.toFixed(3))]),
    [
      ['US', 6],
      ['DE', 2.398],
    ],
  );
  assert.equal(m.min, 2);
  assert.equal(m.max, 6);
  assert.deepEqual(mapData([]), { data: [], min: 0, max: 1 });
  const one = mapData([{ country: 'US', tx: 0, rx: 0, bytes: 100, ips: 1 }]);
  assert.deepEqual([one.min, one.max], [2, 3]);
});

test('coverageText / pctText / geoAgeDays', () => {
  assert.equal(coverageText({ coverage: { ips: 10, totalIps: 10, bytes: 5, totalBytes: 5 } }), null);
  assert.equal(
    coverageText({ coverage: { ips: 5000, totalIps: 7000, bytes: 992, totalBytes: 1000 } }),
    'approximate: the top 5,000 of 7,000 IPs carry 99.2 % of the bytes',
  );
  assert.match(coverageText({ coverage: { ips: 5000, totalIps: 7000, bytes: 99999, totalBytes: 100000 } })!, /> 99\.9 %/);
  assert.equal(pctText(1, 3), '33.3 %');
  assert.equal(pctText(1, 10_000), '< 0.1 %');
  assert.equal(pctText(0, 10), '0.0 %');
  assert.equal(pctText(1, 0), '—');
  assert.equal(geoAgeDays(null, 5), null);
  assert.equal(geoAgeDays(0, 3 * 86_400_000 + 5), 3);
});
