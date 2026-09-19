import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson } from '../api.ts';

const MAX_CACHED = 50;
/** Last good response per URL (most recently used last). */
const cache = new Map<string, unknown>();

function remember(url: string, data: unknown) {
  cache.delete(url);
  cache.set(url, data);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

export interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** `data` belongs to an earlier URL or an earlier fetch of this one. */
  stale: boolean;
  reload: () => void;
}

/**
 * GETs `url` (null = nothing to fetch). Stale-while-revalidate: while a new
 * URL loads, the cached answer for it, or else the previous URL's data, stays
 * visible. Changing the URL or unmounting aborts the request in flight, which
 * also cancels its ClickHouse query on the server.
 *
 * `refreshOn` refetches (keeping the old data visible) when it changes to a
 * different value; going from undefined to a first value does not, since that
 * is just the value becoming known.
 */
export function useQuery<T>(url: string | null, refreshOn?: unknown): QueryState<T> {
  const [state, setState] = useState<{ url: string | null; data: T | undefined; error: string | null; loading: boolean }>(() => ({
    url,
    data: url ? (cache.get(url) as T | undefined) : undefined,
    error: null,
    loading: url !== null,
  }));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) {
      setState({ url, data: undefined, error: null, loading: false });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ url, data: (cache.get(url) as T | undefined) ?? s.data, error: null, loading: true }));
    getJson<T>(url, ctrl.signal).then(
      (data) => {
        remember(url, data);
        setState({ url, data, error: null, loading: false });
      },
      (err: Error) => {
        if (!ctrl.signal.aborted) setState((s) => ({ ...s, error: err.message, loading: false }));
      },
    );
    return () => ctrl.abort();
  }, [url, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const seen = useRef(refreshOn);
  useEffect(() => {
    const prev = seen.current;
    seen.current = refreshOn;
    if (prev !== undefined && prev !== refreshOn) reload();
  }, [refreshOn, reload]);

  const fresh = state.url === url && !state.loading;
  return { data: state.data, error: state.error, loading: state.loading, stale: !fresh && state.data !== undefined, reload };
}
