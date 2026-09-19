import type { ApiError, HistorySummary, ProcessInfo } from '../shared/api.ts';

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    // API errors carry `{ error }`; fall back to the status line otherwise.
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
};

export interface TimeRange {
  from: number;
  to: number;
}

/** The History page's `filter.*` values, sent as the endpoints' name/app/proto/uid/dest params. */
type UrlFilters = Partial<Record<'name' | 'app' | 'proto' | 'uid' | 'dest', string>>;

/** The finest step (s) the server allows for a range: about 1500 buckets. */
const finestStep = (r: TimeRange) => Math.max(1, Math.ceil((r.to - r.from) / 1000 / 1500));

// URL builders for useQuery (which is keyed by URL). Ids stay strings.
export const urls = {
  historySummary: (r: TimeRange, filters: UrlFilters = {}) => `/api/history/summary?${qs({ from: r.from, to: r.to, ...filters })}`,
  process: (pid: string, start: string) => `/api/process/${encodeURIComponent(pid)}/${encodeURIComponent(start)}`,
  historyFlows: (r: TimeRange, filters: UrlFilters = {}) => `/api/history/flows?${qs({ from: r.from, to: r.to, ...filters })}`,
  liveFlows: (seconds: number) => `/api/live/flows?${qs({ seconds })}`,
  // The finest step the server allows (~1500 buckets), so a zoom always sharpens: raw
  // flows get 1 s buckets at a few minutes, not the 10 s default.
  // `compare` (1d/1w) adds the earlier window's totals (11); `unknown` the unlabelled share (16);
  // `calls` the call rates (14).
  historyThroughput: (
    r: TimeRange,
    p: { by: string; dir: string; top: number; filters: UrlFilters },
    compare?: string | null,
    unknown?: boolean,
    calls?: boolean,
  ) =>
    `/api/history/throughput?${qs({ from: r.from, to: r.to, step: finestStep(r), by: p.by, dir: p.dir, top: p.top, ...p.filters, compare: compare ?? undefined, unknown: unknown ? 1 : undefined, calls: calls ? 1 : undefined })}`,
  // 13: per-tick p95/max vs the mean over the same buckets as historyThroughput; `dir` both|tx|rx|total, ≤ 24 h.
  historyBurst: (r: TimeRange, p: { dir: string; filters: UrlFilters }) =>
    `/api/history/burst?${qs({ from: r.from, to: r.to, step: finestStep(r), dir: p.dir, ...p.filters })}`,
  // 14: one instance's bytes and calls, from raw flows, at the finest step.
  processCalls: (pid: string, start: string, r: TimeRange) =>
    `/api/process/${encodeURIComponent(pid)}/${encodeURIComponent(start)}/calls?${qs({ from: r.from, to: r.to, step: finestStep(r) })}`,
  // `names` is comma-separated; omitted means the largest processes of any name.
  historyLifecycle: (r: TimeRange, p: { names?: readonly string[]; uid?: string; limit?: number } = {}) =>
    `/api/history/lifecycle?${qs({ from: r.from, to: r.to, names: p.names?.length ? p.names.join(',') : undefined, uid: p.uid, limit: p.limit })}`,
  // 06: the heatmap's own window (not the page range); `tz` is the browser's.
  historyHeatmap: (r: TimeRange, p: { tz: string; metric: string; split: string; filters: UrlFilters }) =>
    `/api/history/heatmap?${qs({ from: r.from, to: r.to, tz: p.tz, metric: p.metric === 'total' ? undefined : p.metric, split: p.split === 'none' ? undefined : p.split, ...p.filters })}`,
  // 07: `dir` total (default) | tx | rx.
  historyTreemap: (r: TimeRange, p: { dir: string; filters: UrlFilters }) =>
    `/api/history/treemap?${qs({ from: r.from, to: r.to, dir: p.dir === 'total' ? undefined : p.dir, ...p.filters })}`,
  // 09: `name`/`uid` narrow it (exact); the server caps it at `limit` (default 500).
  historyLifetimes: (r: TimeRange, p: { name?: string; uid?: string; limit?: number } = {}) =>
    `/api/history/lifetimes?${qs({ from: r.from, to: r.to, name: p.name, uid: p.uid, limit: p.limit })}`,
  // 10: calls per log2 bucket of bytes per call; `dir` tx (default) | rx, `by` app (default) | name.
  historyBytesPerCall: (r: TimeRange, p: { dir: string; by: string; filters: UrlFilters }) =>
    `/api/history/bytes-per-call?${qs({ from: r.from, to: r.to, dir: p.dir === 'tx' ? undefined : p.dir, by: p.by === 'app' ? undefined : p.by, ...p.filters })}`,
  // 10: one instance, from raw flows.
  processBytesPerCall: (pid: string, start: string, r: TimeRange, dir: string) =>
    `/api/process/${encodeURIComponent(pid)}/${encodeURIComponent(start)}/bytes-per-call?${qs({ from: r.from, to: r.to, dir: dir === 'tx' ? undefined : dir })}`,
  // 15: active ticks per destination and their periodicity, from raw flows: one instance (≤ 24 h) or every
  // instance of a name (≤ 6 h; the server keeps the last part of a longer range).
  processBeacons: (pid: string, start: string, r: TimeRange) =>
    `/api/process/${encodeURIComponent(pid)}/${encodeURIComponent(start)}/beacons?${qs({ from: r.from, to: r.to })}`,
  historyBeacons: (name: string, r: TimeRange) => `/api/history/beacons?${qs({ name, from: r.from, to: r.to })}`,
  // 17: first contacts of a program with an address; `names` narrows it, the flags drop the default exclusions.
  historyNewDests: (r: TimeRange, p: { names?: readonly string[]; ports?: boolean; loopback?: boolean; warmup?: boolean; limit?: number } = {}) =>
    `/api/history/new-dests?${qs({
      from: r.from,
      to: r.to,
      names: p.names?.length ? p.names.join(',') : undefined,
      ports: p.ports ? 1 : undefined,
      loopback: p.loopback ? 1 : undefined,
      warmup: p.warmup ? 1 : undefined,
      limit: p.limit,
    })}`,
  // 18: bytes per ASN / per country (grouped by the server's geo table), and the destination table.
  historyAsn: (r: TimeRange, p: { dir: string; filters?: UrlFilters }) =>
    `/api/history/asn?${qs({ from: r.from, to: r.to, dir: p.dir === 'total' ? undefined : p.dir, ...p.filters })}`,
  historyCountries: (r: TimeRange, p: { dir: string; filters?: UrlFilters }) =>
    `/api/history/countries?${qs({ from: r.from, to: r.to, dir: p.dir === 'total' ? undefined : p.dir, ...p.filters })}`,
  historyDestinations: (r: TimeRange, p: { dir: string; asn?: number | null; cc?: string | null; scope?: string; limit?: number; filters?: UrlFilters }) =>
    `/api/history/destinations?${qs({
      from: r.from,
      to: r.to,
      dir: p.dir === 'total' ? undefined : p.dir,
      asn: p.asn ?? undefined,
      cc: p.cc ?? undefined,
      scope: p.scope === 'all' ? undefined : p.scope,
      limit: p.limit,
      ...p.filters,
    })}`,
  // 18: reverse DNS on demand (only with RDNS=1 on the server).
  rdns: (ips: readonly string[]) => `/api/rdns?${qs({ ips: ips.join(',') })}`,
  historyScatter: (r: TimeRange, p: { group: string; basis: string; filters: UrlFilters }) =>
    `/api/history/scatter?${qs({ from: r.from, to: r.to, group: p.group, basis: p.basis, ...p.filters })}`,
};

export type { HistorySummary, ProcessInfo };
