import { memo, useDeferredValue, useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { LiveProcessRow } from '../../shared/api.ts';
import { fmtBytes, fmtDuration, fmtRate } from '../charts/format.ts';
import { RX, TX } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Panel } from '../components/Panel.tsx';
import { TableLayout } from '../components/TableLayout.tsx';
import { Sparkline } from '../components/Sparkline.tsx';
import { Toggle } from '../components/Toggle.tsx';
import { useLive } from '../hooks/useLive.ts';
import { useNow } from '../hooks/useNow.ts';
import { Link, navigate, useSearchParam } from '../router.ts';
import {
  appendNames,
  buildSparks,
  DEFAULT_SORT,
  formatSort,
  isIdle,
  matchesFilter,
  MAX_ROWS,
  nextSort,
  parseSort,
  SPARK_MS,
  sortRows,
  userLabel,
  type Sort,
  type SortKey,
  type Spark,
} from './topTalkers.ts';
import { useSnapshot } from './useSnapshot.ts';

const processHref = (r: LiveProcessRow) => `/process/${r.pid}/${r.startNs}`;

/** Short "ago" text; the collector ticks every second, so under 2 s is "just now". */
const ago = (ms: number) => (ms < 2000 ? 'just now' : `${fmtDuration(ms)} ago`);

function SortButton({ sort, k, label, title, onSort }: { sort: Sort; k: SortKey; label: string; title?: string; onSort: (k: SortKey) => void }) {
  const active = sort.key === k;
  return (
    <button type="button" className={`th-sort${active ? ' active' : ''}`} title={title} onClick={() => onSort(k)}>
      {label}
      <span className="th-arrow" aria-hidden="true">
        {active ? (sort.desc ? '▾' : '▴') : ''}
      </span>
    </button>
  );
}

/** `aria-sort` for a header holding the sort buttons of `keys`. */
const ariaSort = (sort: Sort, ...keys: SortKey[]) => (keys.includes(sort.key) ? (sort.desc ? 'descending' : 'ascending') : undefined);

function RateCell({ kbps, max, color }: { kbps: number; max: number; color: string }) {
  return (
    <td className="tt-rate num">
      {kbps > 0 ? fmtRate(kbps) : <span className="muted">0</span>}
      <span className="tt-bar" aria-hidden="true">
        <span style={{ width: `${max > 0 ? (kbps / max) * 100 : 0}%`, background: color }} />
      </span>
    </td>
  );
}

function onRowClick(e: MouseEvent<HTMLTableRowElement>, r: LiveProcessRow) {
  // The name link handles its own clicks (including middle and ctrl/cmd clicks).
  if ((e.target as Element).closest('a, button, input')) return;
  // Selecting text (to copy a cmdline) is not a click on the row.
  if (getSelection()?.toString()) return;
  if (e.metaKey || e.ctrlKey) window.open(processHref(r), '_blank', 'noopener');
  else navigate(processHref(r));
}

/**
 * One table row. Memoized: `r` and `spark` keep their identity between
 * renders that did not change them, so flipping a filter only renders the
 * rows that appear.
 */
const ProcessRow = memo(function ProcessRow({ r, spark, max, scheme, serverNow }: { r: LiveProcessRow; spark: Spark | undefined; max: number; scheme: 'light' | 'dark'; serverNow: number | null }) {
  const ended = r.endedMs !== null;
  return (
    <tr className={ended ? 'tt-ended' : undefined} onClick={(e) => onRowClick(e, r)}>
      <td className="tt-status">
        <span className={`dot ${ended ? '' : 'dot-ok'}`} role="img" aria-label={ended ? 'ended' : 'live'} title={ended ? 'ended' : 'live'} />
      </td>
      <td className="tt-name">
        <Link href={processHref(r)} className="tt-proc">
          {r.name}
        </Link>
        <div className="tt-cmd" title={r.cmdline}>
          {r.cmdline || ' '}
        </div>
      </td>
      <td className="num tt-pid">
        {r.pid}
        <div className="muted" title={`uid ${r.uid}`}>
          {userLabel(r)}
        </div>
      </td>
      <RateCell kbps={r.txKbps} max={max} color={TX[scheme]} />
      <RateCell kbps={r.rxKbps} max={max} color={RX[scheme]} />
      <td className="tt-spark">{spark && spark.tx.length > 0 ? <Sparkline tx={spark.tx} rx={spark.rx} fmt={fmtRate} /> : null}</td>
      <td className="num tt-num">{r.nFlows}</td>
      <td className="num tt-num tt-totals">
        ↑ {fmtBytes(r.txTotal)}
        <div>↓ {fmtBytes(r.rxTotal)}</div>
      </td>
      <td className="num tt-num tt-age">
        {serverNow === null ? '—' : fmtDuration(Math.max(0, serverNow - r.startMs))}
        {ended && serverNow !== null && <div className="muted">ended {ago(Math.max(0, serverNow - r.endedMs!))}</div>}
      </td>
    </tr>
  );
});

