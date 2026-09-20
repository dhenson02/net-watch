import { useMemo, useState } from 'react';
import type { BeaconDest, BeaconScope, BeaconsResponse, ProcessInfo } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart } from '../charts/EChart.tsx';
import type { EChartsCoreOption } from '../charts/echarts.ts';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { tipRow } from '../charts/mirroredStack.ts';
import { CATEGORICAL } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { ChartLayout } from '../components/ChartLayout.tsx';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { useGeoEpoch } from '../geoStatus.ts';
import { Link, navigate, setSearchParams, useSearch } from '../router.ts';
import { processCallsRange } from '../history/callsSeries.ts';
import {
  BEACON_FOCUS_PARAM,
  BEACON_SCOPE_PARAM,
  BEACONS_PANEL_ID,
  focusRows,
  scrollStart,
  bytesExtent,
  dotData,
  dotSize,
  fmtPeriod,
  gapText,
  historyHref,
  isPeriodic,
  parseBeaconScope,
  periodText,
  rowLabels,
  scopeRange,
} from './beaconStrip.ts';
import { fontPx } from '../charts/fonts.ts';

/** Rows shown before the strip scrolls (slider on the right). */
const VISIBLE_ROWS = 30;
const ROW_PX = 20;
const GRID = { left: 236, right: 214, top: 8, bottom: 34 };
/** Scatter switches to ECharts' large mode (one size and color for all dots) past this. */
const LARGE_THRESHOLD = 5000;
/** The table shows this many rows until expanded. */
const TABLE_ROWS = 15;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Sep 19" for the tooltip, next to the time with seconds. */
const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** History throughput for one destination, from the top of the page. */
function openHistory(dest: string, range: TimeRange) {
  navigate(historyHref(dest, range));
  scrollTo(0, 0);
}

type Dot = [number, number, number, number | null];

