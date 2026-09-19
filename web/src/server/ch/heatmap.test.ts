import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEATMAP_CELLS } from '../../shared/api.ts';
import { buildHeatmap, HEATMAP_DEFAULT_SPAN, heatmapQuery, parseHeatRange, parseMetric, parseSplit, sampleCounts } from './heatmap.ts';

const DAY = 86_400_000;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

test('parseMetric / parseSplit: defaults and whitelist', () => {
  assert.equal(parseMetric(undefined), 'total');
  assert.equal(parseMetric(''), 'total');
  assert.equal(parseMetric('rx'), 'rx');
  assert.throws(() => parseMetric('tx_bytes'), /metric/);
  assert.throws(() => parseMetric(['tx']), /metric/);
  assert.equal(parseSplit(undefined), 'none');
  assert.equal(parseSplit('app'), 'app');
  assert.throws(() => parseSplit('name'), /split/);
});

test('parseHeatRange: four weeks by default, validated, capped', () => {
  const now = 1_789_800_000_000;
  assert.deepEqual(parseHeatRange({}, now), { from: now - HEATMAP_DEFAULT_SPAN, to: now });
  assert.deepEqual(parseHeatRange({ from: '1000', to: '2000' }, now), { from: 1000, to: 2000 });
  assert.throws(() => parseHeatRange({ from: '2000', to: '1000' }, now), /before/);
  assert.throws(() => parseHeatRange({ from: '-5' }, now), /from/);
  assert.throws(() => parseHeatRange({ from: String(now - 400 * DAY) }, now), /366/);
});

test('heatmapQuery: metric from the whitelist, tz and filters as params', () => {
  const q = heatmapQuery({ from: 1, to: 2, tz: 'Europe/Paris', metric: 'tx', split: 'none', filters: { app: "o'app" } });
  assert.match(q.sql, /toDayOfWeek\(minute, 0, \{tz:String\}\) AS dow/);
  assert.match(q.sql, /toHour\(minute, \{tz:String\}\) AS hour/);
  assert.match(q.sql, /sum\(tx_bytes\) AS bytes/);
  assert.match(q.sql, /FROM flows_1m/);
  assert.match(q.sql, /AND app = \{f_app:String\}/);
  assert.doesNotMatch(q.sql, /o'app|Paris/);
  assert.doesNotMatch(q.sql, /app IN/);
  assert.deepEqual(q.params, { from: 1, to: 2, tz: 'Europe/Paris', f_app: "o'app" });

  const s = heatmapQuery({ from: 1, to: 2, tz: 'UTC', metric: 'total', split: 'app', filters: { uid: 1000 } });
  assert.match(s.sql, /SELECT app AS key/);
  assert.match(s.sql, /app IN \(SELECT app FROM .* ORDER BY sum\(tx_bytes \+ rx_bytes\) DESC, app LIMIT 4\)/s);
  // uid needs the processes join (flows_1m has no uid column).
  assert.match(s.sql, /LEFT JOIN/);
  assert.equal(s.params.f_uid, 1000);
});

test('sampleCounts: whole weeks give equal counts, partial hours count, tz-aware', () => {
  // 2026-09-07 is a Monday.
  const mon = Date.parse('2026-09-07T00:00:00Z');
  const four = sampleCounts(mon, mon + 28 * DAY, 'UTC');
  assert.equal(four.length, HEATMAP_CELLS);
  assert.ok(four.every((n) => n === 4));

  // 10:30 to 12:00 UTC on Monday: hours 10 (partial) and 11.
  const part = sampleCounts(mon + 10.5 * 3600_000, mon + 12 * 3600_000, 'UTC');
  assert.equal(sum(part), 2);
  assert.equal(part[10], 1);
  assert.equal(part[11], 1);

  // Monday 00:00 UTC is Sunday 20:00 in New York (EDT, UTC-4).
  const ny = sampleCounts(mon, mon + 3600_000, 'America/New_York');
  assert.equal(ny[6 * 24 + 20], 1);
  assert.equal(sum(ny), 1);

  // A half-hour zone: Monday 00:00-01:00 UTC is 05:30-06:30 in India, two local hours.
  const ist = sampleCounts(mon, mon + 3600_000, 'Asia/Kolkata');
  assert.deepEqual([ist[5], ist[6], sum(ist)], [1, 1, 2]);
});

test('sampleCounts: the DST day has 23 local hours, the repeated hour counts once', () => {
  // US DST starts 2026-03-08 (02:00 skipped) and ends 2026-11-01 (01:00 twice).
  const spring = sampleCounts(Date.parse('2026-03-08T05:00:00Z'), Date.parse('2026-03-09T04:00:00Z'), 'America/New_York');
  assert.equal(sum(spring), 23);
  assert.equal(spring[6 * 24 + 2], 0);
  const fall = sampleCounts(Date.parse('2026-11-01T04:00:00Z'), Date.parse('2026-11-02T05:00:00Z'), 'America/New_York');
  assert.equal(sum(fall), 24);
  assert.equal(fall[6 * 24 + 1], 1);
});

test('buildHeatmap: bytes per sample as kbps, null without samples, grids largest first', () => {
  const samples = new Array<number>(HEATMAP_CELLS).fill(4);
  samples[167] = 0;
  const base = { from: 0, to: 1, tz: 'UTC', metric: 'total' as const, split: 'app' as const, coveredFrom: 0 };
  const out = buildHeatmap(
    [
      // Tuesday 03:00: 4 samples, 1.8 GB total → 450 MB per hour → 1000 kbps.
      { key: 'DNS', dow: 2, hour: 3, bytes: '1800000000', days: '2' },
      { key: 'HTTPS', dow: 1, hour: 0, bytes: '3600000000', days: '4' },
      { key: 'HTTPS', dow: 7, hour: 23, bytes: '5', days: '1' },
    ],
    base,
    samples,
  );
  assert.deepEqual(
    out.grids.map((g) => g.key),
    ['HTTPS', 'DNS'],
  );
  const [https, dns] = out.grids;
  assert.equal(dns!.kbps[24 + 3], 1000);
  assert.equal(dns!.active[24 + 3], 2);
  assert.equal(dns!.kbps[0], 0);
  assert.equal(https!.kbps[0], 2000);
  assert.equal(https!.kbps[167], null);
  assert.equal(https!.bytes, 3600000005);
  assert.equal(out.samples, samples);

  const none = buildHeatmap([{ key: '', dow: 1, hour: 0, bytes: 1, days: 1 }], { ...base, split: 'none' }, samples);
  assert.equal(none.grids[0]!.key, null);
  assert.deepEqual(buildHeatmap([], base, samples).grids, []);
});
