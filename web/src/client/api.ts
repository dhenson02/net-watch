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

// URL builders for useQuery (which is keyed by URL). Ids stay strings.
export const urls = {
  historySummary: (r: TimeRange) => `/api/history/summary?${qs({ from: r.from, to: r.to })}`,
  process: (pid: string, start: string) => `/api/process/${encodeURIComponent(pid)}/${encodeURIComponent(start)}`,
  historyFlows: (r: TimeRange, dest?: string | null) => `/api/history/flows?${qs({ from: r.from, to: r.to, dest: dest || undefined })}`,
  liveFlows: (seconds: number) => `/api/live/flows?${qs({ seconds })}`,
};

export type { HistorySummary, ProcessInfo };
