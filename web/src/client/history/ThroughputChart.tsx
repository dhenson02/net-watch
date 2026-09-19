import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import {
  THROUGHPUT_OTHER,
  type BurstResponse,
  type CompareOffset,
  type ThroughputBy,
  type ThroughputCompare,
  type ThroughputDir,
  type ThroughputResponse,
} from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtDuration, fmtRate, fmtTime } from '../charts/format.ts';
import { cssVar } from '../charts/cssVar.ts';
import { bandSeries, mirroredStackOption, stackTooltip, tipRow, totalSeries } from '../charts/mirroredStack.ts';
import type { SlotAssigner } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { useSlots } from '../charts/useSlots.ts';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { Toggle } from '../components/Toggle.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { setSearchParams, useSearch } from '../router.ts';
import { BAND_TOO_LONG, bandSpanOk, BURST_ID, burstAt, burstSeries, burstText, parseBandParam } from './burst.ts';
import { COMPARE_NOUN, deviationRuns, GHOST_ID, ghostAt, ghostSeries, ghostText, parseCompareParam } from './ghost.ts';
import { bandColors, buildSeries, drillDown, TOP_DEFAULT, type HistorySeries } from './throughputSeries.ts';
import { useThroughput, useThroughputParams } from './useThroughput.ts';

/** The throughput query's state as `onAnswer` passes it. */
export type ThroughputAnswer = { data: ThroughputResponse | null; stale: boolean; loading: boolean; error: string | null };

/** The throughput panel's element id: other panels scroll to it after setting the range (06). */
export const THROUGHPUT_PANEL_ID = 'throughput';

const BY_OPTIONS = [
  { value: 'app', label: 'app', title: 'Application protocol (HTTPS, DNS, …)' },
  { value: 'name', label: 'process', title: 'Process name' },
  { value: 'proto', label: 'proto', title: 'Transport (TCP, UDP)' },
  { value: 'uid', label: 'user', title: 'uid of the process' },
  { value: 'dest', label: 'dest', title: 'Remote ip:port' },
] as const;
const DIR_OPTIONS = [
  { value: 'both', label: '↑↓', title: 'Sent above zero, received below' },
  { value: 'tx', label: '↑ sent' },
  { value: 'rx', label: '↓ received' },
  { value: 'total', label: 'total', title: 'Sent + received, one stack' },
] as const;
const TOP_OPTIONS = [
  { value: '5', label: '5' },
  { value: '8', label: '8' },
  { value: '12', label: '12' },
  { value: '20', label: '20' },
] as const;
const COMPARE_OPTIONS = [
  { value: 'off', label: 'off' },
  { value: '1d', label: '1 day', title: 'Dashed line: the same time one day earlier' },
  { value: '1w', label: '1 week', title: 'Dashed line: the same time one week earlier' },
] as const;

const BY_NOUN: Record<ThroughputBy, string> = { app: 'apps', name: 'processes', proto: 'protocols', uid: 'users', dest: 'destinations' };

/** Zoom and brush commit to the URL this long after the last change. */
const ZOOM_DEBOUNCE_MS = 300;
/** Narrowest range a zoom or brush can select. */
const MIN_SPAN_MS = 60_000;
/** Two legend clicks on one item within this are a double-click. */
const DBLCLICK_MS = 400;
/** Room under the plot for the slider. */
const GRID = { bottom: 64 };

const set = (patch: Record<string, string | number | null>) => setSearchParams(patch);

type Props = {
  range: TimeRange;
  /** The page's SlotAssigner; process names keep the colors the page's other charts give them. */
  slots: SlotAssigner;
  /**
   * Overlay series (plans 11/12/13/16), pushed after the bands and totals on
   * the same axes. Ids must not start with `tx:`, `rx:`, `sum:` or `total:`;
   * the axis tooltip lists them by series name after the stacks.
   */
  overlays?: readonly object[];
  /** Extra header controls, e.g. overlay toggles. */
  actions?: ReactNode;
  /** Receives the chart instance, e.g. for a hover marker from a track below (12). */
  chartRef?: RefObject<EChartsType | null>;
  /** Also request the unknown-protocol share (16), passed to `below` as part of `answer`. */
  unknown?: boolean;
  /** Also request the call rates (14), for `onAnswer`. */
  calls?: boolean;
  /**
   * Receives the query's state whenever it changes (14's calls panel reads
   * the same answer rather than asking again). `data` may be stale.
   */
  onAnswer?: (state: ThroughputAnswer) => void;
  /**
   * Rendered under the plot inside the panel (12's lifecycle track, 16's
   * unknown share). `topKeys` are the answer's keys without "other"; they and
   * `answer` are null while it loads or is stale.
   */
  below?: (ctx: { topKeys: readonly string[] | null; answer: ThroughputResponse | null }) => ReactNode;
};

