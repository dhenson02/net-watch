import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompactTick } from '../../shared/api.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtTime } from '../charts/format.ts';
import { cssVar } from '../charts/cssVar.ts';
import { bandSeries, mirroredStackOption, stackTooltip, totalSeries } from '../charts/mirroredStack.ts';
import { slotColor, type Scheme, type SlotAssigner } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { useLive } from '../hooks/useLive.ts';
import { useNow } from '../hooks/useNow.ts';
import { navigate, useSearchParam } from '../router.ts';
import { bandAt, OTHER_KEY, TOP_N, useLiveThroughput, windowTicks, type Band, type GroupBy, type Throughput } from './useLiveThroughput.ts';

/** The whole client buffer (useLive's capacity): the "max" window. */
const MAX_S = 3600;
const WINDOWS = { '5m': 300, '15m': 900, max: MAX_S } as const;
type WindowKey = keyof typeof WINDOWS;

const WINDOW_OPTIONS = [
  { value: '5m', label: '5 min' },
  { value: '15m', label: '15 min' },
  { value: 'max', label: 'max', title: 'Everything the live buffer holds (up to 1 h)' },
] as const;
const GROUP_OPTIONS = [
  { value: 'name', label: 'by name', title: 'One band per process name' },
  { value: 'id', label: 'by instance', title: 'One band per process instance (pid + start time)' },
] as const;

const TOOLTIP = stackTooltip(['tx', 'rx'], { timeStyle: 'time' });

const color = (b: Band, scheme: Scheme) => slotColor(b.slot, scheme);

/** Full series definitions; used when the set of bands or their colors change. */
function seriesDefs(data: Throughput, scheme: Scheme, ink: string) {
  const band = (b: Band, dir: 'tx' | 'rx') => bandSeries({ key: b.key, label: b.label, color: color(b, scheme) }, dir, b[dir]);
  return [
    ...data.bands.map((b) => band(b, 'tx')),
    ...data.bands.map((b) => band(b, 'rx')),
    totalSeries('tx', data.totalTx, ink, true),
    totalSeries('rx', data.totalRx, ink),
  ];
}

/** Data-only update for an unchanged set of bands. */
function seriesData(data: Throughput) {
  return [
    ...data.bands.map((b) => ({ id: `tx:${b.key}`, data: b.tx })),
    ...data.bands.map((b) => ({ id: `rx:${b.key}`, data: b.rx })),
    { id: 'total:tx', data: data.totalTx },
    { id: 'total:rx', data: data.totalRx },
  ];
}

/**
 * 01: system-wide throughput at tick resolution, stacked by the top processes.
 * tx is stacked above zero and rx below it; the rest goes to "other", so each
 * stack adds up to the tick total.
 */
