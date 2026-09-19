import { fmtDuration, fmtTime } from '../charts/format.ts';
import { LiveFlowSankey } from '../charts/FlowSankey.tsx';
import { useSlots } from '../charts/useSlots.ts';
import { Panel } from '../components/Panel.tsx';
import { useLive, type LiveStatus } from '../hooks/useLive.ts';
import { useNow } from '../hooks/useNow.ts';
import { HealthStrip } from '../live/HealthStrip.tsx';
import { LiveThroughput } from '../live/LiveThroughput.tsx';
import { TopTalkers } from '../live/TopTalkers.tsx';

const STATUS_TEXT: Record<LiveStatus, string> = { connecting: 'connecting…', live: 'connected', reconnecting: 'reconnecting…' };

export function LivePage() {
  const live = useLive(3600);
  const now = useNow(1000);
  const slots = useSlots();

  const last = live.ticks.at(-1);
  const age = live.latestTs === null ? null : now - live.latestTs;
  const stale = age !== null && last !== undefined && age > 3 * last.intervalMs;

  return (
    <>
      <h1>Live</h1>
      <HealthStrip />
      <div className="panels">
        <LiveThroughput slots={slots} />

        <Panel title="Feed" footnote={null}>
          <dl className="facts">
            <dt>Stream</dt>
            <dd>
              <span className={`dot dot-${live.status === 'live' ? (stale ? 'warn' : 'ok') : 'idle'}`} aria-hidden="true" />
              {STATUS_TEXT[live.status]}
            </dd>
            <dt>Last tick</dt>
            <dd>{last ? `${fmtTime(last.ts, 'time')} (${age! < 2000 ? 'just now' : `${fmtDuration(age!)} ago`})` : '—'}</dd>
            <dt>Buffered</dt>
            <dd>{live.ticks.length} ticks</dd>
            <dt>Processes / flows</dt>
            <dd>{last ? `${last.nProcs} / ${last.nFlows}` : '—'}</dd>
            <dt>Dropped events</dt>
            <dd>{last ? last.drops.toLocaleString() : '—'}</dd>
          </dl>
          {stale && <p className="note">No new ticks for {fmtDuration(age!)}. The collector may be stopped.</p>}
        </Panel>

        <TopTalkers />

        <LiveFlowSankey slots={slots} />
      </div>
    </>
  );
}
