import { useSyncExternalStore } from 'react';
import type { GeoStatus } from '../shared/api.ts';

// The server loads the IP → ASN table in the background (and reloads it when
// the file changes). `useHealth` publishes each poll's status here so pages
// can show the table's state and refetch what depends on it.

let current: GeoStatus | undefined;
const listeners = new Set<() => void>();

const sameStatus = (a: GeoStatus | undefined, b: GeoStatus) =>
  a !== undefined && a.loaded === b.loaded && a.entries === b.entries && a.fileDate === b.fileDate && a.error === b.error;

export function publishGeoStatus(status: GeoStatus) {
  if (sameStatus(current, status)) return;
  current = status;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The latest polled status; undefined until the first health poll answers. */
export function useGeoStatus(): GeoStatus | undefined {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * Changes whenever a different table gets loaded (or unloaded); undefined
 * until the first health poll. Pass it to `useQuery` as `refreshOn` for
 * responses the server enriches with geo data.
 */
export function useGeoEpoch(): string | undefined {
  const g = useGeoStatus();
  return g && (g.loaded ? `${g.entries}:${g.fileDate}` : 'none');
}
