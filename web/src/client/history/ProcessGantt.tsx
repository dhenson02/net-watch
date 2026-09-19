import { useEffect, useMemo, useRef } from 'react';
import type { LifetimeBar, LifetimesResponse } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { SEQUENTIAL, type Scheme } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { navigate, useSearchParam } from '../router.ts';
import { processPath } from './clusterMarkers.ts';
import { barEnd, colorExtent, laneLabel, logBytes, packLanes, parseSort, SORT_PARAM, type GanttSort, type Lane, type Packed } from './packLanes.ts';

const SORT_OPTIONS = [
  { value: 'start', label: 'first start', title: 'Lanes in order of their first instance’s start' },
  { value: 'bytes', label: 'bytes', title: 'Lanes by total bytes, largest first' },
] as const;

const LANES_ID = 'gantt:lanes';
const BARS_ID = 'gantt:bars';
/** Pixels per row; rows past MAX_ROWS scroll (the y dataZoom). */
const ROW_PX = 20;
const MAX_ROWS = 28;
const MIN_ROWS = 4;
const GRID = { left: 164, top: 44, bottom: 58 };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Bar item value: [row, startMs, firstSeenMs, endMs, log10 bytes, bar index, running (1/0), highlighted (1/0)]. */
type BarValue = [number, number, number, number, number, number, number, number];

type Props = {
  range: TimeRange;
  /** Only instances of this process name (the Process page). */
  name?: string;
  uid?: string;
  /** `pid:start_ns` of the instance to outline (the Process page's own). */
  highlight?: string;
  title?: string;
  /** Replaces the default "how to read it" subtitle. */
  subtitle?: string;
  /** Open zoomed to the instances (from the earliest start) rather than the whole range; the slider still reaches all of it. */
  fitToData?: boolean;
};

/** A diagonal-line fill for the part of a lifetime before its first network I/O. */
const hatchCache = new Map<string, HTMLCanvasElement>();
function hatch(color: string): HTMLCanvasElement {
  let c = hatchCache.get(color);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 6;
    const g = c.getContext('2d')!;
    g.strokeStyle = color;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-1, 7);
    g.lineTo(7, -1);
    g.stroke();
    hatchCache.set(color, c);
  }
  return c;
}

/** Bars get the ramp without its lightest step, which vanishes against the surface. */
const ramp = (scheme: Scheme) => SEQUENTIAL[scheme].slice(1);

/**
 * 09: one bar per process instance, from exec to end (an arrow while it
 * runs), colored by lifetime bytes on a log scale. The part before the first
 * network I/O is thin and hatched. Instances of one name share a lane and
 * overlapping ones get sub-rows, so restart loops and cron jobs show up as
 * rows of short bars. The lane tooltip says whether the starts are regular.
 * Click a bar to open the process. URL: `gantt_sort=bytes`.
 */
