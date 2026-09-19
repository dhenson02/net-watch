import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlowAgg } from '../../shared/api.ts';
import { buildSankey, destKey, OTHER_PROCS, otherDest, UNKNOWN_PEER, type SankeyGraph } from './buildSankey.ts';

const flow = (name: string, app: string, ip: string, rport: number, tx: number, rx: number, extra: Partial<FlowAgg> = {}): FlowAgg => ({
  name,
  proto: 'TCP',
  app,
  ip,
  rport,
  tx,
  rx,
  id: `1:${name}`,
  ...extra,
});

const ids = (g: SankeyGraph, depth: number) => g.nodes.filter((n) => n.depth === depth).map((n) => n.id);
const node = (g: SankeyGraph, id: string) => g.nodes.find((n) => n.id === id);

/** Every app node passes on exactly what it receives, and the layers sum to the total. */
function assertConserved(g: SankeyGraph) {
  for (const n of g.nodes.filter((n) => n.depth === 1)) {
    const inflow = g.links.filter((l) => l.target === n.id).reduce((s, l) => s + l.value, 0);
    const outflow = g.links.filter((l) => l.source === n.id).reduce((s, l) => s + l.value, 0);
    assert.ok(Math.abs(inflow - outflow) < 1e-9, `${n.id} in ${inflow} out ${outflow}`);
  }
  for (const d of [0, 1, 2]) {
    const sum = g.nodes.filter((n) => n.depth === d).reduce((s, n) => s + n.value, 0);
    assert.ok(Math.abs(sum - g.total) < 1e-9, `layer ${d}`);
  }
}

test('three prefixed layers; labels without prefixes', () => {
  const g = buildSankey([flow('firefox', 'HTTPS', '1.2.3.4', 443, 10, 90), flow('curl', 'HTTP', '5.6.7.8', 80, 5, 5)], { dir: 'both' });
  assert.deepEqual(ids(g, 0), ['p:curl', 'p:firefox']); // sorted by label
  assert.deepEqual(ids(g, 1), ['a:HTTP', 'a:HTTPS']);
  assert.deepEqual(ids(g, 2), ['d:5.6.7.8:80', 'd:1.2.3.4:443']); // grouped by app: HTTP before HTTPS
  assert.equal(node(g, 'd:1.2.3.4:443')!.label, '1.2.3.4:443');
  assert.equal(node(g, 'd:1.2.3.4:443')!.target, '1.2.3.4:443');
  assert.equal(node(g, 'p:firefox')!.target, '1:firefox');
  assert.equal(g.total, 110);
  assert.deepEqual(g.links.find((l) => l.source === 'p:firefox'), { source: 'p:firefox', target: 'a:HTTPS', value: 100, tx: 10, rx: 90 });
  assertConserved(g);
});

test('ids stay unique when names look alike across layers', () => {
  // A process named like an app and like an address; an app named like a process.
  const g = buildSankey([flow('HTTPS', 'HTTPS', '1.2.3.4', 443, 1, 0), flow('1.2.3.4:443', 'curl', '1.2.3.4', 443, 1, 0), flow('curl', 'x', '9.9.9.9', 1, 1, 0)], {
    dir: 'tx',
  });
  const all = g.nodes.map((n) => n.id);
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.includes('p:HTTPS') && all.includes('a:HTTPS'));
  assert.ok(all.includes('p:1.2.3.4:443') && all.includes('d:1.2.3.4:443'));
  assert.ok(all.includes('p:curl') && all.includes('a:curl'));
  for (const l of g.links) assert.ok(all.includes(l.source) && all.includes(l.target));
});

test('a process called "other processes" does not merge with the bucket', () => {
  const flows = [flow('other processes', 'HTTPS', '1.1.1.1', 443, 100, 0)];
  for (let i = 0; i < 11; i++) flows.push(flow(`p${String(i).padStart(2, '0')}`, 'HTTPS', '1.1.1.1', 443, 200 - i, 0));
  const g = buildSankey(flows, { dir: 'tx' });
  const procs = g.nodes.filter((n) => n.depth === 0);
  assert.equal(procs.length, 11); // top 10 + bucket
  assert.equal(node(g, OTHER_PROCS)!.label, 'other processes');
  assert.equal(node(g, OTHER_PROCS)!.bucket, true);
  assert.equal(node(g, OTHER_PROCS)!.value, 100 + 190); // the real "other processes" (rank 12) and p10 (rank 11)
  assert.equal(procs.at(-1)!.id, OTHER_PROCS, 'bucket sorts last in its group');
});

test('caps processes at 10 and destinations at 15, one "other" per app', () => {
  const flows: FlowAgg[] = [];
  for (let i = 0; i < 20; i++) {
    flows.push(flow(`proc${String(i).padStart(2, '0')}`, i % 2 ? 'HTTPS' : 'DNS', `10.0.0.${i}`, i % 2 ? 443 : 53, 1000 - i * 10, 0));
  }
  const g = buildSankey(flows, { dir: 'both' });
  const procs = ids(g, 0);
  assert.equal(procs.length, 11);
  // Grouped by main app (DNS, then HTTPS); the bucket's main app is DNS, so it closes that group.
  assert.deepEqual(procs, ['p:proc00', 'p:proc02', 'p:proc04', 'p:proc06', 'p:proc08', OTHER_PROCS, 'p:proc01', 'p:proc03', 'p:proc05', 'p:proc07', 'p:proc09']);
  const dests = ids(g, 2);
  assert.equal(dests.filter((d) => d.startsWith('d:')).length, 15);
  assert.deepEqual(
    dests.filter((d) => d.startsWith('d*')),
    [otherDest('DNS'), otherDest('HTTPS')],
  );
  // Each bucket closes its app's group: 8 DNS destinations (0, 2, …, 14) kept.
  assert.equal(dests.indexOf(otherDest('DNS')), 8);
  assert.equal(dests.at(-1), otherDest('HTTPS'));
  assert.equal(node(g, otherDest('HTTPS'))!.label, 'other (HTTPS)');
  assertConserved(g);
});

