import { useState } from 'react';
import type { StorageDeleteRequest, StorageDeleteResponse, StorageResponse, StorageRow, StorageTable } from '../../shared/api.ts';
import { postJson, urls } from '../api.ts';
import { browserTz, fmtBytes } from '../charts/format.ts';
import { Panel } from '../components/Panel.tsx';
import { StatTile } from '../components/StatTile.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { DeleteDialog } from '../storage/DeleteDialog.tsx';
import { StorageTable as StorageRows } from '../storage/StorageTable.tsx';

interface Pending {
  req: Omit<StorageDeleteRequest, 'password'>;
  title: string;
  rows: StorageRow[];
  note: string;
}

const REDIS_NOTE = 'Their process records and destination totals are removed from Redis. History in ClickHouse is not affected.';

const clickhouseNote = (table: string) =>
  table === 'flows_1m'
    ? 'flows_1m is the long-term rollup that older History views read; once dropped, that history cannot be rebuilt.'
    : 'The per-second detail for these days is dropped; the History page shows nothing for them afterwards.';

const sum = (rows: StorageRow[]) => rows.reduce((s, r) => s + r.bytes, 0);

/**
 * How much disk (ClickHouse) and memory (Redis) net-watch's data takes, per
 * day or month, and deleting it. Every delete asks for the server's
 * STORAGE_ADMIN_PASSWORD.
 */
