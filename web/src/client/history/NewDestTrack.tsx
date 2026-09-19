import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { NewDestsResponse } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtBytes, fmtTime } from '../charts/format.ts';
import { GRID } from '../charts/mirroredStack.ts';
import { slotColor, type SlotAssigner } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Toggle } from '../components/Toggle.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { navigate, setSearchParams } from '../router.ts';
import { processPath } from './clusterMarkers.ts';
import { clusterNewDests, clusterTitle, hiddenText, namesByCount, ND_PARAMS, type NewDestCluster, type NewDestOptions } from './newDests.ts';
import { colorSlots } from './scatterPoints.ts';
import { useFollowZoom } from './useFollowZoom.ts';

/** The markers' plot height (px), plus a little room above and below. */
const TRACK = 22;
const PAD = 4;
/** Destinations listed in a cluster's tooltip. */
const TIP_ROWS = 8;
/** Id of the temporary line drawn across the throughput chart while a marker is hovered. */
const HOVER_ID = 'newdest:hover';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Props = {
  range: TimeRange;
  /** Only this program (the page's process filter); undefined = every program. */
  name?: string;
  opts: NewDestOptions;
  /** The page's SlotAssigner: a marker takes its program's color when the chart shows it. */
  slots: SlotAssigner;
  /** The throughput chart above, for the zoom and the hover line. */
  main: RefObject<EChartsType | null>;
};

/**
 * 17: a ◆ where a program first contacted an address it had never used
 * before (anywhere in the retained history), on a thin track under the
 * throughput chart, on its time axis. Markers closer than 6 px merge into one
 * with a count. Hover draws a line across the chart; click opens the process
 * page of the instance that made the (largest) first contact.
 */
export function NewDestTrack({ range, name, opts, slots, main }: Props) {
  const scheme = useColorScheme();
  const q = useQuery<NewDestsResponse>(urls.historyNewDests(range, { names: name !== undefined ? [name] : undefined, ...opts }));
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const track = useEChartRef();
  useFollowZoom(main, track);

  const d = q.data;
  const clusters = useMemo<NewDestCluster[]>(() => {
    const plot = width - GRID.left - GRID.right;
    if (!d || plot <= 0) return [];
    return clusterNewDests(d.dests, range, (range.to - range.from) / plot);
  }, [d, range.from, range.to, width]);

  // Programs keep the throughput chart's slot when it shows them (stacked by process); the rest take free ones.
  const colors = useMemo(() => colorSlots(namesByCount(d?.dests ?? []), (n) => slots.slot(n)), [d, slots]);
  const colorOf = (n: string | null, muted: string) => {
    const slot = n === null ? undefined : colors.get(n);
    return slot === undefined ? muted : slotColor(slot, scheme);
  };

  const latest = useRef({ clusters });
  latest.current = { clusters };

  const option = useMemo<EChartsCoreOption>(() => {
    const muted = cssVar('--muted');
    const timeStyle = range.to - range.from <= 6 * 3600_000 ? 'time' : 'datetime';
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
        data: ['new'],
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { fontSize: 10, color: muted, formatter: () => '◆ new dest' },
      },
      dataZoom: [{ type: 'inside', xAxisIndex: 0, disabled: true, start: 0, end: 100 }],
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { dataIndex: number }) => {
          const c = latest.current.clusters[p.dataIndex];
          return c ? tooltip(c, timeStyle, (n) => colorOf(n, muted)) : '';
        },
      },
      series: [
        {
          id: 'newdest:markers',
          name: 'new destinations',
          type: 'scatter',
          symbol: 'diamond',
          cursor: 'pointer',
          animation: false,
          data: clusters.map((c) => {
            const n = c.items.length;
            return {
              value: [c.t, 'new'],
              symbolSize: n > 1 ? 13 : 10,
              itemStyle: { color: colorOf(c.name, muted), opacity: 0.9 },
              label: n > 1 ? { show: true, position: 'right', distance: 2, formatter: String(n), fontSize: 10, color: muted } : { show: false },
            };
          }),
          emphasis: { scale: 1.3 },
        },
      ],
    };
    // colorOf reads colors and scheme; clusters covers the data.
  }, [clusters, colors, range.from, range.to, scheme]);

  const onEvents = useMemo(() => {
    const at = (p: { seriesId?: string; dataIndex: number }) => (p.seriesId === 'newdest:markers' ? latest.current.clusters[p.dataIndex] : undefined);
    const hoverLine = (c: NewDestCluster | undefined) => {
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
              lineStyle: { color: c ? colorOf(c.name, muted) : muted, type: 'dashed', width: 1.5 },
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
        if (c) navigate(processPath(c.items[0]!.id));
      },
    };
    // colorOf's inputs only affect the line's color.
  }, [main, colors, scheme]);

  const shown = clusters.reduce((n, c) => n + c.items.length, 0);
  const notes = [
    q.error ? `new destinations: ${q.error}` : null,
    d?.truncated ? `the first ${d.dests.length} new destinations of the range` : null,
    d ? hiddenText(d) : null,
    d && !q.error && shown === 0 && !q.loading ? 'no new destinations in this range' : null,
  ].filter(Boolean);

  return (
    <div className="newdest-track" ref={wrap}>
      <EChart option={option} onEvents={onEvents} chartRef={track} height={TRACK + 2 * PAD} ariaLabel={`New destination markers: ${shown} destinations`} />
      <div className="newdest-foot">
        <span className="muted">{notes.join(' · ')}</span>
        <NewDestToggles opts={opts} />
      </div>
    </div>
  );
}

