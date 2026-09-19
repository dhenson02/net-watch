import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HeatmapGrid } from '../../shared/api.ts';
import {
  cellLabel,
  coveredDays,
  fromLog,
  heatData,
  heatWindow,
  lastOccurrence,
  parseMetric,
  parseSplit,
  parseWeeks,
  samplesText,
  toLog,
} from './heatmapCells.ts';

const HOUR = 3600_000;

test('params: defaults for anything unknown', () => {
  assert.equal(parseMetric(null), 'total');
  assert.equal(parseMetric('tx'), 'tx');
  assert.equal(parseMetric('bogus'), 'total');
  assert.equal(parseSplit('app'), 'app');
  assert.equal(parseSplit('name'), 'none');
  assert.equal(parseWeeks(null), '4');
  assert.equal(parseWeeks('12'), '12');
  assert.equal(parseWeeks('3'), '4');
});

test('heatWindow: whole weeks ending at the start of the current hour', () => {
  const now = Date.parse('2026-09-19T10:42:13Z');
  const w = heatWindow(4, now);
  assert.equal(w.to, Date.parse('2026-09-19T10:00:00Z'));
  assert.equal(w.to - w.from, 28 * 24 * HOUR);
  assert.deepEqual(heatWindow(4, now + 60_000), w);
});

test('toLog / fromLog round-trip; zero maps to zero', () => {
  assert.equal(toLog(0), 0);
  assert.equal(toLog(9), 1);
  for (const v of [0, 0.5, 42, 12_345]) assert.ok(Math.abs(fromLog(toLog(v)) - v) < 1e-9 * Math.max(1, v));
});

test('heatData: items for cells with samples, the max log, a floor for idle grids', () => {
  const kbps: (number | null)[] = new Array(168).fill(0);
  kbps[24 + 3] = 99;
  kbps[167] = null;
  const g: HeatmapGrid = { key: null, bytes: 1, kbps, active: new Array(168).fill(0) };
  const { data, max } = heatData(g);
  assert.equal(data.length, 167);
  assert.deepEqual(
    data.find((d) => d[3] === 27),
    [3, 1, 2, 27],
  );
  assert.equal(max, 2);
  assert.equal(heatData({ ...g, kbps: new Array(168).fill(0) }).max, toLog(1));
});

test('cellLabel and samplesText', () => {
  assert.equal(cellLabel(24 + 3), 'Tue 03:00–04:00');
  assert.equal(cellLabel(6 * 24 + 23), 'Sun 23:00–24:00');
  assert.equal(cellLabel(0), 'Mon 00:00–01:00');
  assert.equal(samplesText(1), '1 week');
  assert.equal(samplesText(4), '4 weeks');
});

test('lastOccurrence: the latest whole hour of that weekday and hour, tz-aware', () => {
  // Saturday 2026-09-19 10:42 UTC.
  const now = Date.parse('2026-09-19T10:42:00Z');
  // Tue 03:00 UTC → Tuesday 2026-09-15.
  assert.deepEqual(lastOccurrence(24 + 3, now, 'UTC'), { from: Date.parse('2026-09-15T03:00:00Z'), to: Date.parse('2026-09-15T04:00:00Z') });
  // Sat 09:00 has ended by 10:42; Sat 10:00 has not, so it is last week's.
  assert.equal(lastOccurrence(5 * 24 + 9, now, 'UTC')!.from, Date.parse('2026-09-19T09:00:00Z'));
  assert.equal(lastOccurrence(5 * 24 + 10, now, 'UTC')!.from, Date.parse('2026-09-12T10:00:00Z'));
  // Tue 03:00 in New York (EDT) is 07:00 UTC.
  assert.equal(lastOccurrence(24 + 3, now, 'America/New_York')!.from, Date.parse('2026-09-15T07:00:00Z'));
  // Half-hour zone: Tue 03:00 IST is Mon 21:30 UTC.
  assert.equal(lastOccurrence(24 + 3, now, 'Asia/Kolkata')!.from, Date.parse('2026-09-14T21:30:00Z'));
  // Sun 02:00 is skipped in New York on 2026-03-08: the week before is used.
  assert.equal(lastOccurrence(6 * 24 + 2, Date.parse('2026-03-08T12:00:00Z'), 'America/New_York')!.from, Date.parse('2026-03-01T07:00:00Z'));
});

test('coveredDays: from the later of the window start and the data start', () => {
  const to = 100 * 24 * HOUR;
  assert.equal(coveredDays(to - 28 * 24 * HOUR, to, 0), 28);
  assert.equal(coveredDays(to - 28 * 24 * HOUR, to, to - 12 * HOUR), 0.5);
  assert.equal(coveredDays(0, to, null), 0);
  assert.equal(coveredDays(0, to, to + HOUR), 0);
});
