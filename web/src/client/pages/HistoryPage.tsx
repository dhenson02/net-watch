import { urls, type HistorySummary } from '../api.ts';
import { HistoryFlowSankey } from '../charts/FlowSankey.tsx';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { useSlots } from '../charts/useSlots.ts';
import { Panel } from '../components/Panel.tsx';
import { RangePicker } from '../components/RangePicker.tsx';
import { useEChartRef } from '../charts/EChart.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { parseEventsMode, type EventsMode } from '../history/clusterMarkers.ts';
import { ActivityHeatmap } from '../history/ActivityHeatmap.tsx';
import { LifecycleTrack } from '../history/LifecycleTrack.tsx';
import { ThroughputChart } from '../history/ThroughputChart.tsx';
import { TxRxScatter } from '../history/TxRxScatter.tsx';
import { UnknownShareTrack } from '../history/UnknownShareTrack.tsx';
import { parseUnknownParam } from '../history/unknownShare.ts';
import { BY_VALUES, filterParam } from '../history/throughputSeries.ts';
import { useThroughputParams } from '../history/useThroughput.ts';
import { useQuery } from '../hooks/useQuery.ts';
import { useTimeRange } from '../hooks/useTimeRange.ts';
import { setSearchParams, useSearch } from '../router.ts';

const FILTER_NOUN = { app: 'app', name: 'process', proto: 'proto', uid: 'uid', dest: 'destination' } as const;

const EVENTS_OPTIONS = [
  { value: 'off', label: 'off' },
  { value: 'starts', label: 'starts', title: 'Mark when processes started talking (first network I/O)' },
  { value: 'all', label: 'starts+ends', title: 'Mark process starts (first network I/O) and ends' },
] as const;

const UNKNOWN_OPTIONS = [
  { value: 'off', label: 'off' },
  { value: 'on', label: 'on', title: 'A track under the chart: the share of bytes whose protocol the collector could not label' },
] as const;

export function HistoryPage() {
  const range = useTimeRange();
  const { by, filters } = useThroughputParams();
  const search = useSearch();
  const events = parseEventsMode(new URLSearchParams(search).get('events'));
  const unknown = parseUnknownParam(search);
  const throughputChart = useEChartRef();
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
          <span className="muted">applies to the totals, the throughput chart, the activity heatmap, the sent/received scatter and the flow diagram</span>
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

        <ThroughputChart
          range={range}
          slots={slots}
          chartRef={throughputChart}
          unknown={unknown}
          actions={
            <>
              <SegmentedControl<EventsMode>
                label="Process events"
                options={EVENTS_OPTIONS}
                value={events}
                onChange={(v) => setSearchParams({ events: v === 'off' ? null : v })}
              />
              <span className="ctl-group">
                <span className="ctl-label">unknown share</span>
                <SegmentedControl<'off' | 'on'>
                  label="Share of bytes with an unknown protocol"
                  options={UNKNOWN_OPTIONS}
                  value={unknown ? 'on' : 'off'}
                  onChange={(v) => setSearchParams({ unknown: v === 'on' ? '1' : null })}
                />
              </span>
            </>
          }
          below={({ topKeys, answer }) => (
            <>
              {events !== 'off' && (
                <LifecycleTrack
                  range={range}
                  mode={events}
                  // A process filter, else the chart's processes when stacked by name, else the largest of any name.
                  names={filters.name !== undefined ? [filters.name] : by === 'name' ? topKeys : undefined}
                  uid={filters.uid}
                  slots={slots}
                  main={throughputChart}
                />
              )}
              {unknown && <UnknownShareTrack range={range} answer={answer} main={throughputChart} />}
            </>
          )}
        />

        <ActivityHeatmap filters={filters} />

        <TxRxScatter range={range} filters={filters} slots={slots} />

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
