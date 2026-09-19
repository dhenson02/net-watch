// The process → app protocol → destination graph behind the flow Sankey (03).
// Pure, so it is unit-tested without a browser.
import type { FlowAgg } from '../../shared/api.ts';
import { asnLabel, orgDestLabel } from '../destinations/geoView.ts';

export type FlowDir = 'tx' | 'rx' | 'both';
export type NodeKind = 'proc' | 'app' | 'dest';

export interface SankeyOptions {
  dir: FlowDir;
  /** Process names kept; the rest go to one "other processes" node. */
  topProcs?: number;
  /** Destinations kept; the rest go to one "other (APP)" node per app. */
  topDests?: number;
  /** Links under this share of the total are folded into their "other" node. */
  minShare?: number;
  /**
   * 18: one node per ASN instead of per ip:port, for destinations the geo
   * table knows (`FlowAgg.geo`); the others keep their ip:port node.
   */
  byAsn?: boolean;
}

export interface SankeyNode {
  /**
   * Unique across layers: `p:<name>`, `a:<app>`, `d:<ip:port>` for real nodes;
   * the buckets use `p*`/`d*`, which no real name can produce, so a process
   * that happens to be called "other processes" never merges with the bucket.
   */
  id: string;
  label: string;
  depth: 0 | 1 | 2;
  kind: NodeKind;
  /** An "other …" or "unknown peer" bucket: not clickable. */
  bucket: boolean;
  value: number;
  tx: number;
  rx: number;
  /** proc: its busiest instance (`pid:start_ns`); dest: `ip:port` for the History filter. */
  target?: string;
  /** An ASN node (`byAsn`): its AS number, for the Destinations page. */
  asn?: number;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  tx: number;
  rx: number;
}

export interface SankeyGraph {
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** Sum of every flow's value (tx, rx or both). */
  total: number;
}

export const OTHER_PROCS = 'p*other';
export const UNKNOWN_PEER = 'd*unknown';
export const otherDest = (appLabel: string) => `d*other:${appLabel}`;

/** UDP receivers without an address buffer report the unspecified address and port 0. */
export function isUnknownPeer(ip: string, port: number): boolean {
  return port === 0 && (ip === '' || ip === '0.0.0.0' || ip === '::');
}

