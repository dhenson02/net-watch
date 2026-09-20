import type { FastifyBaseLogger } from 'fastify';
import type { RedisStorage, StorageRow } from '../../shared/api.ts';
import type { Redis } from '../db/redis.ts';
import { withTimeout } from '../timeout.ts';

const KEY_ENDED = 'netwatch:ended';
const KEY_ALIVE = 'netwatch:alive';
const FIXED = { snapshot: 'netwatch:snapshot', stream: 'netwatch:stream', meta: 'netwatch:meta' } as const;

const CHUNK = 500;
const CACHE_MS = 30_000;

/** Calendar day of `ms` in `tz`, as YYYY-MM-DD (same boundaries as ClickHouse's toDate). */
export function dayOf(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

/** Hour of day of `ms` in `tz`, "00".."23". */
export function hourOf(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(ms);
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** MEMORY USAGE of every key, in pipelined chunks. Missing keys count 0. */
async function sizes(redis: Redis, keys: string[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = await Promise.all(keys.slice(i, i + CHUNK).map((k) => redis.sendCommand(['MEMORY', 'USAGE', k])));
    for (const v of part) out.push(num(v));
  }
  return out;
}

const procKeys = (id: string) => [`netwatch:proc:${id}`, `netwatch:proc:${id}:dests`];

const infoField = (info: string, name: string) => {
  const m = new RegExp(`^${name}:(.+)$`, 'm').exec(info);
  return m ? Number(m[1]!.trim()) : null;
};

let cache: { tz: string; at: number; value: RedisStorage } | null = null;

export const forgetRedisScan = () => {
  cache = null;
};

/**
 * What netwatch keeps in Redis, in RAM (MEMORY USAGE) and, as one figure, in
 * the append-only file. Ended processes are grouped by the day they ended
 * (the score of `netwatch:ended`); everything else is a few fixed keys.
 * Walking every process key costs a round trip per 500, so the result is
 * cached for 30 s.
 */
export async function redisStorage(redis: Redis, tz: string, log: FastifyBaseLogger): Promise<RedisStorage> {
  if (cache && cache.tz === tz && Date.now() - cache.at < CACHE_MS) return cache.value;

  const [memInfo, persInfo, keys] = await withTimeout(
    Promise.all([redis.info('memory'), redis.info('persistence'), redis.dbSize()]),
    3000,
    'redis INFO',
  );
  const ended = await redis.zRangeWithScores(KEY_ENDED, 0, -1);
  const alive = await redis.sMembers(KEY_ALIVE);

  const endedSizes = await sizes(redis, ended.flatMap((e) => procKeys(e.value)));
  const aliveSizes = await sizes(redis, alive.flatMap(procKeys));
  const fixedSizes = await sizes(redis, [FIXED.snapshot, FIXED.stream, FIXED.meta, KEY_ALIVE, KEY_ENDED]);

  const byDay = new Map<string, { bytes: number; count: number; hours: Map<string, { bytes: number; count: number }> }>();
  ended.forEach((e, i) => {
    const day = dayOf(e.score, tz);
    const hour = hourOf(e.score, tz);
    const bytes = (endedSizes[2 * i] ?? 0) + (endedSizes[2 * i + 1] ?? 0);
    const d = byDay.get(day) ?? { bytes: 0, count: 0, hours: new Map() };
    const h = d.hours.get(hour) ?? { bytes: 0, count: 0 };
    d.bytes += bytes;
    d.count++;
    h.bytes += bytes;
    h.count++;
    d.hours.set(hour, h);
    byDay.set(day, d);
  });
  const days: StorageRow[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, d]) => ({
      key: day,
      label: day,
      bytes: d.bytes,
      count: d.count,
      deletable: true,
      children: [...d.hours.entries()]
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .map(([h, v]) => ({ key: `${day} ${h}`, label: `${h}:00`, bytes: v.bytes, count: v.count, deletable: false })),
    }));

  const usedMemory = infoField(memInfo, 'used_memory') ?? 0;
  const [snapshot = 0, stream = 0, meta = 0, aliveSet = 0, endedIndex = 0] = fixedSizes;
  const liveBytes = aliveSizes.reduce((s, n) => s + n, 0) + aliveSet;
  const known = days.reduce((s, r) => s + r.bytes, 0) + snapshot + stream + meta + liveBytes + endedIndex;
  const fixed: StorageRow[] = [
    { key: 'snapshot', label: 'Latest snapshot', bytes: snapshot + meta, count: 1, deletable: false },
    { key: 'stream', label: 'Tick stream (live charts)', bytes: stream, count: 0, deletable: false },
    { key: 'live', label: 'Live processes', bytes: liveBytes, count: alive.length, deletable: false },
    { key: 'index', label: 'Ended-process index', bytes: endedIndex, count: ended.length, deletable: false },
    { key: 'other', label: 'Redis overhead and other', bytes: Math.max(0, usedMemory - known), count: 0, deletable: false },
  ];

  const aofOn = infoField(persInfo, 'aof_enabled') === 1;
  const value: RedisStorage = {
    usedMemory,
    maxMemory: infoField(memInfo, 'maxmemory') ?? 0,
    aofBytes: aofOn ? (infoField(persInfo, 'aof_current_size') ?? infoField(persInfo, 'aof_base_size')) : null,
    keys,
    fixed,
    days,
    scannedAt: Date.now(),
  };
  log.debug({ ended: ended.length, alive: alive.length }, 'storage: redis scan');
  cache = { tz, at: Date.now(), value };
  return value;
}

/**
 * Deletes the hashes of processes that ended on `days` and their index
 * entries. Live processes are never touched: the collector rewrites them.
 */
export async function deleteEndedDays(redis: Redis, tz: string, days: string[], log: FastifyBaseLogger): Promise<{ deleted: number; aofRewrite: boolean }> {
  const want = new Set(days);
  const ended = await redis.zRangeWithScores(KEY_ENDED, 0, -1);
  const doomed = ended.filter((e) => want.has(dayOf(e.score, tz))).map((e) => e.value);
  for (let i = 0; i < doomed.length; i += CHUNK) {
    const ids = doomed.slice(i, i + CHUNK);
    await redis.unlink(ids.flatMap(procKeys));
    await redis.zRem(KEY_ENDED, ids);
  }
  forgetRedisScan();
  log.info({ days, processes: doomed.length }, 'storage: deleted ended processes from redis');

  // The append-only file keeps the deleted commands until it is rewritten.
  let aofRewrite = false;
  try {
    const aofOn = infoField(await redis.info('persistence'), 'aof_enabled') === 1;
    if (aofOn) {
      await redis.sendCommand(['BGREWRITEAOF']);
      aofRewrite = true;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'storage: BGREWRITEAOF not started');
  }
  return { deleted: doomed.length, aofRewrite };
}
