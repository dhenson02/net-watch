import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompactTick } from '../../shared/api.ts';
import { bandAt, buildThroughput, HOLD_MS, OTHER_KEY, rank, RANK_EVERY_MS, windowTicks } from './useLiveThroughput.ts';

type P = [id: string, name: string, tx: number, rx: number];

function tick(ts: number, procs: P[], extra: Partial<CompactTick> = {}): CompactTick {
  const list = procs.map(([id, name, tx, rx]) => ({ id, name, tx, rx }));
  return {
    ts,
    intervalMs: 1000,
    drops: 0,
    nProcs: list.length,
    nFlows: list.length,
    txKbps: list.reduce((s, p) => s + p.tx, 0),
    rxKbps: list.reduce((s, p) => s + p.rx, 0),
    procs: list,
    apps: {},
    ...extra,
  };
}

/** `n` ticks, 1 s apart, ending at `end`, each with the same procs. */
const run = (end: number, n: number, procs: P[]) => Array.from({ length: n }, (_, i) => tick(end - (n - 1 - i) * 1000, procs));

test('ranks by window sum and groups by name or instance', () => {
  const ticks = run(10_000, 5, [
    ['1:10', 'chrome', 10, 10],
    ['2:20', 'chrome', 10, 10],
    ['3:30', 'curl', 30, 0],
    ['4:40', 'ssh', 1, 1],
  ]);
  assert.deepEqual(rank(ticks, 'name', 900, null, 2).top, ['chrome', 'curl']);
  assert.deepEqual(rank(ticks, 'id', 900, null, 2).top, ['3:30', '1:10']);
});

test('the stacks add up to the tick totals, with the rest in "other"', () => {
  const ticks = [tick(1000, [['1:1', 'a', 5, 2], ['2:2', 'b', 3, 4], ['3:3', 'c', 1, 1]], { txKbps: 10, rxKbps: 8 })];
  const t = buildThroughput(ticks, 'name', ['a', 'b']);
  assert.deepEqual(
    t.bands.map((b) => [b.key, b.tx[0]![1], b.rx[0]![1]]),
    [
      ['a', 5, -2],
      ['b', 3, -4],
      [OTHER_KEY, 2, -2],
    ],
  );
  assert.deepEqual([t.totalTx[0]![1], t.totalRx[0]![1]], [10, -8]);
});

test('"other" never goes negative and idle ticks are zeros, not gaps', () => {
  const t = buildThroughput([tick(1000, [['1:1', 'a', 5, 5]], { txKbps: 4.9999, rxKbps: 0 }), tick(2000, [])], 'name', ['a']);
  const other = t.bands.at(-1)!;
  assert.deepEqual(other.tx, [[1000, 0], [2000, 0]]);
  assert.deepEqual(other.rx, [[1000, 0], [2000, 0]]);
  assert.ok(!Object.is(t.totalRx[1]![1], -0));
});

test('a gap tick inserts a null point in every series', () => {
  const t = buildThroughput([tick(1000, [['1:1', 'a', 1, 1]]), tick(5000, [['1:1', 'a', 1, 1]], { gap: true })], 'name', ['a']);
  for (const s of [...t.bands.flatMap((b) => [b.tx, b.rx]), t.totalTx, t.totalRx]) {
    assert.deepEqual(s.map((p) => p[0]), [1000, 4999, 5000]);
    assert.equal(s[1]![1], null);
  }
});

test('labels by instance carry the pid; click-through picks the largest instance', () => {
  const ticks = run(3000, 3, [
    ['7:100', 'chrome', 1, 1],
    ['8:200', 'chrome', 50, 50],
  ]);
  const byName = buildThroughput(ticks, 'name', ['chrome']);
  assert.equal(byName.bands[0]!.label, 'chrome');
  assert.equal(byName.instance.get('chrome'), '8:200');
  const byId = buildThroughput(ticks, 'id', ['7:100']);
  assert.equal(byId.bands[0]!.label, 'chrome (7)');
  assert.equal(byId.instance.get('7:100'), '7:100');
});

test('reuses the ranking for RANK_EVERY_MS of tick time', () => {
  const r0 = rank(run(10_000, 5, [['1:1', 'a', 1, 0]]), 'name', 900, null, 1);
  const soon = run(10_000 + RANK_EVERY_MS - 1000, 5, [['2:2', 'b', 9, 0]]);
  assert.equal(rank(soon, 'name', 900, r0, 1), r0);
  assert.notEqual(rank(soon, 'id', 900, r0, 1), r0, 'grouping change re-ranks');
  assert.notEqual(rank(soon, 'name', 300, r0, 1), r0, 'window change re-ranks');
});

test('a series that drops out is held for HOLD_MS, then replaced', () => {
  let r = rank(run(10_000, 3, [['1:1', 'a', 5, 0], ['2:2', 'b', 1, 0]]), 'name', 900, null, 1);
  assert.deepEqual(r.top, ['a']);
  const bWins = (end: number) => run(end, 3, [['1:1', 'a', 1, 0], ['2:2', 'b', 5, 0]]);
  r = rank(bWins(10_000 + RANK_EVERY_MS), 'name', 900, r, 1);
  assert.deepEqual(r.top, ['a'], 'held: a was in the top N 5 s ago');
  r = rank(bWins(10_000 + HOLD_MS), 'name', 900, r, 1);
  assert.deepEqual(r.top, ['b']);
});

test('held series do not push the shown set past N', () => {
  let r = rank(run(10_000, 3, [['1:1', 'a', 5, 0], ['2:2', 'b', 4, 0], ['3:3', 'c', 1, 0]]), 'name', 900, null, 2);
  assert.deepEqual(r.top, ['a', 'b']);
  r = rank(run(10_000 + RANK_EVERY_MS, 3, [['1:1', 'a', 5, 0], ['3:3', 'c', 9, 0]]), 'name', 900, r, 2);
  assert.deepEqual(r.top, ['a', 'b']);
});

test('windowTicks slices by time and stays stable while paused', () => {
  const ticks = run(10_000, 10, []);
  const w = windowTicks(ticks, 8000, 3);
  assert.deepEqual(w.map((t) => t.ts), [6000, 7000, 8000]);
  const more = [...ticks, tick(11_000, [])];
  assert.equal(windowTicks(more, 8000, 3, w), w);
  assert.equal(windowTicks(ticks, 10_000, 3600), ticks);
});

test('bandAt walks the stack on the side of zero under the cursor', () => {
  const ticks = [tick(1000, [['1:1', 'a', 5, 2], ['2:2', 'b', 3, 4]]), tick(2000, [['1:1', 'a', 1, 1], ['2:2', 'b', 1, 1]])];
  const t = buildThroughput(ticks, 'name', ['a', 'b']);
  const at = (ts: number, v: number, hidden?: Set<string>) => bandAt(t, ts, v, hidden)?.key ?? null;
  assert.equal(at(1100, 4), 'a');
  assert.equal(at(1100, 6), 'b');
  assert.equal(at(1100, 9), null, 'above the stack');
  assert.equal(at(1100, -3), 'b');
  assert.equal(at(1100, 2, new Set(['a'])), 'b', 'hidden bands are not stacked');
  assert.equal(at(1800, 1.5), 'b', 'nearest tick');
});
