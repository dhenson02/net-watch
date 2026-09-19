// History throughput (05): URL state and the query. The pure logic is in
// throughputSeries.ts.
import { useMemo, useRef } from 'react';
import { THROUGHPUT_OTHER, type CompareOffset, type ThroughputBy, type ThroughputResponse } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import type { SlotAssigner } from '../charts/palette.ts';
import { useQuery, type QueryState } from '../hooks/useQuery.ts';
import { useSearch } from '../router.ts';
import { parseThroughputParams, type ThroughputParams } from './throughputSeries.ts';

export function useThroughputParams(): ThroughputParams {
  const search = useSearch();
  return useMemo(() => parseThroughputParams(search), [search]);
}

/**
 * The query for the page's range and params. `slots` colors process names
 * (by=name), so they match the page's other charts; other dimensions use the
 * chart's own assigner, whose slots are freed when their key leaves the answer.
 */
export function useThroughput(
  range: TimeRange,
  p: ThroughputParams,
  pageSlots: SlotAssigner,
  ownSlots: SlotAssigner,
  compare: CompareOffset | null = null,
): QueryState<ThroughputResponse> & { slotOf: Map<string, number> } {
  const q = useQuery<ThroughputResponse>(urls.historyThroughput(range, p, compare));
  const owned = useRef<{ by: ThroughputBy; keys: Set<string> }>({ by: p.by, keys: new Set() });
  const last = useRef(new Map<string, number>());
  const slotOf = useMemo(() => {
    // Stale data may belong to another `by`: keep its colors, assign nothing.
    if (q.stale) return last.current;
    const keys = (q.data?.keys ?? []).filter((k) => k !== THROUGHPUT_OTHER);
    let out: Map<string, number>;
    if (p.by === 'name') {
      out = pageSlots.assign(keys);
    } else {
      // This chart is the assigner's only user: keys that left the answer (or
      // belong to another `by`) free their slots now; keys that stay keep theirs.
      const now = new Set(keys);
      const gone = owned.current.by !== p.by ? owned.current.keys : [...owned.current.keys].filter((k) => !now.has(k));
      ownSlots.release(gone);
      owned.current = { by: p.by, keys: now };
      out = ownSlots.assign(keys);
    }
    last.current = out;
    return out;
  }, [q.data, q.stale, p.by, pageSlots, ownSlots]);
  return { ...q, slotOf };
}
