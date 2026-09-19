import { useState } from 'react';
import { urls, type ProcessInfo, type TimeRange } from '../api.ts';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { Panel } from '../components/Panel.tsx';
import { ProcessBytesPerCall } from '../history/BytesPerCall.tsx';
import { ProcessCallsPanel } from '../history/CallsPanel.tsx';
import { ProcessGantt } from '../history/ProcessGantt.tsx';
import { useQuery, type QueryState } from '../hooks/useQuery.ts';
import { ProcessBeacons } from '../process/BeaconStrip.tsx';
import { NewDestList } from '../process/NewDestList.tsx';
import { Link } from '../router.ts';

/** The window of the instance panels: the last 7 days before the page was opened. */
export const PROCESS_WINDOW_MS = 7 * 86_400_000;

/**
 * One process instance, identified by pid and start_ns (a u64, kept as a
 * string). Layout (plans/README): the header panel, then one wide panel per
 * section, in this order: 09 instances of the same name, 14 bytes vs calls,
 * 10 bytes per call, 15 beaconing, 17 new destinations, destination table.
 * Sections take the loaded `ProcessInfo` and render nothing until it arrives.
 */
export function ProcessPage({ pid, start }: { pid: string; start: string }) {
  const q = useQuery<ProcessInfo>(urls.process(pid, start));
  const p = q.data;
  const [openedAt] = useState(() => Date.now());
  const week: TimeRange = { from: openedAt - PROCESS_WINDOW_MS, to: openedAt };

  return (
    <>
      <div className="page-head">
        <h1>
          {p?.name ?? 'Process'} <span className="muted">pid {pid}</span>
        </h1>
        {p && <Link href={`/history?${new URLSearchParams({ 'filter.name': p.name })}`}>History of {p.name} →</Link>}
      </div>
      <p className="muted range-label">
        {p ? (p.ended_ms ? `ended ${fmtTime(p.ended_ms)}` : 'running (as of the last update)') : ' '}
      </p>
      <div className="panels">
        <ProcessHeader q={q} />
        {p && <ProcessSections p={p} week={week} />}
      </div>
    </>
  );
}

/** The panels under the header; later plans add theirs here, in the order above. */
function ProcessSections({ p, week }: { p: ProcessInfo; week: TimeRange }) {
  const id = `${p.pid}:${p.start_ns}`;
  return (
    <>
      {/* 09: every instance of this program over the last 7 days, this one outlined. */}
      <ProcessGantt
        range={week}
        name={p.name}
        highlight={id}
        fitToData
        title={`Instances of ${p.name}`}
        subtitle="Every instance of this program over the last 7 days, this one outlined; thin and hatched until its first network I/O, arrow: still running; color: lifetime bytes (log)"
      />
      {/* 14: this instance's bytes, calls and bytes per call over its traffic window. */}
      <ProcessCallsPanel p={p} />
      {/* 10: this instance's calls by bytes per call, from raw flows, the median marked. */}
      <ProcessBytesPerCall p={p} />
      {/* 15: a dot per active tick per destination, each row's periodicity, then the periodic-connections table. */}
      <ProcessBeacons p={p} />
      {/* 17: addresses this program contacted for the first time in the last 7 days; a row focuses the strip above. */}
      <NewDestList p={p} week={week} />
    </>
  );
}

function ProcessHeader({ q }: { q: QueryState<ProcessInfo> }) {
  const p = q.data;
  const end = p?.ended_ms ?? p?.last_seen_ms;
  return (
    <Panel title="Process" loading={q.loading} error={q.error} footnote={null} wide>
      {p && (
        <dl className="facts">
          <dt>Command</dt>
          <dd>
            <code className="cmdline">{p.cmdline || '(unavailable)'}</code>
          </dd>
          <dt>User id</dt>
          <dd>{p.uid}</dd>
          <dt>Started</dt>
          <dd>{fmtTime(p.start_ms)}</dd>
          <dt>Traffic seen</dt>
          <dd>
            {fmtTime(p.first_seen_ms)} – {fmtTime(p.last_seen_ms)}
          </dd>
          <dt>State</dt>
          <dd>{p.ended_ms ? `ended ${fmtTime(p.ended_ms)}` : 'running (as of last update)'}</dd>
          <dt>Lifetime</dt>
          <dd>{end ? fmtDuration(end - p.start_ms) : '—'}</dd>
          <dt>Total sent / received</dt>
          <dd>
            {fmtBytes(p.tx_total)} / {fmtBytes(p.rx_total)}
          </dd>
          <dt>Instance id</dt>
          <dd>
            <code>
              {p.pid}:{p.start_ns}
            </code>
          </dd>
        </dl>
      )}
    </Panel>
  );
}
