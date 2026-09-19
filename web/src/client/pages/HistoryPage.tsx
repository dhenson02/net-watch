import { urls, type HistorySummary } from '../api.ts';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { Panel } from '../components/Panel.tsx';
import { RangePicker } from '../components/RangePicker.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { useTimeRange } from '../hooks/useTimeRange.ts';

export function HistoryPage() {
  const range = useTimeRange();
  const summary = useQuery<HistorySummary>(urls.historySummary(range));
  const s = summary.data;

  return (
    <>
      <div className="page-head">
        <h1>History</h1>
        <RangePicker range={range} />
      </div>
      <p className="muted range-label">
        {fmtTime(range.from)} – {fmtTime(range.to)} ({fmtDuration(range.to - range.from)})
      </p>
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
