import { useMemo } from 'react';
import type { NewDestsResponse } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { ChartLegend, type LegendItem } from '../charts/ChartLegend.tsx';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption } from '../charts/echarts.ts';
import { fmtTime } from '../charts/format.ts';
import { tipRow } from '../charts/mirroredStack.ts';
import { OTHER, slotColor, type SlotAssigner } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { ChartLayout } from '../components/ChartLayout.tsx';
import { Panel } from '../components/Panel.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { setSearchParams } from '../router.ts';
import { dailyCounts, hiddenText, namesByCount, ND_TRACK_PARAM, nextDay, OTHER_NAME, type NewDestOptions } from './newDests.ts';
import { NewDestToggles } from './NewDestTrack.tsx';
import { colorSlots } from './scatterPoints.ts';
import { THROUGHPUT_PANEL_ID } from './ThroughputChart.tsx';

/** The chart's window: at least this many days up to the page's `to`. */
const MIN_DAYS = 30;
const DAY_MS = 86_400_000;
const LIMIT = 2000;
const TOP = 8;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

type Props = {
  range: TimeRange;
  /** The page's process filter. */
  name?: string;
  opts: NewDestOptions;
  slots: SlotAssigner;
};

/**
 * 17: new destinations per day (the browser's days), stacked by program, over
 * the page range or the last 30 days up to its end, whichever is longer. A
 * spike after an update is normal; one without an update is not. Clicking a
 * day sets the page range to it and shows the marker track.
 */
export function NewDestDaily({ range, name, opts, slots }: Props) {
  const win = useMemo<TimeRange>(() => ({ from: Math.min(range.from, range.to - MIN_DAYS * DAY_MS), to: range.to }), [range.from, range.to]);
  const q = useQuery<NewDestsResponse>(urls.historyNewDests(win, { names: name !== undefined ? [name] : undefined, ...opts, limit: LIMIT }));
  const scheme = useColorScheme();
  const d = q.data;
  const counts = useMemo(() => (d ? dailyCounts(d.dests, win, TOP) : null), [d, win]);
  const colors = useMemo(() => colorSlots(namesByCount(d?.dests ?? []).slice(0, TOP), (n) => slots.slot(n)), [d, slots]);

  const option = useMemo<EChartsCoreOption>(() => {
    const muted = cssVar('--muted');
    const axis = cssVar('--chart-axis');
    const grid = cssVar('--chart-grid');
    const colorOf = (n: string) => (n === OTHER_NAME ? OTHER[scheme] : slotColor(colors.get(n) ?? -1, scheme));
    const series = counts?.series ?? [];
    const label = (n: string) => (n === OTHER_NAME ? 'other' : n);
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 12, bottom: 28 },
      legend: { show: false, data: series.map((s) => label(s.name)) },
      xAxis: {
        type: 'category',
        data: counts?.days ?? [],
        axisLine: { lineStyle: { color: axis } },
        axisLabel: { color: muted, formatter: (v: string) => new Date(Number(v)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) },
      },
      yAxis: { type: 'value', minInterval: 1, splitLine: { lineStyle: { color: grid } }, axisLabel: { color: muted } },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        confine: true,
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0]?.dataIndex;
          if (i === undefined || !counts) return '';
          const rows = series.filter((s) => s.counts[i]! > 0).sort((a, b) => b.counts[i]! - a.counts[i]!);
          const total = rows.reduce((n, s) => n + s.counts[i]!, 0);
          return (
            `<div class="tip"><div class="tip-time">${esc(fmtDay(counts.days[i]!))}</div>` +
            `<div class="tip-head"><span>${total} new destination${total === 1 ? '' : 's'}</span></div>` +
            rows.map((s) => tipRow(colorOf(s.name), esc(label(s.name)), String(s.counts[i]))).join('') +
            (total ? '<div class="tip-foot muted">click: show this day on the throughput chart</div>' : '') +
            '</div>'
          );
        },
      },
      series: series.map((s) => ({
        id: `newdest:day:${s.name}`,
        name: label(s.name),
        type: 'bar',
        stack: 'n',
        cursor: 'pointer',
        itemStyle: { color: colorOf(s.name) },
        data: s.counts,
      })),
    };
  }, [counts, colors, scheme]);

  const chart = useEChartRef();
  const legendItems = useMemo<LegendItem[]>(
    () => (counts?.series ?? []).map((s) => ({ name: s.name === OTHER_NAME ? 'other' : s.name, color: s.name === OTHER_NAME ? OTHER[scheme] : slotColor(colors.get(s.name) ?? -1, scheme) })),
    [counts, colors, scheme],
  );

  const onEvents = useMemo(
    () => ({
      click: (p: { dataIndex?: number }) => {
        const day = p.dataIndex === undefined ? undefined : counts?.days[p.dataIndex];
        if (day === undefined) return;
        setSearchParams({ from: day, to: Math.min(nextDay(day), Date.now()), [ND_TRACK_PARAM]: '1' });
        document.getElementById(THROUGHPUT_PANEL_ID)?.scrollIntoView({ behavior: 'smooth' });
      },
    }),
    [counts],
  );

  const total = d?.dests.length ?? 0;
  const foot = d
    ? [
        `${fmtTime(win.from)} – ${fmtTime(win.to)}`,
        d.truncated ? `the first ${total} new destinations` : `${total} new destination${total === 1 ? '' : 's'}`,
        hiddenText(d),
        'keyed by program name, so a restart does not make old destinations new',
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <Panel
      title="New destinations per day"
      subtitle={`First contacts of a program with an address it never used before, per day, stacked by program${name ? ` (${name} only)` : ''}. A spike after an update is normal; one without an update is not. Click a day to see it on the throughput chart`}
      footnote={foot}
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && total === 0 ? `No new destinations in this window.${hiddenText(d) ? ` ${hiddenText(d)}.` : ''}` : undefined}
      wide
    >
      {total > 0 && (
        <ChartLayout
          side={
            <>
              <NewDestToggles opts={opts} />
              <ChartLegend chart={chart} items={legendItems} title="Programs" />
            </>
          }
        >
          <EChart option={option} onEvents={onEvents} chartRef={chart} height={220} ariaLabel={`New destinations per day: ${total} in all`} />
        </ChartLayout>
      )}
    </Panel>
  );
}
