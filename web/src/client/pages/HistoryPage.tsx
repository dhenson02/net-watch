import { urls, type HistorySummary } from '../api.ts';
import { HistoryFlowSankey } from '../charts/FlowSankey.tsx';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { useSlots } from '../charts/useSlots.ts';
import { Panel } from '../components/Panel.tsx';
import { RangePicker } from '../components/RangePicker.tsx';
import { ThroughputChart } from '../history/ThroughputChart.tsx';
import { BY_VALUES, filterParam } from '../history/throughputSeries.ts';
import { useThroughputParams } from '../history/useThroughput.ts';
import { useQuery } from '../hooks/useQuery.ts';
import { useTimeRange } from '../hooks/useTimeRange.ts';
import { setSearchParams } from '../router.ts';

const FILTER_NOUN = { app: 'app', name: 'process', proto: 'proto', uid: 'uid', dest: 'destination' } as const;

export function HistoryPage() {
  const range = useTimeRange();
  const { filters } = useThroughputParams();
  const summary = useQuery<HistorySummary>(urls.historySummary(range, filters));
  const s = summary.data;
  const slots = useSlots();
  const active = BY_VALUES.filter((d) => filters[d] !== undefined);

  return (
    <>
      <div className="page-head">
        <h1>History</h1>
        <RangePicker range={range} />
      </div>
      <p className="muted range-label">
        {fmtTime(range.from)} – {fmtTime(range.to)} ({fmtDuration(range.to - range.from)})
      </p>
      {active.length > 0 && (
        <p className="filter-bar">
          {active.map((d) => (
            <span className="chip" key={d}>
              {FILTER_NOUN[d]} <code>{filters[d]}</code>
              <button
                type="button"
                className="chip-x"
                aria-label={`Clear the ${FILTER_NOUN[d]} filter`}
                onClick={() => setSearchParams({ [filterParam(d)]: null })}
              >
                ×
              </button>
            </span>
          ))}
          {active.length > 1 && (
            <button type="button" className="chip-clear" onClick={() => setSearchParams(Object.fromEntries(active.map((d) => [filterParam(d), null])))}>
              clear all
            </button>
          )}
          <span className="muted">applies to the totals, the throughput chart and the flow diagram</span>
        </p>
      )}
      <div className="panels">
        <Panel
          title="Totals"
          subtitle={s && `${s.range.table === 'flows' ? 'raw flows' : 'per-minute rollup'}${active.length ? ', filtered' : ''}`}
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

        <ThroughputChart range={range} slots={slots} />

        <HistoryFlowSankey range={range} filters={filters} slots={slots} />
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