/** The endpoint's options as URL toggles (shared by the History track and the Process page list). */
export function NewDestToggles({ opts }: { opts: NewDestOptions }) {
  const set = (k: keyof NewDestOptions) => (v: boolean) => setSearchParams({ [ND_PARAMS[k]]: v ? '1' : null }, { replace: true });
  return (
    <span className="newdest-toggles">
      <Toggle label="per port" checked={opts.ports} onChange={set('ports')} title="Key destinations by address and port: a known address on a new port counts as new" />
      <Toggle label="loopback" checked={opts.loopback} onChange={set('loopback')} title="Include 127.0.0.0/8 and ::1" />
      <Toggle
        label="first day"
        checked={opts.warmup}
        onChange={set('warmup')}
        title="Include destinations first seen within 24 h of the earliest data: right after install, everything is new"
      />
    </span>
  );
}

/** A marker's tooltip: time, "chrome → 1.2.3.4:443" / "7 new destinations", then the destinations, largest first hour first. */
function tooltip(c: NewDestCluster, timeStyle: 'time' | 'datetime', color: (name: string) => string): string {
  const n = c.items.length;
  const first = fmtTime(Math.min(...c.items.map((d) => d.firstMs)), timeStyle);
  const last = fmtTime(Math.max(...c.items.map((d) => d.firstMs)), timeStyle);
  const head =
    `<div class="tip-time">${first === last ? first : `${first} – ${last}`}</div>` +
    `<div class="tip-head"><span>${esc(clusterTitle(c))}</span><span class="tip-num muted">first hour</span></div>`;
  const rows = c.items
    .slice(0, TIP_ROWS)
    .map(
      (d) =>
        `<div class="tip-row"><span class="tip-swatch" style="background:${color(d.name)}"></span>` +
        `<span class="tip-name">${esc(d.name)} <span class="muted">${esc(d.dest)} ${esc(d.app)}</span></span><span class="tip-num">${fmtBytes(d.firstHourBytes)}</span></div>`,
    )
    .join('');
  const more = n > TIP_ROWS ? `<div class="muted">+${n - TIP_ROWS} more</div>` : '';
  const top = c.items[0]!;
  const foot = `<div class="tip-foot muted">click: open ${esc(top.name)} pid ${top.pid}${n > 1 ? ' (the largest)' : ''}, which made the first contact</div>`;
  return `<div class="tip">${head}${rows}${more}${foot}</div>`;
}