export function ProcessGantt({ range, name, uid, highlight, title = 'Process lifetimes', subtitle, fitToData }: Props) {
  const [sortRaw, setSort] = useSearchParam(SORT_PARAM, 'start');
  const sort = parseSort(sortRaw);
  const q = useQuery<LifetimesResponse>(urls.historyLifetimes(range, { name, uid }));
  const d = q.data;
  const scheme = useColorScheme();
  // Running bars reach the time of the answer; a clock tick would re-push the option and reset the zoom.
  const now = useMemo(() => Date.now(), [d]);
  const chart = useEChartRef();

  const packed = useMemo<Packed | null>(() => (d ? packLanes(d.bars, sort, now) : null), [d, sort, now]);
  const rows = packed?.rows ?? 0;
  const visible = Math.max(MIN_ROWS, Math.min(rows, MAX_ROWS));
  const scroll = rows > MAX_ROWS;
  const height = GRID.top + GRID.bottom + visible * ROW_PX;

  const latest = useRef({ packed, highlight });
  latest.current = { packed, highlight };

  // Axes, zoom, color scale and series follow the data; pushed with
  // replaceMerge so a new answer resets the zoom and drops old bars.
  const dynamic = useMemo(() => {
    const p = packed ?? { lanes: [], bars: [], rows: 0 };
    const muted = cssVar('--muted');
    const ink = cssVar('--text');
    const band = cssVar('--chart-grid');
    const axisLine = cssVar('--chart-axis');
    const firstRow = new Map(p.lanes.map((l) => [l.row0, laneLabel(l)]));
    const values = p.bars.map((b) => logBytes(b.bar.tx + b.bar.rx));
    const [lo, hi] = colorExtent(values);
    const pattern = { image: hatch(muted), repeat: 'repeat' as const };
    const barData = p.bars.map((b, i) => ({
      value: [b.row, b.bar.startMs, b.bar.firstSeenMs, b.end, values[i]!, i, b.bar.endedMs === null ? 1 : 0, b.bar.id === highlight ? 1 : 0] as BarValue,
    }));

    // fitToData: from the earliest start, with a margin of 5 % of the shown span.
    let x0 = range.from;
    if (fitToData && p.bars.length) {
      const first = Math.min(...p.bars.map((b) => b.bar.startMs));
      x0 = Math.max(range.from, first - (range.to - first) * 0.05);
    }

    return {
      grid: { ...GRID, right: scroll ? 44 : 24 },
      xAxis: { type: 'time', min: range.from, max: range.to },
      yAxis: {
        type: 'category',
        inverse: true,
        data: Array.from({ length: Math.max(p.rows, 1) }, (_, i) => String(i)),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: axisLine } },
        axisLabel: {
          interval: 0,
          width: GRID.left - 16,
          overflow: 'truncate',
          color: ink,
          formatter: (v: string) => firstRow.get(Number(v)) ?? '',
        },
        splitLine: { show: false },
      },
      dataZoom: [
        // Drag pans, ctrl+wheel zooms time; plain wheel still scrolls the page.
        { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: true, startValue: x0, endValue: range.to },
        { type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 18, bottom: 6, brushSelect: false, showDetail: false, startValue: x0, endValue: range.to },
        // Lanes: shift+wheel scrolls, the slider on the right when there are more rows than fit.
        {
          type: 'inside',
          yAxisIndex: 0,
          filterMode: 'none',
          zoomOnMouseWheel: false,
          moveOnMouseWheel: 'shift',
          moveOnMouseMove: false,
          startValue: 0,
          endValue: Math.max(0, Math.min(p.rows, MAX_ROWS) - 1),
        },
        {
          type: 'slider',
          yAxisIndex: 0,
          filterMode: 'none',
          show: scroll,
          width: 14,
          right: 8,
          top: GRID.top,
          bottom: GRID.bottom,
          brushSelect: false,
          showDetail: false,
          zoomLock: true,
          startValue: 0,
          endValue: Math.max(0, Math.min(p.rows, MAX_ROWS) - 1),
        },
      ],
      visualMap: {
        type: 'continuous',
        seriesId: BARS_ID,
        dimension: 4,
        min: lo,
        max: hi,
        calculable: false,
        orient: 'horizontal',
        right: scroll ? 44 : 24,
        top: 0,
        itemWidth: 10,
        itemHeight: 160,
        text: [fmtBytes(10 ** hi), fmtBytes(lo <= 0 ? 0 : 10 ** lo)],
        formatter: (v: number) => fmtBytes(10 ** v),
        textGap: 8,
        textStyle: { color: muted, fontSize: 16 },
        inRange: { color: ramp(scheme) },
      },
      series: [
        {
          id: LANES_ID,
          type: 'custom',
          clip: true,
          silent: false,
          animation: false,
          encode: { x: 3, y: 0 },
          data: p.lanes.map((l, i) => ({ value: [l.row0, l.rows, i, range.from] })),
          renderItem: (params: any, api: any) => {
            const cs = params.coordSys as { x: number; y: number; width: number; height: number };
            const row0 = api.value(0) as number;
            const n = api.value(1) as number;
            const li = api.value(2) as number;
            const h = api.size([0, 1])[1] as number;
            const top = (api.coord([range.from, row0])[1] as number) - h / 2;
            return {
              type: 'group',
              children: [
                {
                  type: 'rect',
                  shape: { x: cs.x, y: top, width: cs.width, height: h * n },
                  style: { fill: li % 2 ? 'rgba(0,0,0,0)' : band },
                },
                {
                  type: 'line',
                  shape: { x1: cs.x, y1: top, x2: cs.x + cs.width, y2: top },
                  style: { stroke: axisLine, lineWidth: li ? 0.5 : 0 },
                  silent: true,
                },
              ],
            };
          },
        },
        {
          id: BARS_ID,
          type: 'custom',
          clip: true,
          animation: false,
          cursor: 'pointer',
          encode: { x: [1, 2, 3], y: 0 },
          data: barData,
          renderItem: (params: any, api: any) => {
            const cs = params.coordSys as { x: number; width: number };
            const row = api.value(0) as number;
            const [x0, yc] = api.coord([api.value(1), row]) as [number, number];
            const x1 = api.coord([api.value(2), row])[0] as number;
            const x2 = api.coord([api.value(3), row])[0] as number;
            const running = api.value(6) === 1;
            const hl = api.value(7) === 1;
            const h = api.size([0, 1])[1] as number;
            const full = Math.max(3, h * 0.64);
            const thin = Math.max(2, h * 0.26);
            const color = api.visual('color') as string;
            // Open end (still running at the last update): an arrowhead that
            // ends the bar, kept inside the plot when the bar runs past its edge.
            const a = running ? full / 2 + 1 : 0;
            const xe = running ? Math.min(x2, cs.x + cs.width) : x2;
            // A lifetime shorter than a pixel still shows.
            const w = Math.max(2, xe - a - x1);
            const children: object[] = [];
            if (x1 - x0 >= 1) {
              children.push({
                type: 'rect',
                shape: { x: x0, y: yc - thin / 2, width: x1 - x0, height: thin },
                style: { fill: pattern, stroke: muted, lineWidth: 0.5 },
              });
            }
            children.push({
              type: 'rect',
              shape: { x: x1, y: yc - full / 2, width: w, height: full, r: running ? [2, 0, 0, 2] : 2 },
              style: { fill: color, stroke: hl ? ink : 'rgba(0,0,0,0.2)', lineWidth: hl ? 2 : 0.5 },
            });
            if (running) {
              children.push({
                type: 'polygon',
                shape: {
                  points: [
                    [x1 + w, yc - a],
                    [x1 + w + a, yc],
                    [x1 + w, yc + a],
                  ],
                },
                style: { fill: color, stroke: hl ? ink : 'none', lineWidth: hl ? 1.5 : 0 },
              });
            }
            return { type: 'group', children };
          },
        },
      ],
    };
  }, [packed, highlight, range.from, range.to, scroll, scheme, fitToData]);

  const option = useMemo<EChartsCoreOption>(
    () => ({
      animation: false,
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { seriesId?: string; value?: number[] }) => {
          const { packed: pk, highlight: hl } = latest.current;
          if (!pk || !p.value) return '';
          if (p.seriesId === LANES_ID) return laneTip(pk.lanes[p.value[2]!]);
          const pb = pk.bars[p.value[5]!];
          return pb ? barTip(pb.bar, pk.lanes[pb.lane]!, pb.bar.id === hl) : '';
        },
      },
    }),
    // The formatter reads the latest data through a ref.
    [],
  );

  const push = (c: EChartsType | null) => c?.setOption(dynamic, { replaceMerge: ['series', 'dataZoom', 'visualMap'] });
  useEffect(() => push(chart.current), [dynamic, chart]);

  const onEvents = useMemo(
    () => ({
      click: (p: { seriesId?: string; value?: number[] }) => {
        if (p.seriesId !== BARS_ID || !p.value) return;
        const { packed: pk, highlight: hl } = latest.current;
        const b = pk?.bars[p.value[5]!]?.bar;
        if (b && b.id !== hl) navigate(processPath(b.id));
      },
    }),
    [],
  );

  const n = d?.bars.length ?? 0;
  const lanes = packed?.lanes.length ?? 0;
  const sub =
    subtitle ??
    'One bar per process instance, from exec to exit (arrow: still running); thin and hatched until its first network I/O; color: lifetime bytes (log)';
  const counts = d ? ` · ${n.toLocaleString()} instance${n === 1 ? '' : 's'}${name ? '' : ` of ${lanes} name${lanes === 1 ? '' : 's'}`}` : '';

  return (
    <Panel
      title={title}
      subtitle={
        <>
          {sub}
          {counts} · click a bar to open it
          {d?.truncated && (
            <>
              {' · '}
              <strong>the latest {n.toLocaleString()} only: narrow the range or filter by name</strong>
            </>
          )}
        </>
      }
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && !d.bars.length ? 'No process with network I/O ran in this range.' : undefined}
      actions={
        name ? undefined : (
          <span className="ctl-group">
            <span className="ctl-label">lanes by</span>
            <SegmentedControl<GanttSort> label="Sort lanes by" options={SORT_OPTIONS} value={sort} onChange={(v) => setSort(v)} />
          </span>
        )
      }
    >
      <div className="chart-wrap">
        <EChart
          option={option}
          onEvents={onEvents}
          onInit={push}
          chartRef={chart}
          height={height}
          ariaLabel={`Process lifetimes: ${n} instances in ${lanes} lanes`}
        />
      </div>
    </Panel>
  );
}

