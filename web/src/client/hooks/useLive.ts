import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CompactTick, LiveHello } from '../../shared/api.ts';
import { getJson } from '../api.ts';

/** Most ticks any live chart can ask for (the server holds LIVE_BACKFILL). */
const CAPACITY = 3600;
const GAP_INTERVALS = 2.5;

export type LiveStatus = 'connecting' | 'live' | 'reconnecting';

interface LiveState {
  ticks: CompactTick[];
  status: LiveStatus;
  error: string | null;
}

/**
 * One EventSource per tab, shared by every useLive caller and closed when the
 * last one unmounts. On each (re)connect the server says hello; the store then
 * reloads /api/live/series and merges it with ticks that arrived meanwhile.
 */
class LiveStore {
  state: LiveState = { ticks: [], status: 'connecting', error: null };
  #listeners = new Set<() => void>();
  #users = 0;
  #es: EventSource | null = null;
  /** Ticks received while a series request is in flight; null when none is. */
  #pending: CompactTick[] | null = null;
  #ctrl: AbortController | null = null;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;

  subscribe = (fn: () => void) => {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  };

  getState = () => this.state;

  acquire(): () => void {
    clearTimeout(this.#closeTimer);
    if (this.#users++ === 0 && !this.#es) this.#open();
    return () => {
      // Brief grace period: page switches and StrictMode remounts reuse the stream.
      if (--this.#users === 0) this.#closeTimer = setTimeout(() => this.#close(), 2000);
    };
  }

  #set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.#listeners) fn();
  }

  #open() {
    const es = new EventSource('/api/live/events');
    this.#es = es;
    es.addEventListener('hello', (e) => {
      const hello = JSON.parse((e as MessageEvent<string>).data) as LiveHello;
      this.#set({ status: 'live', error: null });
      const last = this.state.ticks.at(-1)?.ts ?? null;
      if (hello.latestTs !== null && hello.latestTs !== last) this.#loadSeries();
    });
    es.addEventListener('tick', (e) => {
      const tick = JSON.parse((e as MessageEvent<string>).data) as CompactTick;
      if (this.#pending) this.#pending.push(tick);
      else this.#append([tick]);
    });
    es.onerror = () => {
      // EventSource retries by itself unless the server refused outright.
      this.#set({ status: 'reconnecting' });
      if (es.readyState === EventSource.CLOSED) {
        this.#es = null;
        setTimeout(() => this.#users > 0 && !this.#es && this.#open(), 3000);
      }
    };
  }

  async #loadSeries() {
    this.#ctrl?.abort();
    const ctrl = new AbortController();
    this.#ctrl = ctrl;
    this.#pending = [];
    try {
      const series = await getJson<CompactTick[]>(`/api/live/series?seconds=${CAPACITY}`, ctrl.signal);
      const pending = this.#pending;
      this.#pending = null;
      this.#merge(series, pending);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const pending = this.#pending ?? [];
      this.#pending = null;
      this.#append(pending);
      this.#set({ error: (err as Error).message });
    }
  }

  /** Replaces the buffer's tail with a fresh series from the server. */
  #merge(series: CompactTick[], pending: CompactTick[]) {
    const first = series[0];
    let ticks = this.state.ticks;
    if (first) {
      const kept = ticks.filter((t) => t.ts < first.ts);
      const prev = kept.at(-1);
      const head = prev && first.ts - prev.ts > GAP_INTERVALS * first.intervalMs ? [{ ...first, gap: true as const }] : [first];
      ticks = [...kept, ...head, ...series.slice(1)];
    }
    this.state = { ...this.state, ticks };
    this.#append(pending);
  }

  #append(incoming: CompactTick[]) {
    let ticks = this.state.ticks;
    for (const t of incoming) {
      if (ticks.length && t.ts <= ticks.at(-1)!.ts) continue;
      ticks = ticks === this.state.ticks ? [...ticks, t] : (ticks.push(t), ticks);
    }
    if (ticks.length > CAPACITY) ticks = ticks.slice(ticks.length - CAPACITY);
    this.#set({ ticks });
  }

  #close() {
    this.#ctrl?.abort();
    this.#es?.close();
    this.#es = null;
    this.#pending = null;
    this.state = { ticks: [], status: 'connecting', error: null };
  }
}

const store = new LiveStore();

export interface Live extends LiveState {
  /** Newest tick's time, or null before the first one. */
  latestTs: number | null;
}

/**
 * The live ring buffer: ticks from the last `seconds` (relative to the newest
 * tick), oldest first. A tick with `gap` follows missing ticks; draw a break
 * before it.
 */
export function useLive(seconds = 900): Live {
  useEffect(() => store.acquire(), []);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return useMemo(() => {
    const newest = state.ticks.at(-1);
    if (!newest) return { ...state, latestTs: null };
    const from = newest.ts - seconds * 1000;
    let i = state.ticks.length;
    while (i > 0 && state.ticks[i - 1]!.ts > from) i--;
    return { ...state, ticks: i === 0 ? state.ticks : state.ticks.slice(i), latestTs: newest.ts };
  }, [state, seconds]);
}
