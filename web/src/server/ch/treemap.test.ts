import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRange } from './range.ts';
import { UNKNOWN_UID } from './sql.ts';
import { buildTreemap, parseTreemapDir, treemapQuery, userLabel, type TreemapRow } from './treemap.ts';

const now = 1_789_800_000_000;
const HOUR = 3600_000;

test('parseTreemapDir: default and whitelist', () => {
  assert.equal(parseTreemapDir(undefined), 'total');
  assert.equal(parseTreemapDir(''), 'total');
  assert.equal(parseTreemapDir('tx'), 'tx');
  assert.equal(parseTreemapDir('rx'), 'rx');
  assert.throws(() => parseTreemapDir('both'), /dir/);
  assert.throws(() => parseTreemapDir(['tx']), /dir/);
});

test('treemapQuery: raw flows have uid, the rollup joins processes; filters as params', () => {
  const raw = treemapQuery(parseRange({ from: String(now - HOUR), to: String(now) }, now), 'tx', { name: "o'x" }, 10);
  assert.match(raw.sql, /sum\(tx_bytes\) AS bytes/);
  assert.match(raw.sql, /FROM flows\s/);
  assert.doesNotMatch(raw.sql, /JOIN/);
  assert.match(raw.sql, /GROUP BY uid, name, app/);
  assert.match(raw.sql, /AND name = \{f_name:String\}/);
  assert.doesNotMatch(raw.sql, /o'x/);
  assert.deepEqual(raw.params, { from: now - HOUR, to: now, f_name: "o'x", limit: 10 });

  const rolled = treemapQuery(parseRange({ from: String(now - 24 * HOUR), to: String(now) }, now), 'total', { uid: 0 }, 10);
  assert.match(rolled.sql, /sum\(tx_bytes \+ rx_bytes\) AS bytes/);
  assert.match(rolled.sql, /FROM flows_1m\s+LEFT JOIN/);
  assert.match(rolled.sql, /AND uid = \{f_uid:UInt32\}/);
  assert.equal(rolled.params.f_uid, 0);
});

test('userLabel: passwd name, else the number, unknown uid', () => {
  const names = (uid: number) => (uid === 1000 ? 'jay' : null);
  assert.equal(userLabel(1000, names), 'jay');
  assert.equal(userLabel(100_000, names), 'uid 100000');
  assert.equal(userLabel(UNKNOWN_UID, names), 'unknown uid');
});

const row = (uid: number, name: string, app: string, bytes: number): TreemapRow => ({ uid, name, app, bytes: String(bytes) });

test('buildTreemap: nests users → processes → apps, largest first, values sum up', () => {
  const tree = buildTreemap(
    [row(1000, 'curl', 'HTTPS', 50), row(0, 'sshd', 'SSH', 400), row(1000, 'firefox', 'HTTPS', 300), row(1000, 'firefox', 'DNS/UDP', 20), row(1000, 'curl', 'HTTP', 10), row(7, 'x', 'DNS', 0)],
    (uid) => (uid === 0 ? 'root' : null),
  );
  assert.deepEqual(tree, [
    {
      name: 'uid 1000',
      uid: 1000,
      value: 380,
      children: [
        {
          name: 'firefox',
          value: 320,
          children: [
            { name: 'HTTPS', value: 300 },
            { name: 'DNS/UDP', value: 20 },
          ],
        },
        {
          name: 'curl',
          value: 60,
          children: [
            { name: 'HTTPS', value: 50 },
            { name: 'HTTP', value: 10 },
          ],
        },
      ],
    },
    { name: 'root', uid: 0, value: 400, children: [{ name: 'sshd', value: 400, children: [{ name: 'SSH', value: 400 }] }] },
  ].sort((a, b) => b.value - a.value));
  assert.deepEqual(buildTreemap([], () => null), []);
});

test('buildTreemap: past the top N, the rest folds into one "other" node with merged apps', () => {
  const rows: TreemapRow[] = [];
  for (let i = 0; i < 6; i++) rows.push(row(1000, `p${i}`, 'HTTPS', 100 - i), row(1000, `p${i}`, i % 2 ? 'DNS' : 'HTTPS', 1));
  const [u] = buildTreemap(rows, () => 'jay', 3);
  assert.equal(u!.children.length, 4);
  assert.deepEqual(
    u!.children.map((p) => p.name),
    ['p0', 'p1', 'p2', 'other (3 processes)'],
  );
  const other = u!.children[3]!;
  assert.equal(other.folded, 3);
  assert.equal(other.value, 97 + 96 + 95 + 3);
  assert.deepEqual(other.children, [
    { name: 'HTTPS', value: 97 + 96 + 95 + 1 },
    { name: 'DNS', value: 2 },
  ]);
  assert.equal(u!.value, u!.children.reduce((s, p) => s + p.value, 0));

  // One process past the limit is shown, not folded.
  const [v] = buildTreemap(rows.slice(0, 8), () => 'jay', 3);
  assert.equal(v!.children.length, 4);
  assert.ok(v!.children.every((p) => p.folded === undefined));
});
