import { useEffect, useState } from 'react';
import type { HealthResponse } from '../shared/api.ts';
import { getJson } from './api.ts';

const POLL_MS = 5000;

export type HealthState =
  | { kind: 'loading' }
  | { kind: 'ok'; health: HealthResponse }
  | { kind: 'error'; error: string };

/** Polls /api/health; a failed request means the API itself is unreachable. */
export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const health = await getJson<HealthResponse>('/api/health', AbortSignal.any([ctrl.signal, AbortSignal.timeout(4000)]));
        setState({ kind: 'ok', health });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setState({ kind: 'error', error: (err as Error).message });
      }
      if (!ctrl.signal.aborted) timer = setTimeout(poll, POLL_MS);
    };
    poll();

    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, []);

  return state;
}