function StripChart({ d, range, focus }: { d: BeaconsResponse; range: TimeRange; focus: readonly number[] }) {
  const scheme = useColorScheme();
  const dests = d.dests;
  const labels = useMemo(() => rowLabels(dests), [dests]);
  const scroll = dests.length > VISIBLE_ROWS;
  const focusKey = focus.join(',');

  const option = useMemo<EChartsCoreOption>(() => {
    const ink = cssVar('--text');
    const muted = cssVar('--muted');
    const accent = cssVar('--accent');
    const onAccent = cssVar('--surface');
    const axisLine = cssVar('--chart-axis');
    const grid = cssVar('--chart-grid');
    const color = CATEGORICAL[scheme][0]!;
    const data = dotData(dests);
    const [lo, hi] = bytesExtent(dests);
    const large = data.length > LARGE_THRESHOLD;
    // A focused address (17) is scrolled into view, its rows' labels and dots in the accent color.
    const focused = new Set(focus);
    const first = focus.length && scroll ? scrollStart(focus[0]!, dests.length, VISIBLE_ROWS) : 0;
    const last = first + Math.min(dests.length, VISIBLE_ROWS) - 1;
    const focusedLabels = new Set(focus.map((i) => labels[i]));
    const byLabel = new Map(labels.map((l, i) => [l, dests[i]!]));
    const tip = (p: { data: Dot }) => {
      const [t, row, bytes, gap] = p.data;
      const dest = dests[row]!;
      const bin = dest.binned_ms;
      return (
        `<div class="tip"><div class="tip-time">${esc(fmtDay(t))} ${esc(fmtTime(t, 'time'))}</div>` +
        `<div class="tip-head"><span>${esc(labels[row]!)}</span></div>` +
        tipRow(color, bin ? `bytes in ${fmtDuration(bin)}` : 'bytes', fmtBytes(bytes)) +
        tipRow('transparent', 'gap', esc(gapText(gap))) +
        `<div class="tip-foot muted">${esc(periodText(dest))}${dest.score > 0 ? ` · score ${dest.score.toFixed(2)}` : ''} · click: History for this destination</div></div>`
      );
    };
    return {
      animation: false,
      grid: { ...GRID, right: GRID.right + (scroll ? 24 : 0) },
      xAxis: {
        type: 'time',
        min: range.from,
        max: range.to,
        axisLine: { lineStyle: { color: axisLine } },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'category',
          inverse: true,
          data: labels,
          triggerEvent: true,
          axisTick: { show: false },
          axisLine: { lineStyle: { color: axisLine } },
          axisLabel: {
            interval: 0,
            width: GRID.left - 12,
            overflow: 'truncate',
            color: ink,
            fontSize: fontPx(12),
            formatter: (v: string) => (focusedLabels.has(v) ? `{focus|${v}}` : v),
            rich: { focus: { color: accent, fontWeight: 700, fontSize: fontPx(12) } },
          },
          splitLine: { show: true, lineStyle: { color: grid } },
        },
        {
          type: 'category',
          inverse: true,
          position: 'right',
          data: labels,
          axisTick: { show: false },
          axisLine: { show: false },
          axisLabel: {
            interval: 0,
            fontSize: fontPx(12),
            color: muted,
            formatter: (v: string) => {
              const dest = byLabel.get(v);
              if (!dest) return '';
              const text = `{txt|${periodText(dest)}}`;
              return isPeriodic(dest) ? `{badge|periodic} ${text}` : text;
            },
            rich: {
              txt: { color: muted, fontSize: fontPx(12) },
              badge: { color: onAccent, backgroundColor: accent, borderRadius: 3, padding: [1, 4], fontSize: fontPx(12), fontWeight: 600 },
            },
          },
        },
      ],
      dataZoom: [
        // Drag pans time, ctrl+wheel zooms it; plain wheel still scrolls the page.
        { type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: true },
        ...(scroll
          ? [
              { type: 'inside', yAxisIndex: [0, 1], filterMode: 'none', zoomOnMouseWheel: false, moveOnMouseWheel: 'shift', moveOnMouseMove: false, startValue: first, endValue: last },
              {
                type: 'slider',
                yAxisIndex: [0, 1],
                filterMode: 'none',
                width: 14,
                right: 8,
                top: GRID.top,
                bottom: GRID.bottom,
                brushSelect: false,
                showDetail: false,
                zoomLock: true,
                startValue: first,
                endValue: last,
              },
            ]
          : []),
      ],
      tooltip: { trigger: 'item', confine: true, formatter: tip },
      series: [
        {
          id: 'beacon:dots',
          type: 'scatter',
          data,
          encode: { x: 0, y: 1 },
          symbolSize: (v: Dot) => dotSize(v[2], lo, hi),
          large,
          largeThreshold: LARGE_THRESHOLD,
          itemStyle: focused.size && !large ? { color: (p: { data: Dot }) => (focused.has(p.data[1]) ? accent : color), opacity: 0.75 } : { color, opacity: 0.75 },
          emphasis: { scale: 1.6 },
          cursor: 'pointer',
        },
      ],
    };
    // focusKey stands for `focus`.
  }, [dests, labels, range, scheme, scroll, focusKey]);

  const onEvents = useMemo(
    () => ({
      click: (p: { componentType?: string; data?: Dot; value?: string }) => {
        const dest = p.componentType === 'series' && p.data ? dests[p.data[1]] : p.componentType === 'yAxis' ? dests[labels.indexOf(String(p.value))] : undefined;
        if (dest) openHistory(dest.dest, range);
      },
    }),
    [dests, labels, range],
  );

  const height = Math.min(dests.length, VISIBLE_ROWS) * ROW_PX + GRID.top + GRID.bottom + 8;
  return <EChart option={option} onEvents={onEvents} height={Math.max(height, 120)} ariaLabel="Active ticks per destination over time" />;
}

function footnote(d: BeaconsResponse | null, scope: BeaconScope, cut: boolean): string {
  const parts = ['one dot per active collector tick (default 1 s): beacons faster than 2 s look continuous'];
  if (d) {
    parts.unshift(`${fmtTime(d.from)} – ${fmtTime(d.to)}`);
    if (d.capped || cut) parts.push(scope === 'name' ? 'cut to the last 6 h (all instances scan by time)' : 'cut to the last 24 h');
    if (d.truncated) parts.push(`the ${d.dests.length} destinations with the most active ticks`);
    const bin = d.dests.find((x) => x.binned_ms)?.binned_ms;
    if (bin) parts.push(`busy rows merged into ${fmtDuration(bin)} bins`);
  }
  return parts.join(' · ');
}

/**
 * 15: one row per destination with a dot for every tick that had traffic to
 * it (this instance, or every instance of its name over up to 6 h), each row's
 * period and spread on the right, then a table of the destinations, periodic
 * ones first.
 */
