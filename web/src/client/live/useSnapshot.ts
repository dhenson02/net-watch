import type { LiveSnapshotResponse } from '../../shared/api.ts';
import { usePoll, type PollState } from '../hooks/usePoll.ts';

/** The table does not need every tick; the server answers from memory. */
const POLL_MS = 2000;

export interface Snapshot extends PollState<LiveSnapshotResponse> {
  /**
   * The server's clock now: its answer time plus the time since the answer
   * arrived. Ages computed from it ignore browser clock skew, and keep
   * growing while the collector is stopped.
   */
  serverNow: (browserNow: number) => number | null;
}

/** The latest process list (`/api/live/snapshot`), re-fetched every 2 s. */
export function useSnapshot(): Snapshot {
  const poll = usePoll<LiveSnapshotResponse>('/api/live/snapshot', POLL_MS);
  const serverNow = (browserNow: number) => (poll.data ? poll.data.serverTimeMs + Math.max(0, browserNow - poll.receivedAt) : null);
  return { ...poll, serverNow };
}
