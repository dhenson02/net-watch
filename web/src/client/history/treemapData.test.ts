import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TreemapUser } from '../../shared/api.ts';
import { CATEGORICAL, OTHER } from '../charts/palette.ts';
import { lighten, parseDir, parseView, pathText, ROOT_SLOT, seriesData, shareText, UNKNOWN_UID, userColors } from './treemapData.ts';

test('parseView / parseDir: defaults', () => {
  assert.equal(parseView(null), 'treemap');
  assert.equal(parseView('sunburst'), 'sunburst');
  assert.equal(parseView('pie'), 'treemap');
  assert.equal(parseDir(null), 'total');
  assert.equal(parseDir('rx'), 'rx');
  assert.equal(parseDir('both'), 'total');
});

test('userColors: root keeps its slot, unknown and overflow are neutral, no slot reused', () => {
  const pal = CATEGORICAL.light;
  const users = [1000, 0, UNKNOWN_UID, ...Array.from({ length: 9 }, (_, i) => 2000 + i)].map((uid) => ({ uid }));
  const c = userColors(users, 'light');
  assert.equal(c.get(0), pal[ROOT_SLOT]);
  assert.equal(c.get(1000), pal[0]);
  assert.equal(c.get(UNKNOWN_UID), OTHER.light);
  const others = [1000, ...Array.from({ length: 9 }, (_, i) => 2000 + i)].map((u) => c.get(u)!);
  const hues = others.filter((x) => x !== OTHER.light);
  assert.equal(hues.length, 7);
  assert.equal(new Set(hues).size, 7);
  assert.ok(!hues.includes(pal[ROOT_SLOT]!));
  // Root first still leaves slot 0 to the next user.
  assert.equal(userColors([{ uid: 0 }, { uid: 5 }], 'dark').get(5), CATEGORICAL.dark[0]);
});

test('lighten: toward white', () => {
  assert.equal(lighten('#000000', 0), '#000000');
  assert.equal(lighten('#000000', 1), '#ffffff');
  assert.equal(lighten('#2a78d6', 0.5), '#95bceb');
});

const users: TreemapUser[] = [
  {
    name: 'jay',
    uid: 1000,
    value: 110,
    children: [
      { name: 'firefox', value: 100, children: [{ name: 'HTTPS', value: 100 }] },
      { name: 'other (40 processes)', value: 10, folded: 40, children: [{ name: 'DNS', value: 10 }] },
    ],
  },
  { name: 'root', uid: 0, value: 5, children: [{ name: 'sshd', value: 5, children: [{ name: 'SSH', value: 5 }] }] },
];

test('seriesData: users colored, children inherit (treemap) or get shades (sunburst), "other" neutral', () => {
  const tm = seriesData(users, 'light');
  assert.equal(tm[0]!.itemStyle!.color, CATEGORICAL.light[0]);
  assert.equal(tm[1]!.itemStyle!.color, CATEGORICAL.light[ROOT_SLOT]);
  assert.deepEqual(tm[0]!.info, { kind: 'user', uid: 1000 });
  const [ff, other] = tm[0]!.children!;
  assert.equal(ff!.itemStyle, undefined);
  assert.equal(ff!.children![0]!.itemStyle, undefined);
  assert.deepEqual(ff!.children![0]!.info, { kind: 'app', uid: 1000 });
  assert.equal(other!.itemStyle!.color, OTHER.light);
  assert.deepEqual(other!.info, { kind: 'proc', uid: 1000, folded: 40 });

  const sb = seriesData(users, 'light', true);
  const proc = sb[0]!.children![0]!;
  assert.equal(proc.itemStyle!.color, lighten(CATEGORICAL.light[0]!, 0.1));
  assert.equal(proc.children![0]!.itemStyle!.color, lighten(proc.itemStyle!.color, 0.3));
  assert.equal(sb[0]!.children![1]!.itemStyle!.color, OTHER.light);
});

test('shareText / pathText', () => {
  assert.equal(shareText(1, 3), '33%');
  assert.equal(shareText(5, 100), '5.0%');
  assert.equal(shareText(1, 10_000), '<0.1%');
  assert.equal(shareText(0, 10), '0.0%');
  assert.equal(shareText(1, 0), '—');
  assert.equal(pathText([{ name: '' }, { name: 'jay' }, { name: 'firefox' }]), 'jay › firefox');
  assert.equal(pathText(undefined), '');
});
