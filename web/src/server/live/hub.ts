import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { CompactTick, LiveSnapshot } from '../../shared/api.ts';
import type { Redis } from '../db/redis.ts';
import { compactTick, parseSnapshot } from './compact.ts';

export const STREAM_KEY = 'netwatch:stream';
const PAGE = 300;
const BLOCK_MS = 5000;
/** A tick this many intervals after the previous one means ticks are missing. */
const GAP_INTERVALS = 2.5;

type Entry = { id: string; message: Record<string, string> };
export type TickListener = (tick: CompactTick) => void;

/** Compares stream ids (`ms-seq`) numerically. */
export function compareIds(a: string, b: string): number {
  const [am = 0n, as = 0n] = a.split('-').map(BigInt);
  const [bm = 0n, bs = 0n] = b.split('-').map(BigInt);
  return am === bm ? (as === bs ? 0 : as < bs ? -1 : 1) : am < bm ? -1 : 1;
}

/**
 * The single reader of `netwatch:stream`. Keeps the last `capacity` ticks in
 * compact form, plus the latest full snapshot, and fans new ticks out to
 * subscribers (the SSE connections). Browsers never read Redis themselves.
 */
export class LiveHub {
  #conn: Redis;
  #log: FastifyBaseLogger;
  #capacity: number;
  #ring: CompactTick[] = [];
  #latest: LiveSnapshot | null = null;
  #listeners = new Set<TickListener>();
  /** Last stream id ingested; null until the backfill has run. */
  #lastId: string | null = null;
  /** Set after an error: the next read first checks whether entries were trimmed meanwhile. */
  #resync = false;
  #pendingGap = false;
  #stop = new AbortController();
  #done: Promise<void> | null = null;

  constructor(redis: Redis, log: FastifyBaseLogger, capacity: number) {
    // XREAD BLOCK holds its connection; blocking the shared client (which fails
    // fast while offline) would stall /api/health behind it.
    this.#conn = redis.duplicate();
    this.#conn.on('error', () => {}); // outages are logged by the read loop
    this.#log = log.child({ module: 'live-hub' });
    this.#capacity = capacity;
  }

  start(): void {
    this.#conn.connect().catch(() => {}); // reconnects forever in the background
    this.#done = this.#run();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    this.#conn.destroy(); // rejects a pending XREAD
    await this.#done;
  }

  /** Ticks from the last `seconds` (relative to the newest tick), oldest first. */
  series(seconds: number): CompactTick[] {
    const newest = this.#ring.at(-1);
    if (!newest) return [];
    const from = newest.ts - seconds * 1000;
    let i = this.#ring.length;
    while (i > 0 && this.#ring[i - 1]!.ts > from) i--;
    return this.#ring.slice(i);
  }

  latest(): LiveSnapshot | null {
    return this.#latest;
  }

  latestTs(): number | null {
    return this.#ring.at(-1)?.ts ?? null;
  }

  subscribe(fn: TickListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async #run(): Promise<void> {
    const signal = this.#stop.signal;
    let failing = false;
    while (!signal.aborted) {
      try {
        if (!this.#conn.isReady) await once(this.#conn, 'ready', { signal });
        if (this.#lastId === null) await this.#backfill();
        else if (this.#resync) await this.#checkTrimmed();
        this.#resync = false;
        if (failing) this.#log.info('live stream reader recovered');
        failing = false;
        await this.#readOnce();
      } catch (err) {
        if (signal.aborted) break;
        if (!failing) this.#log.warn({ err: (err as Error).message }, 'live stream reader failed; retrying');
        failing = true;
        this.#resync = true;
        await sleep(1000, undefined, { signal }).catch(() => {});
      }
    }
  }

  async #backfill(): Promise<void> {
    const start = performance.now();
    const entries: Entry[] = []; // newest first
    let end = '+';
    while (entries.length < this.#capacity) {
      const count = Math.min(PAGE, this.#capacity - entries.length);
      const page = (await this.#conn.xRevRange(STREAM_KEY, end, '-', { COUNT: count })) as Entry[];
      entries.push(...page);
      if (page.length < count) break;
      end = `(${page.at(-1)!.id}`;
    }
    this.#ring = [];
    for (let i = entries.length - 1; i >= 0; i--) this.#ingest(entries[i]!, false);
    this.#lastId = entries[0]?.id ?? '0-0';
    this.#log.info({ ticks: this.#ring.length, ms: Math.round(performance.now() - start) }, 'live backfill loaded');
  }

  /** After an outage: if the stream was trimmed past our position, ticks were lost. */
  async #checkTrimmed(): Promise<void> {
    if (!(await this.#conn.exists(STREAM_KEY))) return;
    const info = (await this.#conn.xInfoStream(STREAM_KEY)) as { 'first-entry'?: { id: string } | null };
    const first = info['first-entry']?.id;
    if (first && this.#lastId && compareIds(first, this.#lastId) > 0) this.#pendingGap = true;
  }

  async #readOnce(): Promise<void> {
    const res = (await this.#conn.xRead({ key: STREAM_KEY, id: this.#lastId! }, { BLOCK: BLOCK_MS, COUNT: 50 })) as
      | { name: string; messages: Entry[] }[]
      | null;
    for (const stream of res ?? []) {
      for (const entry of stream.messages) {
        this.#lastId = entry.id;
        this.#ingest(entry, true);
      }
    }
  }

  #ingest(entry: Entry, notify: boolean): void {
    let snap: LiveSnapshot;
    try {
      snap = parseSnapshot(entry.message.json ?? '');
    } catch (err) {
      this.#log.warn({ id: entry.id, err: (err as Error).message }, 'skipping unparsable stream entry');
      return;
    }
    const tick = compactTick(snap);
    const prev = this.#ring.at(-1);
    if (prev && tick.ts <= prev.ts) return; // never go backwards (e.g. a clock step)
    if (this.#pendingGap || (prev && tick.ts - prev.ts > GAP_INTERVALS * Math.max(tick.intervalMs, prev.intervalMs))) {
      tick.gap = true;
    }
    this.#pendingGap = false;

    this.#latest = snap;
    this.#ring.push(tick);
    if (this.#ring.length > this.#capacity) this.#ring.splice(0, this.#ring.length - this.#capacity);
    if (!notify) return;
    for (const fn of this.#listeners) {
      try {
        fn(tick);
      } catch (err) {
        this.#log.warn({ err: (err as Error).message }, 'live subscriber failed');
      }
    }
  }
}