/** The lane tooltip: instance count, median lifetime, start regularity. */
function laneTip(lane: Lane | undefined): string {
  if (!lane) return '';
  return `<div class="tip"><div class="tip-head"><span>${esc(lane.name)}</span><span class="tip-num muted">${fmtBytes(lane.bytes)}</span></div>${laneRows(lane)}</div>`;
}

function laneRows(lane: Lane): string {
  const s = lane.stats;
  const row = (k: string, v: string) => `<div class="tip-row"><span class="tip-name">${k}</span><span class="tip-num">${v}</span></div>`;
  let out = row('instances', String(s.n));
  out += row(
    'median lifetime',
    s.medianLifetimeMs === null ? '<span class="muted">none ended</span>' : `${fmtDuration(s.medianLifetimeMs)}${s.ended < s.n ? ` <span class="muted">(${s.ended} ended)</span>` : ''}`,
  );
  if (s.meanGapMs !== null) {
    out += row(
      'start gap',
      `${fmtDuration(s.meanGapMs)} mean${s.gapCv === null ? '' : `, CV ${s.gapCv.toFixed(2)}`}`,
    );
  }
  if (s.scheduled) out += `<div class="tip-foot"><strong>runs every ~${fmtDuration(s.meanGapMs!)}</strong>: likely a scheduled job</div>`;
  return out;
}

