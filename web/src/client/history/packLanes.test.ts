import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LifetimeBar } from '../../shared/api.ts';
import { barEnd, colorExtent, laneLabel, laneStats, logBytes, median, packLanes, parseSort, subRows } from './packLanes.ts';

let seq = 0;
const bar = (name: string, startMs: number, endedMs: number | null, bytes = 0): LifetimeBar => ({
  id: `${++seq}:${startMs}`,
  pid: seq,
  name,
  cmdline: '',
  uid: 0,
  startMs,
  firstSeenMs: startMs,
  lastSeenMs: endedMs ?? startMs,
  endedMs,
  tx: bytes,
  rx: 0,
});

test('parseSort: bytes or the default start', () => {
  assert.equal(parseSort('bytes'), 'bytes');
  assert.equal(parseSort(null), 'start');
  assert.equal(parseSort('x'), 'start');
});

test('subRows: overlapping intervals get their own rows, touching ones share, fewest rows', () => {
  assert.deepEqual(subRows([]), []);
  assert.deepEqual(
    subRows([
      { start: 0, end: 10 },
      { start: 10, end: 20 }, // touches the first: same row
      { start: 5, end: 15 }, // overlaps both: row 1
      { start: 16, end: 30 }, // row 1 is free again after 15
      { start: 12, end: 18 }, // overlaps 10-20 and 16-30: row 2
    ]),
    [0, 0, 1, 1, 2],
  );
  // Input order does not matter, only start order.
  assert.deepEqual(
    subRows([
      { start: 20, end: 30 },
      { start: 0, end: 25 },
    ]),
    [1, 0],
  );
});

test('barEnd: the end, else now, never before the first or last I/O', () => {
  assert.equal(barEnd(bar('a', 0, 50), 100), 50);
  assert.equal(barEnd({ ...bar('a', 10, 9), firstSeenMs: 11, lastSeenMs: 11 }, 100), 11);
  assert.equal(barEnd(bar('a', 0, null), 100), 100);
  assert.equal(barEnd({ ...bar('a', 0, null), lastSeenMs: 200 }, 100), 200);
});

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('laneStats: median over ended instances, CV of start gaps, scheduled needs n >= 5 and CV < 0.1', () => {
  const cron = [0, 300_000, 600_000, 900_000, 1_200_000].map((s) => bar('cron', s, s + 10_000));
  const st = laneStats(cron);
  assert.equal(st.n, 5);
  assert.equal(st.ended, 5);
  assert.equal(st.medianLifetimeMs, 10_000);
  assert.equal(st.meanGapMs, 300_000);
  assert.equal(st.gapCv, 0);
  assert.equal(st.scheduled, true);
  // Four instances: regular but too few.
  assert.equal(laneStats(cron.slice(0, 4)).scheduled, false);
  // Irregular gaps.
  const irregular = laneStats([0, 10, 200, 210, 5000].map((s) => bar('x', s, null)));
  assert.ok(irregular.gapCv! > 0.1);
  assert.equal(irregular.scheduled, false);
  assert.equal(irregular.medianLifetimeMs, null);
  assert.equal(irregular.ended, 0);
  // One or two instances: no CV.
  assert.equal(laneStats([bar('a', 0, 1)]).meanGapMs, null);
  assert.equal(laneStats([bar('a', 0, 1), bar('a', 10, 11)]).gapCv, null);
});

test('packLanes: one lane per name, sub-rows for overlaps, rows numbered across lanes', () => {
  const bars = [bar('b', 100, 200, 5), bar('a', 50, 300, 1), bar('a', 60, 70, 1), bar('a', 80, 90, 1), bar('c', 10, null, 100)];
  const p = packLanes(bars, 'start', 1000);
  assert.deepEqual(
    p.lanes.map((l) => [l.name, l.row0, l.rows, l.bytes]),
    [
      ['c', 0, 1, 100],
      ['a', 1, 2, 3],
      ['b', 3, 1, 5],
    ],
  );
  assert.equal(p.rows, 4);
  const rowOf = (name: string, start: number) => p.bars.find((x) => x.bar.name === name && x.bar.startMs === start)!;
  assert.equal(rowOf('a', 50).row, 1);
  assert.equal(rowOf('a', 60).row, 2);
  assert.equal(rowOf('a', 80).row, 2);
  assert.equal(rowOf('c', 10).end, 1000);
  assert.equal(rowOf('b', 100).lane, 2);
  // Lanes list their instances by start.
  assert.deepEqual(
    p.lanes[1]!.bars.map((b) => b.startMs),
    [50, 60, 80],
  );

  const byBytes = packLanes(bars, 'bytes', 1000);
  assert.deepEqual(
    byBytes.lanes.map((l) => l.name),
    ['c', 'b', 'a'],
  );
  assert.deepEqual(packLanes([], 'start', 0), { lanes: [], bars: [], rows: 0 });
});

test('laneLabel, logBytes, colorExtent', () => {
  assert.equal(laneLabel({ name: 'cron', bars: [bar('cron', 0, 1)] }), 'cron');
  assert.equal(laneLabel({ name: 'cron', bars: [bar('cron', 0, 1), bar('cron', 2, 3)] }), 'cron ×2');
  assert.equal(logBytes(0), 0);
  assert.equal(logBytes(1000), 3);
  assert.deepEqual(colorExtent([]), [0, 1]);
  assert.deepEqual(colorExtent([3]), [2.5, 3.5]);
  assert.deepEqual(colorExtent([0]), [0, 0.5]);
  assert.deepEqual(colorExtent([2, 5, 3]), [2, 5]);
});
