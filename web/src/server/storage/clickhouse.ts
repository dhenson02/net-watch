import type { FastifyBaseLogger } from 'fastify';
import type { ClickHouseStorage, StorageRow } from '../../shared/api.ts';
import { chQuery } from '../ch/query.ts';
import type { ClickHouseClient } from '../db/clickhouse.ts';
import { HttpError, badRequest } from '../http-error.ts';
import { dayOf, hourOf } from './redis.ts';

interface Spec {
  by: string;
  /** Partition ids look like this (checked before one is put into a statement). */
  id: RegExp;
  label: (id: string) => string;
  deletable: boolean;
}

/** The tables in clickhouse/schema.sql. `processes` has no partitions and is the name lookup for history, so it stays. */
const TABLES: Record<string, Spec> = {
  flows: { by: 'day', id: /^\d{4}-\d{2}-\d{2}$/, label: (id) => id, deletable: true },
  flows_1m: { by: 'month', id: /^\d{6}$/, label: (id) => `${id.slice(0, 4)}-${id.slice(4)}`, deletable: true },
  processes: { by: 'not partitioned', id: /^tuple\(\)$/, label: () => 'all', deletable: false },
};

interface PartRow {
  table: string;
  partition: string;
  disk: string;
  raw: string;
  rows: string;
}

async function partitions(ch: ClickHouseClient, log: FastifyBaseLogger, db: string, signal?: AbortSignal): Promise<PartRow[]> {
  return chQuery<PartRow>(
    ch,
    log,
    `SELECT table, partition,
            sum(bytes_on_disk) AS disk, sum(data_uncompressed_bytes) AS raw, sum(rows) AS rows
       FROM system.parts
      WHERE database = {db:String} AND active AND table IN {tables:Array(String)}
      GROUP BY table, partition
      ORDER BY table, partition DESC`,
    { db, tables: Object.keys(TABLES) },
    signal,
  );
}

export async function clickhouseTimezone(ch: ClickHouseClient, log: FastifyBaseLogger, signal?: AbortSignal): Promise<string> {
  const [row] = await chQuery<{ tz: string }>(ch, log, 'SELECT timezone() AS tz', {}, signal);
  return row?.tz ?? 'UTC';
}

export async function clickhouseStorage(ch: ClickHouseClient, log: FastifyBaseLogger, db: string, signal?: AbortSignal): Promise<ClickHouseStorage> {
  const parts = await partitions(ch, log, db, signal);
  const tables = Object.entries(TABLES).map(([table, spec]) => {
    const rows: StorageRow[] = parts
      .filter((p) => p.table === table)
      .map((p) => ({
        key: p.partition,
        label: spec.label(p.partition),
        bytes: Number(p.disk),
        rawBytes: Number(p.raw),
        count: Number(p.rows),
        deletable: spec.deletable,
        expandable: table !== 'processes',
      }));
    return {
      table,
      by: spec.by,
      deletable: spec.deletable,
      bytes: rows.reduce((s, r) => s + r.bytes, 0),
      count: rows.reduce((s, r) => s + r.count, 0),
      rows,
    };
  });
  return { bytes: tables.reduce((s, t) => s + t.bytes, 0), tables };
}

/**
 * Drops whole partitions (a day of `flows`, a month of `flows_1m`) with the
 * writable client. Only partitions that exist right now are accepted, and
 * their ids are pattern-checked, since DROP PARTITION takes a literal.
 */
export async function dropPartitions(
  reader: ClickHouseClient,
  admin: ClickHouseClient,
  log: FastifyBaseLogger,
  db: string,
  table: string,
  keys: string[],
): Promise<number> {
  const spec = TABLES[table];
  if (!spec?.deletable) throw badRequest(`table: cannot delete from "${table}"`);
  const existing = new Set((await partitions(reader, log, db)).filter((p) => p.table === table).map((p) => p.partition));
  for (const k of keys) {
    if (!spec.id.test(k) || !existing.has(k)) throw badRequest(`keys: no such partition "${k.slice(0, 20)}" in ${table}`);
  }
  for (const k of keys) {
    try {
      await admin.command({ query: `ALTER TABLE \`${db}\`.\`${table}\` DROP PARTITION '${k}'` });
    } catch (err) {
      log.warn({ table, partition: k, err: (err as Error).message }, 'storage: drop partition failed');
      throw new HttpError(502, `ClickHouse: ${(err as Error).message}`);
    }
    log.info({ table, partition: k }, 'storage: dropped partition');
  }
  return keys.length;
}

/**
 * A partition split finer than ClickHouse stores it: a `flows` day by hour, a
 * `flows_1m` month by day, or a `flows_1m` day by hour. ClickHouse only sizes
 * whole parts, so each row's bytes are the partition's on-disk bytes shared out
 * by row count (`estimated`). Hour rows are labelled in `tz` (the browser's) and
 * keyed by their start in epoch ms, so an hour of a UTC-day partition may fall on
 * another local day. Scans just the time column of one partition.
 */
export async function clickhouseBreakdown(
  ch: ClickHouseClient,
  log: FastifyBaseLogger,
  db: string,
  table: string,
  key: string,
  tz: string,
  signal?: AbortSignal,
): Promise<StorageRow[]> {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(key);
  const month = /^\d{6}$/.test(key);
  let partition: string;
  let sql: string;
  let params: Record<string, unknown>;
  let toRow: (bucket: string) => Pick<StorageRow, 'key' | 'label' | 'expandable'>;
  const hour = (b: string) => {
    const ms = Number(b) * 1000;
    return { key: b, label: `${dayOf(ms, tz)} ${hourOf(ms, tz)}:00` };
  };
  if (table === 'flows' && day) {
    partition = key;
    sql = 'SELECT toString(toUnixTimestamp(toStartOfHour(ts))) AS b, count() AS n FROM {t:Identifier} WHERE toDate(ts) = {day:Date} GROUP BY b';
    params = { day: key };
    toRow = hour;
  } else if (table === 'flows_1m' && month) {
    partition = key;
    sql = 'SELECT toString(toDate(minute)) AS b, count() AS n FROM {t:Identifier} WHERE toYYYYMM(minute) = {m:UInt32} GROUP BY b';
    params = { m: Number(key) };
    toRow = (d) => ({ key: d, label: d, expandable: true });
  } else if (table === 'flows_1m' && day) {
    partition = key.slice(0, 4) + key.slice(5, 7);
    sql = 'SELECT toString(toUnixTimestamp(toStartOfHour(minute))) AS b, count() AS n FROM {t:Identifier} WHERE toDate(minute) = {day:Date} GROUP BY b';
    params = { day: key };
    toRow = hour;
  } else {
    throw badRequest('table/key: flows with a day, or flows_1m with a month or day');
  }
  const [part] = (await partitions(ch, log, db, signal)).filter((p) => p.table === table && p.partition === partition);
  if (!part) return [];
  const rows = await chQuery<{ b: string; n: string }>(ch, log, sql, { ...params, t: table }, signal);
  const total = Number(part.rows) || 1;
  const disk = Number(part.disk);
  return rows
    .map((r) => ({
      ...toRow(r.b),
      bytes: Math.round((disk * Number(r.n)) / total),
      count: Number(r.n),
      deletable: false,
      estimated: true,
    }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}