/**
 * 02: live processes and those that ended in the last 60 s, with current
 * rates, a 60 s sparkline and lifetime totals. Rows come from the polled
 * snapshot; sparklines from the live ring buffer, so they cost no request.
 */
export function TopTalkers() {
  const snap = useSnapshot();
  const live = useLive(SPARK_MS / 1000);
  const now = useNow(1000);
  const scheme = useColorScheme();

  const [sortParam, setSortParam] = useSearchParam('sort', DEFAULT_SORT);
  const [filter, setFilter] = useSearchParam('q', '');
  const [idleParam, setIdleParam] = useSearchParam('idle', 'hide');
  const hideIdle = idleParam !== 'show';
  const [endedParam, setEndedParam] = useSearchParam('ended', 'show');
  const hideEnded = endedParam === 'hide';
  // The switch itself updates at once; the table re-filters in a lower-priority render.
  const deferredHideEnded = useDeferredValue(hideEnded);
  const deferredHideIdle = useDeferredValue(hideIdle);
  // Every process name seen this session. Append-only, so the list never
  // shifts under the cursor; names survive going idle or ending.
  const [names, setNames] = useState<readonly string[]>([]);
  // Names the user unchecked. Independent of `names`, so list growth cannot touch it.
  const [hiddenNames, setHiddenNames] = useState<ReadonlySet<string>>(new Set());
  const toggleName = (name: string, show: boolean) =>
    setHiddenNames((prev) => {
      const next = new Set(prev);
      if (show) next.delete(name);
      else next.add(name);
      return next;
    });
  const sort = parseSort(sortParam);
  const onSort = (k: SortKey) => setSortParam(formatSort(nextSort(sort, k)), { replace: true });

  const rows = snap.data?.processes;
  useEffect(() => {
    if (rows) setNames((prev) => appendNames(prev, rows));
  }, [rows]);
  const sparks = useMemo(() => buildSparks(live.ticks, (rows ?? []).map((r) => r.id)), [live.ticks, rows]);

  const view = useMemo(() => {
    const all = rows ?? [];
    const named = all.filter((r) => !hiddenNames.has(r.name));
    const matched = named.filter((r) => matchesFilter(r, filter));
    const current = deferredHideEnded ? matched.filter((r) => r.endedMs === null) : matched;
    const shown = deferredHideIdle ? current.filter((r) => !isIdle(r, sparks.get(r.id), live.latestTs)) : current;
    const sorted = sortRows(shown, sort, sparks);
    const visible = sorted.slice(0, MAX_ROWS);
    let max = 0;
    for (const r of visible) max = Math.max(max, r.txKbps, r.rxKbps);
    return {
      visible,
      overflow: sorted.length - visible.length,
      byName: all.length - named.length,
      filtered: named.length - matched.length,
      ended: matched.length - current.length,
      idle: current.length - shown.length,
      total: all.length,
      max,
    };
  }, [rows, filter, hiddenNames, deferredHideIdle, deferredHideEnded, sort.key, sort.desc, sparks, live.latestTs]);

  const serverNow = snap.serverNow(now);

  const hiddenParts = [view.byName > 0 && `${view.byName} by name`, view.filtered > 0 && `${view.filtered} not matching “${filter.trim()}”`, view.ended > 0 && `${view.ended} ended`, view.idle > 0 && `${view.idle} idle`].filter(Boolean);

  const emptyText = rows && view.visible.length === 0 ? (view.total ? 'No process matches.' : 'No processes in the latest tick.') : null;

  const filters = (
    <>
      <input
        type="search"
        className="tt-filter"
        placeholder="Filter name or cmdline"
        aria-label="Filter processes by name or command line"
        value={filter}
        onChange={(e) => setFilter(e.target.value, { replace: true })}
      />
      <Toggle
        label="hide ended"
        title="Hide processes that have ended"
        checked={hideEnded}
        onChange={(on) => setEndedParam(on ? 'hide' : 'show', { replace: true })}
      />
      <Toggle
        label="hide idle"
        title="Hide live processes with no traffic in the last 30 s"
        checked={hideIdle}
        onChange={(on) => setIdleParam(on ? 'hide' : 'show', { replace: true })}
      />
      {names.length > 0 && (
        <fieldset className="tt-names">
          <legend>
            Processes
            <button type="button" className="tt-names-all" onClick={() => setHiddenNames(new Set())} disabled={hiddenNames.size === 0}>
              show all
            </button>
          </legend>
          <ul>
            {names.map((n) => (
              <li key={n}>
                <label>
                  <input type="checkbox" checked={!hiddenNames.has(n)} onChange={(e) => toggleName(n, e.target.checked)} />
                  <span title={n}>{n}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </>
  );

  return (
    <Panel
      wide
      title="Top talkers"
      subtitle={
        rows
          ? `${view.visible.length + view.overflow} of ${view.total} processes${hiddenParts.length ? ` · hidden: ${hiddenParts.join(', ')}` : ''}`
          : 'Live processes and those that ended in the last 60 s'
      }
      loading={!snap.data && !snap.error}
      error={!snap.data ? snap.error : null}
    >
      {snap.data && snap.error && <p className="note tt-stale">Refresh failed ({snap.error}); showing the last good list.</p>}
      <TableLayout side={filters}>
        <div>
          <div className="table-scroll">
            <table className="tt">
              <thead>
                <tr>
                  <th className="tt-status">
                    <span className="sr-only">status</span>
                  </th>
                  <th aria-sort={ariaSort(sort, 'name')}>
                    <SortButton sort={sort} k="name" label="name" onSort={onSort} />
                  </th>
                  <th aria-sort={ariaSort(sort, 'pid', 'user')}>
                    <SortButton sort={sort} k="pid" label="pid" onSort={onSort} />
                    <span className="muted"> / </span>
                    <SortButton sort={sort} k="user" label="user" onSort={onSort} />
                  </th>
                  <th className="tt-num" aria-sort={ariaSort(sort, 'tx')}>
                    <SortButton sort={sort} k="tx" label="↑ tx" title="Current send rate" onSort={onSort} />
                  </th>
                  <th className="tt-num" aria-sort={ariaSort(sort, 'rx')}>
                    <SortButton sort={sort} k="rx" label="↓ rx" title="Current receive rate" onSort={onSort} />
                  </th>
                  <th aria-sort={ariaSort(sort, 'spark')}>
                    <SortButton sort={sort} k="spark" label="60 s" title="Last 60 s: tx above the line, rx below. Sorts by traffic over the window." onSort={onSort} />
                  </th>
                  <th className="tt-num" aria-sort={ariaSort(sort, 'flows')}>
                    <SortButton sort={sort} k="flows" label="flows" title="Flows in the latest tick" onSort={onSort} />
                  </th>
                  <th className="tt-num" aria-sort={ariaSort(sort, 'txTotal', 'rxTotal')}>
                    <SortButton sort={sort} k="txTotal" label="total ↑" title="Bytes sent over the process lifetime" onSort={onSort} />
                    <span className="muted"> / </span>
                    <SortButton sort={sort} k="rxTotal" label="↓" title="Bytes received over the process lifetime" onSort={onSort} />
                  </th>
                  <th className="tt-num" aria-sort={ariaSort(sort, 'age')}>
                    <SortButton sort={sort} k="age" label="age" onSort={onSort} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.visible.map((r) => (
                  <ProcessRow key={r.id} r={r} spark={sparks.get(r.id)} max={view.max} scheme={scheme} serverNow={serverNow} />
                ))}
              </tbody>
            </table>
            {emptyText && <div className="tt-empty">{emptyText}</div>}
          </div>
          {view.overflow > 0 && (
            <p className="note">
              {view.overflow} more {view.overflow === 1 ? 'row' : 'rows'} not shown (first {MAX_ROWS} only). Use the filter to narrow the list.
            </p>
          )}
        </div>
      </TableLayout>
    </Panel>
  );
}
