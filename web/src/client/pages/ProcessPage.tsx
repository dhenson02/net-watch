import { urls, type ProcessInfo } from '../api.ts';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { Panel } from '../components/Panel.tsx';
import { useQuery } from '../hooks/useQuery.ts';

/** One process instance, identified by pid and start_ns (a u64, kept as a string). */
export function ProcessPage({ pid, start }: { pid: string; start: string }) {
  const q = useQuery<ProcessInfo>(urls.process(pid, start));
  const p = q.data;
  const end = p?.ended_ms ?? p?.last_seen_ms;

  return (
    <>
      <h1>
        {p?.name ?? 'Process'} <span className="muted">pid {pid}</span>
      </h1>
      <div className="panels">
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
      </div>
    </>
  );
}
