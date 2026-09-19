// Pure row logic for the top-talkers table (02): sparkline series, the idle
// filter, text filter and sorting. No React, so node --test can run it.
import type { CompactTick, LiveProcessRow } from '../../shared/api.ts';

/** Sparkline window. */
export const SPARK_MS = 60_000;
/** A live row with no traffic for this long is idle. */
export const IDLE_MS = 30_000;
/** Rows rendered at most; the rest are counted, not virtualized. */
export const MAX_ROWS = 200;

type Point = number | null;

export interface Spark {
  tx: Point[];
  rx: Point[];
  /** Σ(tx + rx) over the window, for sorting by the sparkline column. */
  sum: number;
  /** Newest tick in which the process had traffic; null when none in the window. */
  lastActiveTs: number | null;
}

/**
 * Per-process 60 s series from the live ring buffer. A process absent from a
 * tick had no traffic in it (0); a null before each gap tick breaks the line.
 * Only ids in `ids` get a series.
 */
export function buildSparks(ticks: readonly CompactTick[], ids: Iterable<string>, windowMs = SPARK_MS): Map<string, Spark> {
  const out = new Map<string, Spark>();
  for (const id of ids) out.set(id, { tx: [], rx: [], sum: 0, lastActiveTs: null });
  const newest = ticks.at(-1);
  if (!newest || !out.size) return out;

  let i = ticks.length;
  while (i > 0 && ticks[i - 1]!.ts > newest.ts - windowMs) i--;
  const all = [...out.values()];
  const first = i;
  for (; i < ticks.length; i++) {
    const t = ticks[i]!;
    for (const s of all) {
      if (t.gap && i > first) {
        s.tx.push(null);
        s.rx.push(null);
      }
      s.tx.push(0);
      s.rx.push(0);
    }
    for (const p of t.procs) {
      const s = out.get(p.id);
      if (!s) continue;
      s.tx[s.tx.length - 1] = p.tx;
      s.rx[s.rx.length - 1] = p.rx;
      s.sum += p.tx + p.rx;
      if (p.tx > 0 || p.rx > 0) s.lastActiveTs = t.ts;
    }
  }
  return out;
}

/**
 * Idle: live, no traffic now and none in the last 30 s of ticks. Ended rows
 * are never idle, so they stay visible while they fade out.
 */
export function isIdle(row: LiveProcessRow, spark: Spark | undefined, newestTs: number | null): boolean {
  if (row.endedMs !== null) return false;
  if (row.txKbps > 0 || row.rxKbps > 0) return false;
  const last = spark?.lastActiveTs ?? null;
  return last === null || newestTs === null || newestTs - last >= IDLE_MS;
}

/** Case-insensitive substring match on name or cmdline. */
export function matchesFilter(row: LiveProcessRow, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  return !f || row.name.toLowerCase().includes(f) || row.cmdline.toLowerCase().includes(f);
}

/**
 * Append process names not yet in `known`, in order of first appearance (new
 * names sorted among themselves). Never removes or reorders existing entries,
 * and returns `known` itself when nothing is new so React can skip the update.
 */
export function appendNames(known: readonly string[], rows: readonly LiveProcessRow[]): readonly string[] {
  const have = new Set(known);
  const fresh: string[] = [];
  for (const r of rows) {
    if (r.name && !have.has(r.name)) {
      have.add(r.name);
      fresh.push(r.name);
    }
  }
  if (fresh.length === 0) return known;
  fresh.sort((a, b) => a.localeCompare(b));
  return [...known, ...fresh];
}

export const SORT_KEYS =['rate', 'name', 'pid', 'user', 'tx', 'rx', 'spark', 'flows', 'txTotal', 'rxTotal', 'age'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface Sort {
  key: SortKey;
  desc: boolean;
}

/** `?sort=` value: the key, prefixed with `-` for descending. */
export const DEFAULT_SORT = '-rate';

export function parseSort(param: string): Sort {
  const desc = param.startsWith('-');
  const key = (desc ? param.slice(1) : param) as SortKey;
  return SORT_KEYS.includes(key) ? { key, desc } : parseSort(DEFAULT_SORT);
}

export const formatSort = (s: Sort) => `${s.desc ? '-' : ''}${s.key}`;

/** Text columns start ascending; numbers start with the largest. */
const TEXT_KEYS: readonly SortKey[] = ['name', 'user'];

/** The sort after clicking `key`'s header: flip it if it is already the sort key. */
export function nextSort(cur: Sort, key: SortKey): Sort {
  return cur.key === key ? { key, desc: !cur.desc } : { key, desc: !TEXT_KEYS.includes(key) };
}

/** The username, or `uid N` when the server has none for it. */
export const userLabel = (r: LiveProcessRow) => r.user ?? `uid ${r.uid}`;

function sortValue(r: LiveProcessRow, key: SortKey, sparks: Map<string, Spark>): number | string {
  switch (key) {
    case 'rate':
      return r.txKbps + r.rxKbps;
    case 'name':
      return r.name.toLowerCase();
    case 'pid':
      return r.pid;
    case 'user':
      return userLabel(r).toLowerCase();
    case 'tx':
      return r.txKbps;
    case 'rx':
      return r.rxKbps;
    case 'spark':
      return sparks.get(r.id)?.sum ?? 0;
    case 'flows':
      return r.nFlows;
    case 'txTotal':
      return r.txTotal;
    case 'rxTotal':
      return r.rxTotal;
    case 'age':
      // Older first when descending.
      return -r.startMs;
  }
}

/** A sorted copy. Ties fall back to the id, so rows keep their place between polls. */
export function sortRows(rows: readonly LiveProcessRow[], sort: Sort, sparks: Map<string, Spark>): LiveProcessRow[] {
  const dir = sort.desc ? -1 : 1;
  const keyed = rows.map((r) => ({ r, v: sortValue(r, sort.key, sparks) }));
  keyed.sort((a, b) => {
    if (a.v !== b.v) return (a.v < b.v ? -1 : 1) * dir;
    return a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0;
  });
  return keyed.map((k) => k.r);
}