export function LiveThroughput({ slots }: { slots: SlotAssigner }) {
  const [winParam, setWin] = useSearchParam('live_win', '15m');
  const [byParam, setBy] = useSearchParam('live_by', 'name');
  const win: WindowKey = winParam in WINDOWS ? (winParam as WindowKey) : '15m';
  const by: GroupBy = byParam === 'id' ? 'id' : 'name';
  const windowS = WINDOWS[win];

  const live = useLive(MAX_S);
  const scheme = useColorScheme();
  const now = useNow(1000);
  const chart = useEChartRef();

  // Paused: the view ends at the tick shown when pausing; ticks keep buffering.
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const end = pausedAt ?? live.latestTs ?? 0;
  const prevView = useRef<readonly CompactTick[] | null>(null);
  const view = useMemo(() => {
    const v = windowTicks(live.ticks, end, windowS, prevView.current);
    prevView.current = v;
    return v;
  }, [live.ticks, end, windowS]);

  const data = useLiveThroughput(view, by, windowS, slots);

  // Structure only; series and their data are pushed through the ref.
  const option = useMemo<EChartsCoreOption>(
    () => mirroredStackOption({ stacks: ['tx', 'rx'], muted: cssVar('--muted'), tooltip: TOOLTIP }),
    // cssVar reads the current theme's colors.
    [scheme],
  );

  const first = view[0];
  const xMin = win === 'max' ? (first?.ts ?? end) : end - windowS * 1000;
  // The band set and colors; when it changes, the series are replaced, not merged.
  const structure = `${scheme}|${data.bands.map((b) => `${b.key}\u0001${b.label}\u0001${b.slot}`).join('\u0002')}`;

  const latest = useRef({ data, structure, xMin, end, scheme });
  latest.current = { data, structure, xMin, end, scheme };
  const pushed = useRef<string | null>(null);

  const push = (c: EChartsType | null) => {
    if (!c) return;
    const { data, structure, xMin, end, scheme } = latest.current;
    const xAxis = { min: xMin, max: end || undefined };
    if (pushed.current !== structure) {
      c.setOption(
        {
          legend: { data: data.bands.map((b) => b.label) },
          xAxis,
          series: seriesDefs(data, scheme, cssVar('--text')),
        },
        { replaceMerge: ['series'] },
      );
      pushed.current = structure;
    } else {
      c.setOption({ xAxis, series: seriesData(data) });
    }
  };
  // Legend-hidden labels, so a click resolves to a band that is drawn.
  const hidden = useRef(new Set<string>());
  /** The clickable band under a pixel: not "other", with a known instance. */
  const hit = (c: EChartsType, x: number, y: number): string | null => {
    if (!c.containPixel('grid', [x, y])) return null;
    const [ts, v] = c.convertFromPixel('grid', [x, y]) as [number, number];
    const { data } = latest.current;
    const b = bandAt(data, ts, v, hidden.current);
    return b && b.key !== OTHER_KEY ? (data.instance.get(b.key) ?? null) : null;
  };
  const onInit = (c: EChartsType) => {
    pushed.current = null;
    hidden.current = new Set();
    push(c);
    // Resolved from the pixel rather than ECharts' hit test: the bands have no
    // stroke and are 1 s wide, so area hits are unreliable.
    const zr = c.getZr();
    zr.on('click', (e) => {
      const id = hit(c, e.offsetX, e.offsetY);
      if (!id) return;
      const i = id.indexOf(':');
      navigate(`/process/${id.slice(0, i)}/${id.slice(i + 1)}`);
    });
    // zrender sets the cursor after its mousemove handlers run; override it after.
    zr.on('mousemove', (e) => {
      const pointer = hit(c, e.offsetX, e.offsetY) !== null;
      queueMicrotask(() => zr.setCursorStyle(pointer ? 'pointer' : 'default'));
    });
    c.on('legendselectchanged', (e: any) => {
      hidden.current = new Set(Object.entries(e.selected as Record<string, boolean>).flatMap(([k, on]) => (on ? [] : [k])));
    });
  };
  useEffect(() => push(chart.current), [data, xMin, end, structure, chart]);

  const last = live.ticks.at(-1);
  const stale = last !== undefined && now - last.ts > 3 * last.intervalMs;

  return (
    <Panel
      title="Throughput"
      subtitle={`Top ${TOP_N} ${by === 'name' ? 'process names' : 'process instances'} · sent above zero, received below · click a band to open the process`}
      wide
      loading={live.status !== 'live' && !live.ticks.length}
      error={live.error}
      empty={live.status === 'live' && !live.ticks.length ? 'No ticks yet. Is the collector running?' : undefined}
      actions={
        <>
          <SegmentedControl label="Group series" options={GROUP_OPTIONS} value={by} onChange={(v) => setBy(v, { replace: true })} />
          <SegmentedControl label="Window" options={WINDOW_OPTIONS} value={win} onChange={(v) => setWin(v, { replace: true })} />
          <button
            type="button"
            className={`btn${pausedAt !== null ? ' active' : ''}`}
            aria-pressed={pausedAt !== null}
            onClick={() => setPausedAt(pausedAt === null ? (live.latestTs ?? null) : null)}
            disabled={pausedAt === null && live.latestTs === null}
            title={pausedAt === null ? 'Freeze the chart; ticks keep buffering' : 'Resume live updates'}
          >
            {pausedAt === null ? '❚❚ pause' : '▶ resume'}
          </button>
        </>
      }
    >
      <div className="chart-wrap">
        <EChart
          option={option}
          chartRef={chart}
          onInit={onInit}
          group="live"
          height={320}
          ariaLabel="Throughput by process, sent stacked above zero and received below"
        />
        {stale && (
          <div className="chart-overlay" role="status">
            stale since {fmtTime(last.ts, 'time')}
          </div>
        )}
        {pausedAt !== null && !stale && <div className="chart-overlay chart-overlay-quiet">paused at {fmtTime(pausedAt, 'time')}</div>}
      </div>
    </Panel>
  );
}
