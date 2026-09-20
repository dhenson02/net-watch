import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { LifecycleResponse } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtBytes, fmtTime } from '../charts/format.ts';
import { GRID } from '../charts/mirroredStack.ts';
import { slotColor, type SlotAssigner } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { useQuery } from '../hooks/useQuery.ts';
import { navigate } from '../router.ts';
import { clusterMarkers, clusterTitle, lifecycleEvents, processPath, type EventKind, type MarkerCluster } from './clusterMarkers.ts';
import { useFollowZoom } from './useFollowZoom.ts';
import { fontPx } from '../charts/fonts.ts';

/** The markers' plot height (px), plus a little room above and below. */
const TRACK = 36;
const PAD = 4;
/** Processes listed in a cluster's tooltip. */
const TIP_ROWS = 8;
/** Id of the temporary line drawn across the throughput chart while a marker is hovered. */
const HOVER_ID = 'lifecycle:hover';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Props = {
  range: TimeRange;
  mode: 'starts' | 'all';
  /** Only these process names; undefined = the largest of any name; null = not known yet (wait). */
  names: readonly string[] | null | undefined;
  /** The page's uid filter. */
  uid?: string;
  /** The page's SlotAssigner: a start marker takes its process name's color. */
  slots: SlotAssigner;
  /** The throughput chart above, for the hover line. */
  main: RefObject<EChartsType | null>;
};

/**
 * 12: process start (first network I/O) and end markers on a thin track
 * under the throughput chart, on the same time axis (it follows the chart's
 * zoom). Markers closer than 4 px merge into
 * one with a count. Hovering one draws a line across the chart above;
 * clicking opens the process page (a cluster's largest process).
 */
