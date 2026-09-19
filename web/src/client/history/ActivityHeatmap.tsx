import { useMemo, useState } from 'react';
import type { HeatmapGrid, HeatmapMetric, HeatmapResponse, HeatmapSplit } from '../../shared/api.ts';
import { urls } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart } from '../charts/EChart.tsx';
import type { EChartsCoreOption } from '../charts/echarts.ts';
import { browserTz, fmtBytes, fmtRate, fmtTime } from '../charts/format.ts';
import { SEQUENTIAL, type Scheme } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { setSearchParams, useSearch } from '../router.ts';
import {
  cellLabel,
  coveredDays,
  DAYS,
  fromLog,
  heatData,
  heatWindow,
  HOURS,
  lastOccurrence,
  METRIC_PARAM,
  parseMetric,
  parseSplit,
  parseWeeks,
  samplesText,
  SPLIT_PARAM,
  WEEKS_PARAM,
  type HeatWeeks,
} from './heatmapCells.ts';
import { THROUGHPUT_PANEL_ID } from './ThroughputChart.tsx';

const METRIC_OPTIONS = [
  { value: 'total', label: 'total', title: 'Bytes sent + received' },
  { value: 'tx', label: 'sent', title: 'Bytes sent (tx)' },
  { value: 'rx', label: 'received', title: 'Bytes received (rx)' },
] as const;
const SPLIT_OPTIONS = [
  { value: 'none', label: 'all', title: 'One heatmap for all traffic' },
  { value: 'app', label: 'top 4 apps', title: 'One heatmap per top-4 app, each with its own scale' },
] as const;
const WEEKS_OPTIONS = [
  { value: '1', label: '1 wk' },
  { value: '4', label: '4 wk' },
  { value: '12', label: '12 wk' },
] as const;

