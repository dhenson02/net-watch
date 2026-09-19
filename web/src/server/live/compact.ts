import type { CompactTick, LiveSnapshot, LiveSnapshotResponse } from '../../shared/api.ts';

/** Longer cmdlines are cut in the live table; the process page reads the full one. */
export const CMDLINE_MAX = 300;

// JSON.parse source text access (Node >= 21): the third reviver argument holds
// the raw text of primitive values. Not in TypeScript's lib yet.
type Reviver = (key: string, value: unknown, context: { source?: string }) => unknown;

/** Keeps `start_ns` (u64 ns since boot) as its exact decimal text; see LiveProcess. */
const keepStartNs: Reviver = (key, value, context) => (key === 'start_ns' && context.source !== undefined ? context.source : value);

/** Parses a collector snapshot, keeping 64-bit `start_ns` values exact. */
export function parseSnapshot(json: string): LiveSnapshot {
  const snap = JSON.parse(json, keepStartNs as (key: string, value: unknown) => unknown) as LiveSnapshot;
  if (typeof snap?.ts_ms !== 'number' || !Array.isArray(snap.processes) || !Array.isArray(snap.flows)) {
    throw new Error('not a net-watch snapshot');
  }
  return snap;
}

/** kbps with 0.01 resolution (10 bit/s): keeps the SSE and series payloads small. */
const r2 = (n: number) => Math.round(n * 100) / 100;

export function compactTick(s: LiveSnapshot): CompactTick {
  let txKbps = 0;
  let rxKbps = 0;
  let nProcs = 0;
  const procs: CompactTick['procs'] = [];
  for (const p of s.processes) {
    if (p.ended_ms === null) nProcs++;
    txKbps += p.tx_kbps;
    rxKbps += p.rx_kbps;
    if (p.tx_kbps > 0 || p.rx_kbps > 0) {
      procs.push({ id: `${p.pid}:${p.start_ns}`, name: p.name, tx: r2(p.tx_kbps), rx: r2(p.rx_kbps) });
    }
  }

  const apps: CompactTick['apps'] = {};
  for (const f of s.flows) {
    const a = (apps[f.app] ??= [0, 0]);
    a[0] += f.tx_kbps;
    a[1] += f.rx_kbps;
  }
  for (const a of Object.values(apps)) {
    a[0] = r2(a[0]);
    a[1] = r2(a[1]);
  }

  return {
    ts: s.ts_ms,
    intervalMs: s.interval_ms,
    drops: s.drops,
    nProcs,
    nFlows: s.flows.length,
    txKbps: r2(txKbps),
    rxKbps: r2(rxKbps),
    procs,
    apps,
  };
}

/** A snapshot reduced to its process list, for the top-talkers table. */
export function snapshotRows(s: LiveSnapshot, user: (uid: number) => string | null): Omit<LiveSnapshotResponse, 'serverTimeMs'> {
  const flows = new Map<string, number>();
  for (const f of s.flows) {
    const id = `${f.pid}:${f.start_ns}`;
    flows.set(id, (flows.get(id) ?? 0) + 1);
  }
  return {
    ts: s.ts_ms,
    intervalMs: s.interval_ms,
    processes: s.processes.map((p) => {
      const id = `${p.pid}:${p.start_ns}`;
      return {
        id,
        pid: p.pid,
        startNs: p.start_ns,
        name: p.name,
        cmdline: p.cmdline.length > CMDLINE_MAX ? `${p.cmdline.slice(0, CMDLINE_MAX - 1)}…` : p.cmdline,
        uid: p.uid,
        user: user(p.uid),
        startMs: p.start_ms,
        firstSeenMs: p.first_seen_ms,
        lastSeenMs: p.last_seen_ms,
        endedMs: p.ended_ms,
        txKbps: p.tx_kbps,
        rxKbps: p.rx_kbps,
        txTotal: p.tx_total,
        rxTotal: p.rx_total,
        nFlows: flows.get(id) ?? 0,
      };
    }),
  };
}
