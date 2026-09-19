import { urls, type HistorySummary } from '../api.ts';
import { DEST_PARAM, HistoryFlowSankey } from '../charts/FlowSankey.tsx';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { useSlots } from '../charts/useSlots.ts';
import { Panel } from '../components/Panel.tsx';
import { RangePicker } from '../components/RangePicker.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { useTimeRange } from '../hooks/useTimeRange.ts';
import { setSearchParams, useSearchParam } from '../router.ts';

export function HistoryPage() {
  const range = useTimeRange();
  const summary = useQuery<HistorySummary>(urls.historySummary(range));
  const s = summary.data;
  const slots = useSlots();
  const [destParam] = useSearchParam(DEST_PARAM, '');
  const dest = destParam || null;

  return (
    <>
      <div className="page-head">
        <h1>History</h1>
        <RangePicker range={range} />
      </div>
      <p className="muted range-label">
        {fmtTime(range.from)} – {fmtTime(range.to)} ({fmtDuration(range.to - range.from)})
      </p>
      {dest && (
        <p className="filter-bar">
          <span className="chip">
            destination <code>{dest}</code>
            <button type="button" className="chip-x" aria-label="Clear the destination filter" onClick={() => setSearchParams({ [DEST_PARAM]: null })}>
              ×
            </button>
          </span>
          <span className="muted">applies to the flow diagram</span>
        </p>
      )}
      <div className="panels">
        <Panel
          title="Totals"
          subtitle={s && `${s.range.table === 'flows' ? 'raw flows' : 'per-minute rollup'}, ${fmtDuration(s.range.step * 1000)} buckets`}
          loading={summary.loading}
          error={summary.error}
          wide
        >
          <div className="stats">
            <Stat label="Sent (tx)" value={s ? fmtBytes(s.txBytes) : '—'} />
            <Stat label="Received (rx)" value={s ? fmtBytes(s.rxBytes) : '—'} />
            <Stat label="Processes with traffic" value={s ? s.processes.toLocaleString() : '—'} />
          </div>
        </Panel>

        <HistoryFlowSankey range={range} dest={dest} slots={slots} />
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