test('folds links under 0.5% into their "other" nodes', () => {
  const g = buildSankey(
    [flow('big', 'HTTPS', '1.1.1.1', 443, 1000, 0), flow('big', 'HTTPS', '2.2.2.2', 443, 4, 0), flow('tiny', 'DNS', '8.8.8.8', 53, 3, 0)],
    { dir: 'tx' },
  );
  // 4 of 1007 < 0.5%: the destination folds; `tiny` (3 of 1007) folds into other processes.
  assert.equal(node(g, 'd:2.2.2.2:443'), undefined);
  assert.equal(node(g, otherDest('HTTPS'))!.value, 4);
  assert.equal(node(g, 'p:tiny'), undefined);
  assert.equal(node(g, OTHER_PROCS)!.value, 3);
  assertConserved(g);
});

test('direction picks the metric and drops zero flows', () => {
  const flows = [flow('up', 'HTTPS', '1.1.1.1', 443, 50, 0), flow('down', 'HTTPS', '1.1.1.1', 443, 0, 70)];
  assert.deepEqual(ids(buildSankey(flows, { dir: 'tx' }), 0), ['p:up']);
  assert.deepEqual(ids(buildSankey(flows, { dir: 'rx' }), 0), ['p:down']);
  const both = buildSankey(flows, { dir: 'both' });
  assert.equal(both.total, 120);
  assert.deepEqual([node(both, 'a:HTTPS')!.tx, node(both, 'a:HTTPS')!.rx], [50, 70]);
  assert.deepEqual(buildSankey([], { dir: 'both' }), { nodes: [], links: [], total: 0 });
});

test('labels an app with its transport only when it runs over both', () => {
  const g = buildSankey(
    [flow('resolved', 'DNS', '1.1.1.1', 53, 10, 0, { proto: 'UDP' }), flow('resolved', 'DNS', '1.1.1.1', 53, 10, 0), flow('curl', 'HTTPS', '1.1.1.1', 443, 10, 0)],
    { dir: 'tx' },
  );
  assert.deepEqual(ids(g, 1), ['a:DNS/TCP', 'a:DNS/UDP', 'a:HTTPS']);
});

test('unspecified address with port 0 is an "unknown peer", not an IP', () => {
  const g = buildSankey([flow('dhclient', 'unknown', '0.0.0.0', 0, 0, 5, { proto: 'UDP' }), flow('x', 'unknown', '::', 0, 0, 5, { proto: 'UDP' })], { dir: 'rx' });
  const d = ids(g, 2);
  assert.deepEqual(d, [UNKNOWN_PEER]);
  assert.equal(node(g, UNKNOWN_PEER)!.label, 'unknown peer');
  assert.equal(node(g, UNKNOWN_PEER)!.target, undefined);
});

test('IPv6 destinations are bracketed', () => {
  assert.equal(destKey('2001:db8::1', 443), '[2001:db8::1]:443');
  assert.equal(destKey('1.2.3.4', 443), '1.2.3.4:443');
});

test('picks the busiest instance of a name for click-through', () => {
  const g = buildSankey(
    [flow('ff', 'HTTPS', '1.1.1.1', 443, 10, 0, { id: '1:100' }), flow('ff', 'HTTPS', '2.2.2.2', 443, 30, 0, { id: '2:200' }), flow('ff', 'HTTP', '1.1.1.1', 80, 25, 0, { id: '1:100' })],
    { dir: 'tx' },
  );
  assert.equal(node(g, 'p:ff')!.target, '1:100'); // 35 vs 30
});

test('output order does not depend on input order', () => {
  const flows = [flow('b', 'HTTPS', '1.1.1.1', 443, 10, 1), flow('a', 'QUIC', '2.2.2.2', 443, 20, 2), flow('c', 'DNS', '3.3.3.3', 53, 30, 3)];
  assert.deepEqual(buildSankey(flows, { dir: 'both' }), buildSankey([...flows].reverse(), { dir: 'both' }));
});

test('orders each layer by main app, then label; buckets last in their group', () => {
  const g = buildSankey(
    [
      flow('zeta', 'DNS', '9.9.9.9', 53, 50, 0),
      flow('alpha', 'SSH', '1.1.1.1', 22, 40, 0),
      flow('alpha', 'DNS', '8.8.8.8', 53, 10, 0),
      flow('mid', 'HTTPS', '5.5.5.5', 443, 30, 0),
      flow('mid', 'unknown', '0.0.0.0', 0, 20, 0, { proto: 'UDP' }),
    ],
    { dir: 'tx' },
  );
  assert.deepEqual(ids(g, 1), ['a:DNS', 'a:HTTPS', 'a:SSH', 'a:unknown']);
  assert.deepEqual(ids(g, 0), ['p:zeta', 'p:mid', 'p:alpha']); // DNS, HTTPS, SSH
  assert.deepEqual(ids(g, 2), ['d:8.8.8.8:53', 'd:9.9.9.9:53', 'd:5.5.5.5:443', 'd:1.1.1.1:22', UNKNOWN_PEER]);
});