/** A bar's tooltip: pid, command, times, bytes, then its lane's pattern callouts. */
function barTip(b: LifetimeBar, lane: Lane, current: boolean): string {
  const row = (k: string, v: string) => `<div class="tip-row"><span class="tip-name">${k}</span><span class="tip-num">${v}</span></div>`;
  const end = b.endedMs;
  const life = end === null ? null : barEnd(b, 0) - b.startMs;
  return (
    `<div class="tip"><div class="tip-head"><span>${esc(b.name)}</span><span class="tip-num muted">pid ${b.pid}${current ? ' · this process' : ''}</span></div>` +
    (b.cmdline ? `<div class="tip-cmd muted" style="padding-left:0">${esc(cut(b.cmdline, 100))}</div>` : '') +
    row('started', esc(fmtTime(b.startMs))) +
    (b.firstSeenMs > b.startMs ? row('first I/O', `${esc(fmtTime(b.firstSeenMs))} <span class="muted">(+${fmtDuration(b.firstSeenMs - b.startMs)})</span>`) : '') +
    (end === null
      ? row('ended', `<span class="muted">not recorded (running, last I/O ${esc(fmtTime(b.lastSeenMs))})</span>`)
      : row('ended', `${esc(fmtTime(end))} <span class="muted">(ran ${fmtDuration(life!)})</span>`)) +
    row('↑ sent', fmtBytes(b.tx)) +
    row('↓ received', fmtBytes(b.rx)) +
    (lane.bars.length > 1 ? `<div class="tip-foot muted">lane ${esc(lane.name)}</div>${laneRows(lane)}` : '') +
    `<div class="tip-foot muted">${current ? 'the process on this page' : 'click: open the process page'}</div></div>`
  );
}