export function ProcessBeacons({ p }: { p: ProcessInfo }) {
  const scope = parseBeaconScope(new URLSearchParams(useSearch()).get(BEACON_SCOPE_PARAM));
  const [now] = useState(() => Date.now());
  const base = useMemo(() => processCallsRange(p, now), [p, now]);
  const range = useMemo(() => scopeRange(base, scope), [base, scope]);
  const cut = range.from !== base.from;
  const url = scope === 'name' ? urls.historyBeacons(p.name, range) : urls.processBeacons(String(p.pid), p.start_ns, range);
  const q = useQuery<BeaconsResponse>(url, useGeoEpoch());
  const d = q.data ?? null;
  const shown: TimeRange = d ? { from: d.from, to: d.to } : range;
  const periodic = d ? d.dests.filter(isPeriodic).length : 0;
  const focusIp = new URLSearchParams(useSearch()).get(BEACON_FOCUS_PARAM);
  const focus = useMemo(() => (d ? focusRows(d.dests, focusIp) : []), [d, focusIp]);
  const clearFocus = () => setSearchParams({ [BEACON_FOCUS_PARAM]: null }, { replace: true });

  const control = (
    <SegmentedControl<BeaconScope>
      label="Beaconing scope"
      options={[
        { value: 'instance', label: 'instance', title: 'This instance over its traffic window (up to the last 24 h)' },
        { value: 'name', label: `all ${p.name}`, title: `Every instance of ${p.name}, merged per destination (up to the last 6 h)` },
      ]}
      value={scope}
      onChange={(v) => setSearchParams({ [BEACON_SCOPE_PARAM]: v === 'instance' ? null : v }, { replace: true })}
    />
  );

  return (
    <>
      <Panel
        title="Beaconing"
        subtitle={
          <>
            One row per destination, a dot for every tick with traffic to it (size: log bytes). Evenly spaced dots are periodic traffic: telemetry,
            heartbeats, polling. Right: the median gap between bursts (runs of consecutive ticks) and its spread (cv)
            {d && periodic > 0 ? `; ${periodic} periodic` : ''}. Click a row for its History
          </>
        }
        footnote={
          focusIp ? (
            <>
              {footnote(d, scope, cut)} ·{' '}
              {d && focus.length === 0 ? `${focusIp} has no traffic in this window` : `${focusIp} highlighted`}{' '}
              <button type="button" className="link-button" onClick={clearFocus}>
                clear
              </button>
            </>
          ) : (
            footnote(d, scope, cut)
          )
        }
        id={BEACONS_PANEL_ID}
        wide
        loading={q.loading}
        error={q.error}
        empty={d && !q.stale && d.dests.length === 0 ? `No traffic recorded ${scope === 'name' ? `for ${p.name}` : 'for this instance'} in this window.` : undefined}
      >
        {d && d.dests.length > 0 && (
          <ChartLayout side={control}>
            <StripChart d={d} range={shown} focus={focus} />
          </ChartLayout>
        )}
      </Panel>
      {d && d.dests.length > 0 && <PeriodicTable dests={d.dests} range={shown} />}
    </>
  );
}

/** The destinations, periodic (score > 0.8) first: a lightweight periodic-connection detector. */
function PeriodicTable({ dests, range }: { dests: BeaconDest[]; range: TimeRange }) {
  const [all, setAll] = useState(false);
  const labels = useMemo(() => rowLabels(dests), [dests]);
  // The server sorts by score, then ticks: periodic rows come first already.
  const rows = all ? dests : dests.slice(0, TABLE_ROWS);
  return (
    <Panel
      title="Periodic connections"
      subtitle="A heuristic: a score is 1 − cv of the gaps between bursts, given at least 6 bursts and cv < 0.15. DNS refreshes, NTP, mDNS/SSDP announcements and health checks are legitimately periodic"
      footnote={null}
      wide
    >
      <div className="table-scroll">
        <table className="tt beacon-table">
          <thead>
            <tr>
              <th>Destination</th>
              <th>App</th>
              <th className="tt-num">Score</th>
              <th className="tt-num">Period</th>
              <th className="tt-num">cv</th>
              <th className="tt-num">Bursts</th>
              <th className="tt-num">Active ticks</th>
              <th className="tt-num">Bytes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => (
              <tr key={labels[i]} onClick={() => openHistory(d.dest, range)}>
                <td>
                  <Link href={historyHref(d.dest, range)} onClick={(e) => (e.stopPropagation(), scrollTo(0, 0))} title={`History for ${d.dest}`}>
                    <code>{d.dest}</code>
                  </Link>
                  {isPeriodic(d) && <span className="badge">periodic</span>}
                </td>
                <td>
                  {d.app} <span className="muted">{d.proto}</span>
                </td>
                <td className="tt-num">{d.score > 0 ? d.score.toFixed(2) : '—'}</td>
                <td className="tt-num">{d.period_s === null ? '—' : fmtPeriod(d.period_s)}</td>
                <td className="tt-num">{d.cv === null ? '—' : d.cv.toFixed(2)}</td>
                <td className="tt-num">{d.bursts.toLocaleString()}</td>
                <td className="tt-num">{d.ticks.toLocaleString()}</td>
                <td className="tt-num">{fmtBytes(d.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dests.length > TABLE_ROWS && (
        <button type="button" className="link-button" onClick={() => setAll(!all)}>
          {all ? `Show the first ${TABLE_ROWS}` : `Show all ${dests.length}`}
        </button>
      )}
    </Panel>
  );
}
