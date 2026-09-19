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

// URL builders for useQuery (which is keyed by URL). Ids stay strings.
export const urls = {
  historySummary: (r: TimeRange, filters: UrlFilters = {}) => `/api/history/summary?${qs({ from: r.from, to: r.to, ...filters })}`,
  process: (pid: string, start: string) => `/api/process/${encodeURIComponent(pid)}/${encodeURIComponent(start)}`,
  historyFlows: (r: TimeRange, filters: UrlFilters = {}) => `/api/history/flows?${qs({ from: r.from, to: r.to, ...filters })}`,
  liveFlows: (seconds: number) => `/api/live/flows?${qs({ seconds })}`,
  // The finest step the server allows (~1500 buckets), so a zoom always sharpens: raw
  // flows get 1 s buckets at a few minutes, not the 10 s default.
  // `compare` (1d/1w) adds the earlier window's totals (11); `unknown` the unlabelled share (16).
  historyThroughput: (r: TimeRange, p: { by: string; dir: string; top: number; filters: UrlFilters }, compare?: string | null, unknown?: boolean) =>
    `/api/history/throughput?${qs({ from: r.from, to: r.to, step: Math.max(1, Math.ceil((r.to - r.from) / 1000 / 1500)), by: p.by, dir: p.dir, top: p.top, ...p.filters, compare: compare ?? undefined, unknown: unknown ? 1 : undefined })}`,
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
  historyScatter: (r: TimeRange, p: { group: string; basis: string; filters: UrlFilters }) =>
    `/api/history/scatter?${qs({ from: r.from, to: r.to, group: p.group, basis: p.basis, ...p.filters })}`,
};

export type { HistorySummary, ProcessInfo };
