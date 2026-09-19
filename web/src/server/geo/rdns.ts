// Reverse DNS for the destination table (18), off unless RDNS=1: every lookup
// is a query sent from the monitored host. On demand only (the table asks for
// the rows on screen), with an LRU cache and a per-request budget.
import { promises as dns } from 'node:dns';

export const RDNS_MAX_PER_REQUEST = 20;
export const RDNS_BUDGET_MS = 500;
const CACHE_SIZE = 10_000;
const TTL_MS = 3_600_000;

type Resolve = (ip: string) => Promise<string[]>;

/** A Map in insertion order used as an LRU: a hit moves the entry to the end. */
export class Lru<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();
  private readonly max: number;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(max: number, ttlMs: number, now: () => number = Date.now) {
    this.max = max;
    this.ttl = ttlMs;
    this.now = now;
  }

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    if (e.exp <= this.now()) return undefined;
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, { v, exp: this.now() + this.ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size(): number {
    return this.map.size;
  }
}

export class Rdns {
  readonly enabled: boolean;
  private readonly cache: Lru<string | null>;
  private readonly resolve: Resolve;

  constructor(enabled: boolean, resolve: Resolve = (ip) => dns.reverse(ip), now?: () => number) {
    this.enabled = enabled;
    this.resolve = resolve;
    this.cache = new Lru(CACHE_SIZE, TTL_MS, now);
  }

  /**
   * Names for `ips` (deduplicated). Cached answers come back at once; at most
   * RDNS_MAX_PER_REQUEST uncached ones are looked up, in parallel, for up to
   * RDNS_BUDGET_MS. The rest, and lookups still running, are `pending`
   * (a running lookup still fills the cache when it ends).
   */
  async lookup(ips: readonly string[]): Promise<{ names: Record<string, string | null>; pending: string[] }> {
    const names: Record<string, string | null> = {};
    const pending: string[] = [];
    if (!this.enabled) return { names, pending };
    const todo: string[] = [];
    for (const ip of new Set(ips)) {
      const hit = this.cache.get(ip);
      if (hit !== undefined) names[ip] = hit;
      else if (todo.length < RDNS_MAX_PER_REQUEST) todo.push(ip);
      else pending.push(ip);
    }
    if (!todo.length) return { names, pending };
    const done = new Set<string>();
    const runs = todo.map((ip) =>
      this.resolve(ip).then(
        (hosts) => {
          const name = hosts[0] ?? null;
          this.cache.set(ip, name);
          names[ip] = name;
          done.add(ip);
        },
        (err: NodeJS.ErrnoException) => {
          // No PTR record is an answer; a timeout or a server failure is not cached.
          if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') this.cache.set(ip, null);
          names[ip] = null;
          done.add(ip);
        },
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(runs), new Promise((r) => (timer = setTimeout(r, RDNS_BUDGET_MS)))]);
    clearTimeout(timer);
    for (const ip of todo) if (!done.has(ip)) pending.push(ip);
    // Answers that arrive later only fill the cache, not this response.
    const out: Record<string, string | null> = {};
    for (const ip of Object.keys(names)) out[ip] = names[ip]!;
    return { names: out, pending };
  }
}