export function LifecycleTrack({ range, mode, names, uid, slots, main }: Props) {
  const scheme = useColorScheme();
  const q = useQuery<LifecycleResponse>(names === null ? null : urls.historyLifecycle(range, { names: names ?? undefined, uid }));
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the throughput chart's zoom until it commits a new range.
  const track = useEChartRef();
  useFollowZoom(main, track);

  const d = q.data;
  const clusters = useMemo<Record<EventKind, MarkerCluster[]>>(() => {
    const plot = width - GRID.left - GRID.right;
    if (!d || plot <= 0) return { start: [], end: [] };
    const ev = lifecycleEvents(d.procs, range, mode);
    const msPerPx = (range.to - range.from) / plot;
    return { start: clusterMarkers(ev.start, msPerPx), end: clusterMarkers(ev.end, msPerPx) };
  }, [d, range.from, range.to, mode, width]);

  const colorOf = (c: MarkerCluster, muted: string) => {
    if (c.kind === 'end' || c.name === null) return muted;
    const slot = slots.slot(c.name);
    return slot >= 0 ? slotColor(slot, scheme) : muted;
  };

  const latest = useRef({ clusters, range });
  latest.current = { clusters, range };

  const option = useMemo<EChartsCoreOption>(() => {
    const muted = cssVar('--muted');
    const rows: EventKind[] = mode === 'all' ? ['end', 'start'] : ['start'];
    const timeStyle = range.to - range.from <= 6 * 3600_000 ? 'time' : 'datetime';
    const series = (kind: EventKind) => ({
      id: `lc:${kind}`,
      name: kind === 'start' ? 'starts' : 'ends',
      type: 'scatter',
      symbol: 'triangle',
      symbolRotate: kind === 'end' ? 180 : 0,
      cursor: 'pointer',
      animation: false,
      data: (mode === 'all' || kind === 'start' ? clusters[kind] : []).map((c) => {
        const n = c.items.length;
        return {
          value: [c.t, kind],
          symbolSize: n > 1 ? 12 : 9,
          itemStyle: { color: colorOf(c, muted), opacity: 0.9 },
          label: n > 1 ? { show: true, position: 'right', distance: 2, formatter: String(n), fontSize: fontPx(12), color: muted } : { show: false },
        };
      }),
      emphasis: { scale: 1.3 },
    });
    return {
      animation: false,
      grid: { left: GRID.left, right: GRID.right, top: PAD, height: TRACK },
      xAxis: {
        type: 'time',
        min: range.from,
        max: range.to,
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLine: { show: true, lineStyle: { color: muted, opacity: 0.35 } },
      },
      yAxis: {
        type: 'category',
        data: rows,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: fontPx(12), color: muted, formatter: (v: string) => (v === 'start' ? '▲ start' : '▼ end') },
      },
      // Driven by the chart above (see the effect); a new range resets it like the chart does.
      dataZoom: [{ type: 'inside', xAxisIndex: 0, disabled: true, start: 0, end: 100 }],
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { seriesId: string; dataIndex: number }) => {
          const kind: EventKind = p.seriesId === 'lc:end' ? 'end' : 'start';
          const c = latest.current.clusters[kind][p.dataIndex];
          return c ? tooltip(c, timeStyle, (name) => (kind === 'start' ? colorOf({ ...c, name }, muted) : muted)) : '';
        },
      },
      series: [series('start'), series('end')],
    };
    // colorOf reads slots and scheme; clusters covers the data.
  }, [clusters, mode, range.from, range.to, scheme, slots]);

  const onEvents = useMemo(() => {
    const at = (p: { seriesId?: string; dataIndex: number }) => {
      if (p.seriesId !== 'lc:start' && p.seriesId !== 'lc:end') return undefined;
      return latest.current.clusters[p.seriesId === 'lc:end' ? 'end' : 'start'][p.dataIndex];
    };
    const hoverLine = (c: MarkerCluster | undefined) => {
      const muted = cssVar('--muted');
      main.current?.setOption({
        series: [
          {
            id: HOVER_ID,
            type: 'line',
            data: [],
            silent: true,
            tooltip: { show: false },
            markLine: {
              silent: true,
              animation: false,
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: c ? colorOf(c, muted) : muted, type: 'dashed', width: 1.5 },
              data: c ? [{ xAxis: c.t }] : [],
            },
          },
        ],
      });
    };
    return {
      mouseover: (p: any) => {
        const c = at(p);
        if (c) hoverLine(c);
      },
      mouseout: () => hoverLine(undefined),
      click: (p: any) => {
        const c = at(p);
        if (c) navigate(processPath(c.items[0]!.proc.id));
      },
    };
    // colorOf's inputs (slots, scheme) only affect the line's color.
  }, [main, scheme, slots]);

  const shown = clusters.start.reduce((n, c) => n + c.items.length, 0) + clusters.end.reduce((n, c) => n + c.items.length, 0);
  const note = q.error
    ? `process events: ${q.error}`
    : d?.truncated
      ? `process events: the ${d.procs.length} largest processes${names ? ' of the chart' : ''}`
      : null;

  return (
    <div className="lifecycle-track" ref={wrap}>
      <EChart
        option={option}
        onEvents={onEvents}
        chartRef={track}
        height={TRACK + 2 * PAD}
        ariaLabel={`Process ${mode === 'all' ? 'start and end' : 'start'} markers: ${shown} events`}
      />
      {note && <p className="lifecycle-note muted">{note}</p>}
    </div>
  );
}

/** A marker's tooltip: time, "curl started talking" / "7 starts", then the processes, largest first. */
function tooltip(c: MarkerCluster, timeStyle: 'time' | 'datetime', color: (name: string) => string): string {
  const n = c.items.length;
  const first = fmtTime(Math.min(...c.items.map((e) => e.t)), timeStyle);
  const last = fmtTime(Math.max(...c.items.map((e) => e.t)), timeStyle);
  const head = `<div class="tip-time">${first === last ? first : `${first} – ${last}`}</div><div class="tip-head"><span>${esc(clusterTitle(c))}</span><span class="tip-num muted">lifetime</span></div>`;
  const rows = c.items
    .slice(0, TIP_ROWS)
    .map(
      ({ proc: p }) =>
        `<div class="tip-row"><span class="tip-swatch" style="background:${color(p.name)}"></span>` +
        `<span class="tip-name">${esc(p.name)} <span class="muted">pid ${p.pid}</span></span><span class="tip-num">${fmtBytes(p.bytes)}</span></div>` +
        (p.cmdline ? `<div class="tip-cmd muted">${esc(p.cmdline)}</div>` : ''),
    )
    .join('');
  const more = n > TIP_ROWS ? `<div class="muted">+${n - TIP_ROWS} more</div>` : '';
  const foot = `<div class="tip-foot muted">click: open ${n > 1 ? `the largest (${esc(c.items[0]!.proc.name)})` : 'the process page'}</div>`;
  return `<div class="tip">${head}${rows}${more}${foot}</div>`;
}
