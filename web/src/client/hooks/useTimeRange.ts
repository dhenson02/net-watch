import { useState } from 'react';
import type { TimeRange } from '../api.ts';
import { useSearch } from '../router.ts';

export const DEFAULT_SPAN_MS = 3600_000;

/**
 * The page's time range from `?from&to` (ms since epoch). Without them it is
 * the hour before the page was opened; nothing is written to the URL until the
 * user picks a range.
 */
export function useTimeRange(): TimeRange {
  const [openedAt] = useState(() => Date.now());
  const params = new URLSearchParams(useSearch());
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && from < to) return { from, to };
  return { from: openedAt - DEFAULT_SPAN_MS, to: openedAt };
}
