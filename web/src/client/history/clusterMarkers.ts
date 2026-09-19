// Process start/end markers (12), the pure part: the URL toggle, events from
// the endpoint's processes, and clustering of markers that would overlap.
// No DOM, so node --test covers it; the chart is LifecycleTrack.tsx.
import type { LifecycleProc } from '../../shared/api.ts';

/** `?events=`: off (default), starts only, or starts and ends. */
export type EventsMode = 'off' | 'starts' | 'all';
export const EVENTS_VALUES: readonly EventsMode[] = ['off', 'starts', 'all'];

export function parseEventsMode(raw: string | null): EventsMode {
  return EVENTS_VALUES.includes(raw as EventsMode) ? (raw as EventsMode) : 'off';
}

export type EventKind = 'start' | 'end';

export interface LifecycleEvent {
  kind: EventKind;
  /** First network I/O for a start, the exit for an end (ms). */
  t: number;
  proc: LifecycleProc;
}

/**
 * The events `mode` draws that lie in [from, to), per kind, oldest first.
 * A process from the endpoint may have only one of its events in range.
 */
export function lifecycleEvents(
  procs: readonly LifecycleProc[],
  range: { from: number; to: number },
  mode: EventsMode,
): Record<EventKind, LifecycleEvent[]> {
  const out: Record<EventKind, LifecycleEvent[]> = { start: [], end: [] };
  if (mode === 'off') return out;
  const inRange = (t: number) => t >= range.from && t < range.to;
  for (const proc of procs) {
    if (inRange(proc.firstSeenMs)) out.start.push({ kind: 'start', t: proc.firstSeenMs, proc });
    if (mode === 'all' && proc.endedMs !== null && inRange(proc.endedMs)) out.end.push({ kind: 'end', t: proc.endedMs, proc });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.t - b.t || b.proc.bytes - a.proc.bytes);
  return out;
}

export interface MarkerCluster {
  kind: EventKind;
  /** Where the marker is drawn: the mean time of its events. */
  t: number;
  /** Largest lifetime total first. */
  items: LifecycleEvent[];
  /** The one process name of every item, or null when they differ. */
  name: string | null;
}

/** Markers closer than this (px) are drawn as one. */
export const CLUSTER_PX = 4;

/**
 * Groups one kind's events (oldest first) into markers: an event joins the
 * current marker while it is less than `minPx` from that marker's first
 * event at `msPerPx`, so no marker spans more than `minPx`.
 */
export function clusterMarkers(events: readonly LifecycleEvent[], msPerPx: number, minPx = CLUSTER_PX): MarkerCluster[] {
  const gap = Math.max(0, msPerPx * minPx);
  const groups: LifecycleEvent[][] = [];
  let cur: LifecycleEvent[] | null = null;
  for (const e of events) {
    if (cur && e.t - cur[0]!.t < gap) cur.push(e);
    else groups.push((cur = [e]));
  }
  return groups.map((g) => {
    const items = [...g].sort((a, b) => b.proc.bytes - a.proc.bytes || a.t - b.t);
    const name = items.every((e) => e.proc.name === items[0]!.proc.name) ? items[0]!.proc.name : null;
    return { kind: g[0]!.kind, t: Math.round(g.reduce((s, e) => s + e.t, 0) / g.length), items, name };
  });
}

/** "curl started", "7 starts", "1 end" (for the tooltip and aria text). */
export function clusterTitle(c: MarkerCluster): string {
  const n = c.items.length;
  if (n === 1) return `${c.items[0]!.proc.name} ${c.kind === 'start' ? 'started talking' : 'ended'}`;
  return `${n} ${c.kind}s`;
}

/** `/process/:pid/:start` of a `pid:start_ns` id (the id stays a string). */
export function processPath(id: string): string {
  const i = id.indexOf(':');
  return `/process/${id.slice(0, i)}/${id.slice(i + 1)}`;
}