/**
 * 05: throughput over the page's range, stacked by one dimension (URL:
 * `by`, `dir`, `top`, `filter.*`). Zooming (slider, ctrl+wheel) or brushing
 * the plot writes the new range to the URL, which re-queries at a finer step;
 * double-clicking a legend item filters to it and drills into the next
 * dimension. `compare=1d|1w` (11) draws the same window that long before as
 * a dashed ghost behind the stack. `band=1` (13) shades each bucket's per-tick
 * p95 above the mean (the stack's top) and dots its busiest tick, from raw
 * flows, for ranges up to 24 h.
 */
export function ThroughputChart({ range, slots, overlays, actions, chartRef, unknown = false, calls = false, onAnswer, below }: Props) {
  const p = useThroughputParams();
  const search = useSearch();
  const compare = useMemo(() => parseCompareParam(search), [search]);
  const ownSlots = useSlots();
  const q = useThroughput(range, p, slots, ownSlots, compare, unknown, calls);
  const answerTo = useRef(onAnswer);
  answerTo.current = onAnswer;
  useEffect(() => {
    answerTo.current?.({ data: q.data ?? null, stale: q.stale, loading: q.loading, error: q.error });
  }, [q.data, q.stale, q.loading, q.error]);
  const scheme = useColorScheme();
  const ownChart = useEChartRef();
  const chart = chartRef ?? ownChart;
  const d = q.data;

  const series = useMemo<HistorySeries | null>(() => {
    if (!d) return null;
    return buildSeries(d, p.dir, bandColors(d.keys, q.slotOf, scheme));
  }, [d, p.dir, q.slotOf, scheme]);

  // 11: the earlier window as dashed lines behind the stack, with the runs
  // where now is well above it shaded. Hidden at once when switched off.
  const ghost: ThroughputCompare | null = (compare && d?.compare) || null;
  const noun = compare ? COMPARE_NOUN[compare] : '';
  const ghostSeriesList = useMemo(() => {
    if (!ghost || !series || !d) return [];
    const areas = deviationRuns(series.totals, series.stacks, ghost, d.step * 1000);
    return ghostSeries(ghost, p.dir, cssVar('--muted'), `same time ${noun}`, areas);
    // scheme re-reads the muted color.
  }, [ghost, series, d, p.dir, noun, scheme]);

  // 13: the burst band, its own query over the same buckets (raw flows, ≤ 24 h).
  const band = useMemo(() => parseBandParam(search), [search]);
  const bandOk = bandSpanOk(range);
  const bandQ = useQuery<BurstResponse>(band && bandOk ? urls.historyBurst(range, { dir: p.dir, filters: p.filters }) : null);
  // A stale answer still lines up by time, but only one for the drawn direction has the right sides.
  const burst = band && bandOk && bandQ.data?.dir === p.dir ? bandQ.data : null;
  const burstSeriesList = useMemo(
    () => (burst ? burstSeries(burst, p.dir, cssVar('--accent')) : []),
    // scheme re-reads the accent color.
    [burst, p.dir, scheme],
  );
  const burstTip = useRef<BurstResponse | null>(null);
  burstTip.current = burst;

  const allOverlays = useMemo(() => [...ghostSeriesList, ...burstSeriesList, ...(overlays ?? [])], [ghostSeriesList, burstSeriesList, overlays]);
  // The tooltip reads the ghost at the hovered time from here, so the option needn't change with it.
  const ghostTip = useRef<{ c: ThroughputCompare; noun: string } | null>(null);
  ghostTip.current = ghost && { c: ghost, noun };

  const stacksKey = series?.stacks.join() ?? (p.dir === 'both' ? 'tx,rx' : p.dir);
  const step = d?.step ?? 60;
  const option = useMemo<EChartsCoreOption>(() => {
    const stacks = series?.stacks ?? (p.dir === 'both' ? ['tx', 'rx'] : p.dir === 'total' ? ['sum'] : [p.dir]);
    const muted = cssVar('--muted');
    const accent = cssVar('--accent');
    return mirroredStackOption({
      stacks: stacks as HistorySeries['stacks'],
      muted,
      tooltip: stackTooltip(stacks as HistorySeries['stacks'], {
        timeStyle: step < 60 ? 'time' : 'datetime',
        note: `${fmtDuration(step * 1000)} mean`,
        omit: [GHOST_ID, BURST_ID],
        sectionRows: (stack, ts, total) => {
          const g = ghostTip.current;
          const b = burstTip.current && burstAt(burstTip.current, stack, ts);
          return (
            (g ? tipRow(muted, `same time ${g.noun}`, ghostText(total, ghostAt(g.c, stack, ts), fmtRate)) : '') +
            (b ? tipRow(accent, 'per tick', burstText(b, fmtRate)) : '')
          );
        },
      }),
      grid: GRID,
      extra: {
        dataZoom: [
          // Drag is the brush; ctrl+wheel (and trackpad pinch) zooms, so plain wheel still scrolls the page.
          { type: 'inside', xAxisIndex: 0, zoomOnMouseWheel: 'ctrl', moveOnMouseMove: false, moveOnMouseWheel: false, minValueSpan: MIN_SPAN_MS },
          { type: 'slider', xAxisIndex: 0, height: 20, bottom: 8, minValueSpan: MIN_SPAN_MS, brushSelect: false, showDetail: false },
        ],
        brush: {
          xAxisIndex: 0,
          brushType: 'lineX',
          brushMode: 'single',
          transformable: false,
          brushStyle: { color: 'rgba(128,128,128,0.18)', borderColor: muted, borderWidth: 1 },
          outOfBrush: { colorAlpha: 1 },
        },
      },
    });
    // stacksKey stands for the stacks; scheme re-reads the theme's colors.
  }, [stacksKey, step, scheme]);

  // What the event handlers need, without re-binding them.
  const latest = useRef({ series, range, p, overlays: allOverlays });
  latest.current = { series, range, p, overlays: allOverlays };
  const pushedData = useRef<HistorySeries | null>(null);
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastLegend = useRef<{ name: string; at: number } | null>(null);

  const push = (c: EChartsType | null) => {
    if (!c) return;
    const { series: s, range: r, overlays: extra } = latest.current;
    if (!s) return;
    const ink = cssVar('--text');
    const fresh = pushedData.current !== s;
    pushedData.current = s;
    c.setOption(
      {
        legend: { data: s.bands.map((b) => b.label) },
        xAxis: { min: r.from, max: r.to },
        // New data covers exactly the range: show all of it.
        ...(fresh && { dataZoom: [{ start: 0, end: 100 }, { start: 0, end: 100 }] }),
        series: [
          ...s.stacks.flatMap((st) => s.bands.map((b) => bandSeries(b, st, b.data[st]!))),
          ...s.stacks.map((st, i) => totalSeries(st, s.totals[st]!, ink, i === 0)),
          ...(extra ?? []),
        ],
      },
      { replaceMerge: ['series'] },
    );
  };

  /** Writes a zoomed or brushed window to the URL (a history entry, so Back zooms out). */
  const commit = (from: number, to: number) => {
    const r = latest.current.range;
    from = Math.max(r.from, Math.round(from));
    to = Math.min(r.to, Math.round(to));
    if (to - from < MIN_SPAN_MS || (from === r.from && to === r.to)) return;
    set({ from, to });
  };

  const onInit = (c: EChartsType) => {
    pushedData.current = null;
    push(c);
    // A drag on the plot selects a time window (brush on the x axis).
    c.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } });
    c.on('brushEnd', (e: any) => {
      const range = e.areas?.[0]?.coordRange as [number, number] | undefined;
      c.dispatchAction({ type: 'brush', areas: [] });
      if (range) commit(Math.min(...range), Math.max(...range));
    });
    c.on('datazoom', () => {
      clearTimeout(zoomTimer.current);
      zoomTimer.current = setTimeout(() => {
        const dz = (c.getOption() as { dataZoom?: { start?: number; end?: number }[] }).dataZoom?.[0];
        if (!dz) return;
        const { from, to } = latest.current.range;
        const span = to - from;
        commit(from + (span * (dz.start ?? 0)) / 100, from + (span * (dz.end ?? 100)) / 100);
      }, ZOOM_DEBOUNCE_MS);
    });
    // ECharts has no legend double-click: two toggles of one item in quick
    // succession (which leave it visible) drill down instead.
    c.on('legendselectchanged', (e: any) => {
      const now = performance.now();
      const prev = lastLegend.current;
      if (!prev || prev.name !== e.name || now - prev.at > DBLCLICK_MS) {
        lastLegend.current = { name: e.name, at: now };
        return;
      }
      lastLegend.current = null;
      const { series: s, p } = latest.current;
      const key = s?.keyOf.get(e.name);
      const patch = key === undefined ? null : drillDown(p, key);
      if (!patch) return;
      c.dispatchAction({ type: 'legendSelect', name: e.name });
      set(patch);
    });
  };
  useEffect(() => push(chart.current), [series, allOverlays, range.from, range.to, chart]);
  useEffect(() => () => clearTimeout(zoomTimer.current), []);

  const byNoun = BY_NOUN[p.by];
  // Ghost status for the header: none at all, or only from some point on.
  const ghostNote =
    compare && d && !q.stale
      ? d.compare === null
        ? `no data for ${noun}`
        : d.compare && d.compare.since > d.compare.t[0]!
          ? `${noun}: no data before ${fmtTime(d.compare.since - d.compare.offset, 'datetime')}`
          : ''
      : '';
  const bandNote = !band
    ? ''
    : !bandOk
      ? BAND_TOO_LONG
      : bandQ.error
        ? bandQ.error
        : bandQ.loading && !burst
          ? 'loading band…'
          : '';
  const source = d ? `${fmtDuration(d.step * 1000)} buckets from ${d.table === 'flows' ? 'raw flows' : 'the per-minute rollup'}` : '';
  const empty = d && !q.stale && !d.keys.length ? 'No traffic in this range.' : undefined;
  const topKeys = useMemo(() => (d && !q.stale ? d.keys.filter((k) => k !== THROUGHPUT_OTHER) : null), [d, q.stale]);

  return (
    <Panel
      id={THROUGHPUT_PANEL_ID}
      title="Throughput"
      subtitle={
        <>
          Top {p.top} {byNoun} + other{source && ` · ${source}`} · drag across the plot or use the slider to zoom (Back zooms out) · double-click a
          legend item to drill into it
        </>
      }
      wide
      loading={q.loading}
      error={q.error}
      empty={empty}
      actions={
        <>
          <SegmentedControl label="Stack by" options={BY_OPTIONS} value={p.by} onChange={(v) => set({ by: v === 'app' ? null : v })} />
          <SegmentedControl<ThroughputDir> label="Direction" options={DIR_OPTIONS} value={p.dir} onChange={(v) => set({ dir: v === 'both' ? null : v })} />
          <SegmentedControl
            label="Series shown"
            options={TOP_OPTIONS}
            value={String(p.top) as (typeof TOP_OPTIONS)[number]['value']}
            onChange={(v) => set({ top: Number(v) === TOP_DEFAULT ? null : v })}
          />
          <span className="ctl-group">
            <span className="ctl-label">compare</span>
            <SegmentedControl<'off' | CompareOffset>
              label="Compare with the same time earlier"
              options={COMPARE_OPTIONS}
              value={compare ?? 'off'}
              onChange={(v) => set({ compare: v === 'off' ? null : v })}
            />
            {ghostNote && <span className="ctl-note">{ghostNote}</span>}
          </span>
          <span className="ctl-group">
            <Toggle
              label="Burst band"
              checked={band && bandOk}
              disabled={!bandOk}
              onChange={(on) => set({ band: on ? '1' : null })}
              title={
                bandOk
                  ? 'Shade each bucket from its mean up to the p95 of its per-tick rates, and dot its busiest tick (raw flows)'
                  : BAND_TOO_LONG
              }
            />
            {bandNote && <span className="ctl-note">{bandNote}</span>}
          </span>
          {actions}
        </>
      }
    >
      <div className="chart-wrap">
        <EChart
          option={option}
          chartRef={chart}
          onInit={onInit}
          group="history"
          height={360}
          ariaLabel={`Throughput by ${byNoun}, ${p.dir === 'both' ? 'sent stacked above zero and received below' : 'stacked'}`}
        />
      </div>
      {below?.({ topKeys, answer: d && !q.stale ? d : null })}
    </Panel>
  );
}
