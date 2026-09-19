// uid → process → app treemap (07): bytes per (uid, process name, app) over a
// range, nested into a tree with the smaller processes of each user folded
// into one "other" node.
import type { TreemapApp, TreemapDir, TreemapProc, TreemapUser } from '../../shared/api.ts';
import { badRequest } from '../http-error.ts';
import { timeFilter, type Range } from './range.ts';
import { filterSql, flowSource, UNKNOWN_UID, type Filters } from './sql.ts';

/** Processes kept per user; the rest become one "other (N processes)" node. */
export const TREEMAP_TOP = 30;
/** (uid, name, app) rows read at most; more sets `truncated`. */
export const TREEMAP_MAX_ROWS = 20_000;

/** The bytes each `dir` sums. The key is validated by parseTreemapDir; the value is the only SQL it selects. */
const METRIC_SQL: Record<TreemapDir, string> = { total: 'tx_bytes + rx_bytes', tx: 'tx_bytes', rx: 'rx_bytes' };

export function parseTreemapDir(raw: unknown): TreemapDir {
  if (raw === undefined || raw === '' || raw === 'total') return 'total';
  if (raw === 'tx' || raw === 'rx') return raw;
  throw badRequest('dir: expected total, tx or rx');
}

/**
 * Bytes per (uid, name, app), largest first. Raw `flows` (≤ 2 h) has uid;
 * `flows_1m` gets it from `processes` through flowSource (UNKNOWN_UID where
 * the process is missing). The range condition is the summary's, so the
 * total matches /api/history/summary.
 */
export function treemapQuery(r: Range, dir: TreemapDir, filters: Filters, limit: number): { sql: string; params: Record<string, unknown> } {
  const time = timeFilter(r);
  const f = filterSql(filters);
  return {
    sql: `SELECT uid, name, app, sum(${METRIC_SQL[dir]}) AS bytes
FROM ${flowSource(r.table, time, true)}
WHERE ${time}${f.sql}
GROUP BY uid, name, app
HAVING bytes > 0
ORDER BY bytes DESC, uid, name, app
LIMIT {limit:UInt32}`,
    params: { from: r.from, to: r.to, ...f.params, limit },
  };
}

/** A row of treemapQuery; the UInt64 sum arrives as a string. */
export interface TreemapRow {
  uid: number;
  name: string;
  app: string;
  bytes: string;
}

/** A user node's label: the passwd name, `uid N` when it has none (containers, NSS), `unknown uid` for UNKNOWN_UID. */
export function userLabel(uid: number, user: (uid: number) => string | null): string {
  if (uid === UNKNOWN_UID) return 'unknown uid';
  return user(uid) ?? `uid ${uid}`;
}

const byValue = <T extends { name: string; value: number }>(a: T, b: T) => b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const apps = (m: Map<string, number>): TreemapApp[] => [...m].map(([name, value]) => ({ name, value })).sort(byValue);

/**
 * Nests the rows into users → processes → apps, largest first at every
 * level. Each user keeps its `top` largest processes; when more remain than
 * one, they are summed into a last `other (N processes)` node (`folded: N`)
 * whose apps are merged.
 */
export function buildTreemap(rows: readonly TreemapRow[], user: (uid: number) => string | null, top = TREEMAP_TOP): TreemapUser[] {
  const users = new Map<number, Map<string, Map<string, number>>>();
  for (const r of rows) {
    const bytes = Number(r.bytes);
    if (!(bytes > 0)) continue;
    let procs = users.get(r.uid);
    if (!procs) users.set(r.uid, (procs = new Map()));
    let a = procs.get(r.name);
    if (!a) procs.set(r.name, (a = new Map()));
    a.set(r.app, (a.get(r.app) ?? 0) + bytes);
  }
  const out: TreemapUser[] = [];
  for (const [uid, procMap] of users) {
    const procs: TreemapProc[] = [...procMap]
      .map(([name, m]) => {
        const children = apps(m);
        return { name, value: children.reduce((s, c) => s + c.value, 0), children };
      })
      .sort(byValue);
    // Folding a single process would only hide its name.
    let kept = procs;
    if (procs.length > top + 1) {
      kept = procs.slice(0, top);
      const rest = procs.slice(top);
      const merged = new Map<string, number>();
      for (const p of rest) for (const c of p.children) merged.set(c.name, (merged.get(c.name) ?? 0) + c.value);
      kept.push({
        name: `other (${rest.length} processes)`,
        value: rest.reduce((s, p) => s + p.value, 0),
        folded: rest.length,
        children: apps(merged),
      });
    }
    out.push({ name: userLabel(uid, user), uid, value: kept.reduce((s, p) => s + p.value, 0), children: kept });
  }
  return out.sort((a, b) => b.value - a.value || a.uid - b.uid);
}