/** `ip:port`, with IPv6 in brackets so the port stays readable. */
export function destKey(ip: string, port: number): string {
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Keys ranked by value (largest first, ties by key) and cut to `n`. */
function topKeys(sums: Map<string, number>, n: number): Set<string> {
  return new Set(
    [...sums]
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .slice(0, n)
      .map(([k]) => k),
  );
}

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

interface Row {
  proc: string;
  app: string;
  appLabel: string;
  dest: string;
  value: number;
  tx: number;
  rx: number;
  name: string;
  id: string;
  destTarget?: string;
  destLabel?: string;
  asn?: number;
}

/**
 * Three layers (process name → app → destination) with capped node counts.
 * Every flow feeds exactly one path, so each app node's inflow equals its
 * outflow. Nodes come back sorted (by layer, main app, buckets last, then label) and
 * links by (source, target), so a live refresh keeps its layout.
 */
export function buildSankey(flows: readonly FlowAgg[], opts: SankeyOptions): SankeyGraph {
  const { dir, topProcs = 10, topDests = 15, minShare = 0.005, byAsn = false } = opts;
  const pick = (f: FlowAgg) => (dir === 'tx' ? f.tx : dir === 'rx' ? f.rx : f.tx + f.rx);

  // An app label carries its transport when the app appears over both (DNS/UDP, DNS/TCP).
  const protos = new Map<string, Set<string>>();
  for (const f of flows) if (pick(f) > 0) (protos.get(f.app) ?? protos.set(f.app, new Set()).get(f.app)!).add(f.proto);
  const appLabel = (f: FlowAgg) => (protos.get(f.app)!.size > 1 ? `${f.app}/${f.proto}` : f.app);

  let total = 0;
  const rows: Row[] = [];
  const procSums = new Map<string, number>();
  const destSums = new Map<string, number>();
  for (const f of flows) {
    const value = pick(f);
    if (!(value > 0)) continue;
    const label = appLabel(f);
    const unknown = isUnknownPeer(f.ip, f.rport);
    const key = destKey(f.ip, f.rport);
    const asn = byAsn && !unknown && f.geo ? f.geo.asn : undefined;
    const row: Row = {
      proc: `p:${f.name}`,
      app: `a:${label}`,
      appLabel: label,
      // `d:AS…` cannot collide with `d:<ip:port>`: an address never starts with "AS".
      dest: unknown ? UNKNOWN_PEER : asn !== undefined ? `d:AS${asn}` : `d:${key}`,
      value,
      tx: dir === 'rx' ? 0 : f.tx,
      rx: dir === 'tx' ? 0 : f.rx,
      name: f.name,
      id: f.id,
      ...(!unknown && asn === undefined && { destTarget: key, destLabel: orgDestLabel(f.geo, key) }),
      ...(asn !== undefined && { asn, destLabel: asnLabel(f.geo!) }),
    };
    rows.push(row);
    total += value;
    add(procSums, row.proc, value);
    add(destSums, row.dest, value);
  }

  // Node caps.
  const keptProcs = topKeys(procSums, topProcs);
  const keptDests = topKeys(destSums, topDests);
  for (const r of rows) {
    if (!keptProcs.has(r.proc)) r.proc = OTHER_PROCS;
    if (!keptDests.has(r.dest)) r.dest = otherDest(r.appLabel);
  }

  // Hairline links go to the "other" node on their side.
  const min = total * minShare;
  const linkSums = (from: (r: Row) => string, to: (r: Row) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) add(m, `${from(r)}\u0000${to(r)}`, r.value);
    return m;
  };
  const appDest = linkSums((r) => r.app, (r) => r.dest);
  for (const r of rows) {
    if (r.dest.startsWith('d:') && appDest.get(`${r.app}\u0000${r.dest}`)! < min) r.dest = otherDest(r.appLabel);
  }
  const procApp = linkSums((r) => r.proc, (r) => r.app);
  for (const r of rows) {
    if (r.proc !== OTHER_PROCS && procApp.get(`${r.proc}\u0000${r.app}`)! < min) r.proc = OTHER_PROCS;
  }

  // Aggregate nodes and links.
  const nodes = new Map<string, SankeyNode>();
  const links = new Map<string, SankeyLink>();
  const instances = new Map<string, Map<string, number>>(); // proc node → instance id → value
  const node = (id: string, init: () => Omit<SankeyNode, 'value' | 'tx' | 'rx'>, r: Row) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { ...init(), value: 0, tx: 0, rx: 0 }));
    n.value += r.value;
    n.tx += r.tx;
    n.rx += r.rx;
  };
  const link = (source: string, target: string, r: Row) => {
    const k = `${source}\u0000${target}`;
    let l = links.get(k);
    if (!l) links.set(k, (l = { source, target, value: 0, tx: 0, rx: 0 }));
    l.value += r.value;
    l.tx += r.tx;
    l.rx += r.rx;
  };
  for (const r of rows) {
    node(r.proc, () => (r.proc === OTHER_PROCS ? { id: r.proc, label: 'other processes', depth: 0, kind: 'proc', bucket: true } : { id: r.proc, label: r.name, depth: 0, kind: 'proc', bucket: false }), r);
    node(r.app, () => ({ id: r.app, label: r.appLabel, depth: 1, kind: 'app', bucket: false }), r);
    node(
      r.dest,
      () =>
        r.dest === UNKNOWN_PEER
          ? { id: r.dest, label: 'unknown peer', depth: 2, kind: 'dest', bucket: true }
          : r.dest.startsWith('d*')
            ? { id: r.dest, label: `other (${r.appLabel})`, depth: 2, kind: 'dest', bucket: true }
            : r.asn !== undefined
              ? { id: r.dest, label: r.destLabel!, depth: 2, kind: 'dest', bucket: false, asn: r.asn }
              : { id: r.dest, label: r.destLabel!, depth: 2, kind: 'dest', bucket: false, target: r.destTarget! },
      r,
    );
    link(r.proc, r.app, r);
    link(r.app, r.dest, r);
    if (r.proc !== OTHER_PROCS && r.id) {
      const m = instances.get(r.proc) ?? instances.set(r.proc, new Map()).get(r.proc)!;
      add(m, r.id, r.value);
    }
  }
  for (const [proc, m] of instances) {
    let best = -1;
    for (const [id, v] of m) {
      if (v > best || (v === best && cmp(id, nodes.get(proc)!.target ?? '') < 0)) {
        best = v;
        nodes.get(proc)!.target = id;
      }
    }
  }

  // Order within a layer: apps by label; processes and destinations grouped by
  // their main app (largest link), then by label, buckets last in their group. Grouping keeps
  // links from crossing much, so the live chart can skip ECharts' relaxation
  // (which reorders nodes as values change) and still read well.
  const appOrder = new Map([...nodes.values()].filter((n) => n.kind === 'app').sort((a, b) => cmp(a.label, b.label)).map((n, i) => [n.id, i]));
  const mainApp = new Map<string, { app: string; value: number }>();
  for (const l of links.values()) {
    const [other, app] = appOrder.has(l.target) ? [l.source, l.target] : [l.target, l.source];
    const cur = mainApp.get(other);
    if (!cur || l.value > cur.value || (l.value === cur.value && appOrder.get(app)! < appOrder.get(cur.app)!)) mainApp.set(other, { app, value: l.value });
  }
  const group = (n: SankeyNode) => (n.kind === 'app' ? 0 : appOrder.get(mainApp.get(n.id)!.app)!);

  return {
    nodes: [...nodes.values()].sort(
      (a, b) => a.depth - b.depth || group(a) - group(b) || Number(a.bucket) - Number(b.bucket) || cmp(a.label, b.label) || cmp(a.id, b.id),
    ),
    links: [...links.values()].sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target)),
    total,
  };
}
