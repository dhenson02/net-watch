import { useEffect, useState } from 'react';
import { getJson } from '../api.ts';

export interface PollState<T> {
  /** Last good response; kept while later polls fail. */
  data: T | undefined;
  /** Error of the latest poll, null once one succeeds. */
  error: string | null;
  /** Browser clock when `data` arrived. */
  receivedAt: number;
}

/**
 * GETs `url` every `ms` (the next request starts after the previous one
 * settles, so a slow backend never stacks requests). Like useHealth, each
 * request gives up after 4 s.
 */
export function usePoll<T>(url: string, ms = 5000): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: undefined, error: null, receivedAt: 0 });

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const data = await getJson<T>(url, AbortSignal.any([ctrl.signal, AbortSignal.timeout(4000)]));
        setState({ data, error: null, receivedAt: Date.now() });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, error: (err as Error).message }));
      }
      if (!ctrl.signal.aborted) timer = setTimeout(poll, ms);
    };
    poll();

    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [url, ms]);

  return state;
}
