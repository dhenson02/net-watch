import { readFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';

const REFRESH_MS = 60 * 60 * 1000;

/** uid → username from passwd(5) text. The first entry for a uid wins, like getpwuid. */
export function parsePasswd(text: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [name, , uid] = line.split(':');
    if (!name || !uid || !/^\d+$/.test(uid)) continue;
    const n = Number(uid);
    if (!users.has(n)) users.set(n, name);
  }
  return users;
}

/**
 * The host's uid → username map, read from /etc/passwd at startup and again
 * every hour. Only local accounts: uids from NSS sources (LDAP, sssd) or from
 * containers resolve to null.
 */
export class Users {
  #path: string;
  #log: FastifyBaseLogger;
  #map = new Map<number, string>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(log: FastifyBaseLogger, path = '/etc/passwd') {
    this.#log = log.child({ module: 'users' });
    this.#path = path;
  }

  async start(): Promise<void> {
    await this.#load();
    this.#timer = setInterval(() => void this.#load(), REFRESH_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  name(uid: number): string | null {
    return this.#map.get(uid) ?? null;
  }

  async #load(): Promise<void> {
    try {
      this.#map = parsePasswd(await readFile(this.#path, 'utf8'));
    } catch (err) {
      // Keep the previous map; uids show as numbers until a read succeeds.
      this.#log.warn({ path: this.#path, err: (err as Error).message }, 'cannot read the user list');
    }
  }
}