const METRIC_NOUN: Record<HeatmapMetric, string> = { total: 'sent + received', tx: 'sent', rx: 'received' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Props = {
  filters: Partial<Record<'name' | 'app' | 'proto' | 'uid' | 'dest', string>>;
};

/**
 * 06: average traffic per hour of day (x) and weekday (y) over the last
 * weeks, in the browser's timezone; a log color scale. Its window is its own
 * (`heat_weeks`, whole weeks up to the current hour), not the page range.
 * Clicking a cell sets the page range to the latest occurrence of that hour
 * and scrolls to the throughput chart.
 * URL: `heat_metric=tx|rx`, `heat_split=app`, `heat_weeks=1|12`.
 */
export function ActivityHeatmap({ filters }: Props) {
  const search = new URLSearchParams(useSearch());
  const metric = parseMetric(search.get(METRIC_PARAM));
  const split = parseSplit(search.get(SPLIT_PARAM));
  const weeks = parseWeeks(search.get(WEEKS_PARAM));
  const [openedAt] = useState(() => Date.now());
  const win = useMemo(() => heatWindow(Number(weeks), openedAt), [weeks, openedAt]);
  const q = useQuery<HeatmapResponse>(urls.historyHeatmap(win, { tz: browserTz, metric, split, filters }));
  const scheme = useColorScheme();
  const d = q.data;

  const onEvents = useMemo(
    () => ({
      click: (p: { value?: [number, number, number, number] }) => {
        const cell = p.value?.[3];
        if (cell === undefined) return;
        const r = lastOccurrence(cell, Date.now(), browserTz);
        if (!r) return;
        setSearchParams({ from: r.from, to: r.to });
        // After the page re-renders with the new range.
        setTimeout(() => document.getElementById(THROUGHPUT_PANEL_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
      },
    }),
    [],
  );

  const days = d ? coveredDays(d.from, d.to, d.coveredFrom) : null;
  const notes: string[] = [];
  if (d && d.coveredFrom !== null && d.coveredFrom > d.from) notes.push(`data since ${fmtTime(d.coveredFrom)}`);
  if (days !== null && days > 0 && days < 7) notes.push('fewer than one full week: some cells are single samples, others have none');

  const filtered = Object.values(filters).some((v) => v !== undefined);
  const subtitle = (
    <>
      Average {METRIC_NOUN[metric]} rate per hour over the {weeks === '1' ? 'last week' : `last ${weeks} weeks`} (to {fmtTime(win.to)}, {browserTz}
      {filtered ? ', filtered' : ''}), log color scale · click a cell to show its latest occurrence in the throughput chart
    </>
  );

  const grids = d?.grids ?? [];

  return (
    <Panel
      title="Activity by hour and weekday"
      subtitle={subtitle}
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && !d.grids.length ? 'No traffic in this window.' : undefined}
      actions={
        <>
          <SegmentedControl<HeatmapMetric>
            label="Bytes"
            options={METRIC_OPTIONS}
            value={metric}
            onChange={(v) => setSearchParams({ [METRIC_PARAM]: v === 'total' ? null : v })}
          />
          <SegmentedControl<HeatmapSplit>
            label="Split"
            options={SPLIT_OPTIONS}
            value={split}
            onChange={(v) => setSearchParams({ [SPLIT_PARAM]: v === 'none' ? null : v })}
          />
          <SegmentedControl<HeatWeeks>
            label="Window"
            options={WEEKS_OPTIONS}
            value={weeks}
            onChange={(v) => setSearchParams({ [WEEKS_PARAM]: v === '4' ? null : v })}
          />
        </>
      }
    >
      {notes.length > 0 && <p className="ctl-note heatmap-note">{notes.join(' · ')}</p>}
      {d && (d.split === 'app' ? (
        <div className="heatmap-multiples">
          {grids.map((g) => (
            <figure className="heatmap-multiple" key={g.key ?? ''}>
              <figcaption>
                <span className="heatmap-key">{g.key}</span> <span className="muted">{fmtBytes(g.bytes)}</span>
              </figcaption>
              <HeatGrid grid={g} samples={d.samples} scheme={scheme} compact onEvents={onEvents} />
            </figure>
          ))}
        </div>
      ) : (
        grids[0] && <HeatGrid grid={grids[0]} samples={d.samples} scheme={scheme} onEvents={onEvents} />
      ))}
    </Panel>
  );
}

function HeatGrid({
  grid,
  samples,
  scheme,
  compact = false,
  onEvents,
}: {
  grid: HeatmapGrid;
  samples: number[];
  scheme: Scheme;
  compact?: boolean;
  onEvents: Record<string, (p: any) => void>;
}) {
  const option = useMemo<EChartsCoreOption>(() => {
    const muted = cssVar('--muted');
    const surface = cssVar('--surface');
    const text = cssVar('--text');
    const { data, max } = heatData(grid);
    const tip = (p: { value?: [number, number, number, number] }) => {
      const cell = p.value?.[3];
      if (cell === undefined) return '';
      const kbps = grid.kbps[cell] ?? 0;
      const n = samples[cell] ?? 0;
      const active = grid.active[cell] ?? 0;
      return (
        `<div class="tip"><div class="tip-head"><span>${esc(cellLabel(cell))}</span>${grid.key ? `<span class="tip-num muted">${esc(grid.key)}</span>` : ''}</div>` +
        `<div class="tip-row"><span class="tip-name">avg ${fmtRate(kbps)}</span><span class="tip-num muted">${samplesText(n)}</span></div>` +
        `<div class="tip-foot muted">traffic in ${active} of ${n} ${n === 1 ? 'hour' : 'hours'}</div>` +
        `<div class="tip-foot muted">click: show the latest ${esc(cellLabel(cell))}</div></div>`
      );
    };
    return {
      animation: false,
      grid: { left: 40, right: 12, top: 4, bottom: compact ? 52 : 60 },
      xAxis: {
        type: 'category',
        data: HOURS,
        splitArea: { show: false },
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { interval: compact ? 5 : 2 },
      },
      yAxis: { type: 'category', data: DAYS, inverse: true, axisTick: { show: false }, axisLine: { show: false } },
      tooltip: { trigger: 'item', confine: true, formatter: tip },
      visualMap: {
        type: 'continuous',
        dimension: 2,
        min: 0,
        max,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 10,
        itemHeight: compact ? 140 : 220,
        text: [fmtRate(fromLog(max)), '0'],
        // The hover indicator shows the value back in kbps, not its log.
        formatter: (v: number) => fmtRate(fromLog(v)),
        textGap: 8,
        textStyle: { color: muted, fontSize: 16 },
        inRange: { color: [...SEQUENTIAL[scheme]] },
      },
      series: [
        {
          id: 'heat',
          type: 'heatmap',
          data,
          cursor: 'pointer',
          // A surface gap between cells.
          itemStyle: { borderColor: surface, borderWidth: 2, borderRadius: 2 },
          emphasis: { itemStyle: { borderColor: text, borderWidth: 1 } },
        },
      ],
    };
  }, [grid, samples, scheme, compact]);

  const busiest = grid.kbps.reduce<number>((a, v, i) => (v !== null && v > (grid.kbps[a] ?? -1) ? i : a), 0);
  return (
    <EChart
      option={option}
      onEvents={onEvents}
      height={compact ? 230 : 300}
      ariaLabel={`Average rate per hour of day and weekday${grid.key ? ` for ${grid.key}` : ''}; busiest ${cellLabel(busiest)} at ${fmtRate(grid.kbps[busiest] ?? 0)}`}
    />
  );
}