export function StoragePage() {
  const q = useQuery<StorageResponse>(urls.storage(browserTz));
  const d = q.data;
  const [selected, setSelected] = useState<Record<string, ReadonlySet<string>>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const sel = (id: string) => selected[id] ?? new Set<string>();
  const toggle = (id: string, key: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s[id]);
      if (on) next.add(key);
      else next.delete(key);
      return { ...s, [id]: next };
    });
  const toggleAll = (id: string, rows: StorageRow[], on: boolean) =>
    setSelected((s) => ({ ...s, [id]: new Set(on ? rows.filter((r) => r.deletable).map((r) => r.key) : []) }));

  const ask = (rows: StorageRow[], keys: string[], req: Pending['req'], what: string, note: string) => {
    const chosen = rows.filter((r) => keys.includes(r.key));
    setPending({
      req: { ...req, keys },
      title: `Delete ${chosen.length === 1 ? chosen[0]!.label : `${chosen.length} ${what}`}?`,
      rows: chosen,
      note,
    });
  };

  const confirm = async (password: string) => {
    const p = pending!;
    const res = await postJson<StorageDeleteResponse>('/api/storage/delete', { ...p.req, password, tz: browserTz });
    setPending(null);
    setSelected({});
    setDone(
      `Deleted ${res.deleted.toLocaleString()} ${p.req.store === 'redis' ? 'processes' : 'partitions'}.` +
        (res.aofRewrite ? ' Redis is rewriting its append-only file; the disk space comes back when that finishes.' : ''),
    );
    q.reload();
  };

  const askCh = (t: StorageTable, keys: string[]) =>
    ask(t.rows, keys, { store: 'clickhouse', table: t.table, keys: [] }, t.by === 'day' ? 'days' : 'months', clickhouseNote(t.table));
  const askRedis = (rows: StorageRow[], keys: string[]) => ask(rows, keys, { store: 'redis', keys: [] }, 'days', REDIS_NOTE);

  const redis = d?.redis;
  const ch = d?.clickhouse;
  const canDelete = !!d?.deleteEnabled;

  return (
    <>
      <div className="page-head">
        <h1>Storage</h1>
        <button type="button" className="btn" onClick={q.reload} disabled={q.loading}>
          Refresh
        </button>
      </div>
      <p className="muted range-label">
        What net-watch's data takes up. Times are in your timezone ({browserTz}), except ClickHouse's day and month rows: those are partitions, cut in {d?.clickhouseTimezone ?? '…'}. Redis holds the realtime state; ClickHouse holds the history.
      </p>
      <p className="muted range-label" role="note">
        Known bug, to be fixed later: rows by date are still shown in UTC, not your timezone.
      </p>
      {q.error && (
        <p className="delete-error" role="alert">
          {q.error}
        </p>
      )}
      {d && !d.deleteEnabled && (
        <section className="panel geo-notice" role="note">
          <p>
            <b>Deleting is off.</b> Set <code>STORAGE_ADMIN_PASSWORD</code> in the dashboard server's environment (web/.env) and restart it to enable it.
          </p>
        </section>
      )}
      {done && (
        <p className="storage-done" role="status">
          {done}
        </p>
      )}

      <div className="panels storage-panels">
        <Panel
          title="ClickHouse"
          subtitle="On-disk size after compression, from system.parts. flows keeps 90 days and flows_1m 2 years; older data expires on its own. Open a row (▸) for its hours; ClickHouse only sizes whole partitions, so hourly sizes (≈) are the partition's size shared out by row count. Deleting drops whole partitions, and ClickHouse frees the files within a few minutes."
          footnote={null}
          wide
          loading={q.loading && !d}
          error={d?.clickhouseError ? `ClickHouse: ${d.clickhouseError}` : null}
        >
          {ch && (
            <>
              <div className="storage-tiles">
                <StatTile label="ClickHouse on disk" value={fmtBytes(ch.bytes)} />
                {ch.tables.map((t) => (
                  <StatTile key={t.table} label={t.table} value={fmtBytes(t.bytes)} subtitle={`${t.count.toLocaleString()} rows`} />
                ))}
              </div>
              {ch.tables.map((t) => {
                const id = `ch:${t.table}`;
                const chosen = sel(id);
                return (
                  <div key={t.table} className="storage-section">
                    <div className="storage-section-head">
                      <h3>
                        {t.table} <span className="muted">by {t.by}{t.by === 'not partitioned' ? '' : ` (${d?.clickhouseTimezone ?? ''})`}</span>
                      </h3>
                    </div>
                    {t.rows.length === 0 ? (
                      <p className="muted">No data.</p>
                    ) : (
                      <StorageRows
                        rows={t.rows}
                        labelHeader={t.by === 'day' ? 'Day' : t.by === 'month' ? 'Month' : 'Partition'}
                        countLabel="Rows"
                        breakdownUrl={(key) => urls.storageBreakdown(t.table, key, browserTz)}
                        selected={chosen}
                        onSelect={(k, on) => toggle(id, k, on)}
                        onSelectAll={(on) => toggleAll(id, t.rows, on)}
                        disabled={!canDelete}
                        onDelete={(keys) => askCh(t, keys)}
                        side={
                          t.deletable && (
                            <button
                              type="button"
                              className="btn btn-danger-outline"
                              disabled={!canDelete || chosen.size === 0}
                              onClick={() => askCh(t, [...chosen])}
                            >
                              Delete selected{chosen.size > 0 ? ` (${chosen.size})` : ''}
                            </button>
                          )
                        }
                      />
                    )}
                  </div>
                );
              })}
            </>
          )}
        </Panel>

        <Panel
          title="Redis"
          subtitle="Redis keeps everything in memory and logs writes to an append-only file (AOF). The AOF is the disk cost, and it cannot be split by day; the per-day figures are memory used (MEMORY USAGE) by processes that ended that day (open a row for its hours). Live processes, the stream and the snapshot are rewritten by the collector and cannot be deleted here."
          footnote={null}
          wide
          loading={q.loading && !d}
          error={d?.redisError ? `Redis: ${d.redisError}` : null}
        >
          {redis && (
            <>
              <div className="storage-tiles">
                <StatTile label="Redis AOF on disk" value={redis.aofBytes === null ? 'off' : fmtBytes(redis.aofBytes)} subtitle={redis.aofBytes === null ? 'append-only file is disabled' : 'whole file, not split by day'} />
                <StatTile
                  label="Redis memory"
                  value={fmtBytes(redis.usedMemory)}
                  subtitle={redis.maxMemory ? `limit ${fmtBytes(redis.maxMemory)}` : 'no limit'}
                />
                <StatTile label="Keys" value={redis.keys.toLocaleString()} />
              </div>

              <div className="storage-section">
                <div className="storage-section-head">
                  <h3>
                    Ended processes <span className="muted">by day they ended</span>
                  </h3>
                </div>
                {redis.days.length === 0 ? (
                  <p className="muted">No ended processes are kept.</p>
                ) : (
                  <StorageRows
                    rows={redis.days}
                    labelHeader="Day"
                    countLabel="Processes"
                    selected={sel('redis')}
                    onSelect={(k, on) => toggle('redis', k, on)}
                    onSelectAll={(on) => toggleAll('redis', redis.days, on)}
                    disabled={!canDelete}
                    onDelete={(keys) => askRedis(redis.days, keys)}
                    side={
                      <button
                        type="button"
                        className="btn btn-danger-outline"
                        disabled={!canDelete || sel('redis').size === 0}
                        onClick={() => askRedis(redis.days, [...sel('redis')])}
                      >
                        Delete selected{sel('redis').size > 0 ? ` (${sel('redis').size})` : ''}
                      </button>
                    }
                  />
                )}
              </div>

              <div className="storage-section">
                <h3>Everything else in memory</h3>
                <StorageRows
                  rows={redis.fixed}
                  labelHeader="Kind"
                  countLabel="Items"
                  selected={new Set()}
                  onSelect={() => {}}
                  onSelectAll={() => {}}
                  onDelete={() => {}}
                  disabled
                />
              </div>
            </>
          )}
        </Panel>
      </div>

      {pending && (
        <DeleteDialog title={pending.title} onConfirm={confirm} onClose={() => setPending(null)}>
          <p>
            {pending.req.store === 'redis' ? 'Redis' : `ClickHouse table ${pending.req.table}`}: <b>{fmtBytes(sum(pending.rows))}</b>
            {pending.req.store === 'redis' ? ' of memory' : ' on disk'}
            {' '}in {pending.rows.length === 1 ? '' : `${pending.rows.length} entries: `}
          </p>
          <ul className="delete-list">
            {pending.rows.slice(0, 8).map((r) => (
              <li key={r.key}>
                {r.label} <span className="muted">{fmtBytes(r.bytes)}</span>
              </li>
            ))}
            {pending.rows.length > 8 && <li className="muted">and {pending.rows.length - 8} more</li>}
          </ul>
          <p>{pending.note}</p>
        </DeleteDialog>
      )}
    </>
  );
}
