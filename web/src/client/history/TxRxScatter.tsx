import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScatterBasis, ScatterGroup, ScatterPoint, ScatterResponse } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { OTHER, slotColor, type SlotAssigner } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { Link, navigate, setSearchParams, useSearch } from '../router.ts';
import { processPath } from './clusterMarkers.ts';
import {
  axisExtent,
  BASIS_PARAM,
  clamp1,
  colorSlots,
  fmtDecadeBytes,
  GROUP_PARAM,
  inRect,
  lifetimeMs,
  parseBasis,
  parseGroup,
  ratioText,
  refLines,
  symbolSize,
  topNames,
} from './scatterPoints.ts';

const GROUP_OPTIONS = [
  { value: 'instance', label: 'instance', title: 'One point per process instance (pid + start time)' },
  { value: 'name', label: 'name', title: 'One point per process name; size = number of instances' },
] as const;
const BASIS_OPTIONS = [
  { value: 'lifetime', label: 'lifetime', title: 'Lifetime totals of the processes that ran in the range' },
  { value: 'range', label: 'in range', title: 'Bytes sent and received within the range' },
] as const;

/** Rows listed under the chart for a brushed selection. */
const MAX_ROWS = 200;
const OTHER_ID = 'sc:other';
const REF_ID = 'sc:ref';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Props = {
  range: TimeRange;
  filters: Partial<Record<'name' | 'app' | 'proto' | 'uid' | 'dest', string>>;
  /** The page's SlotAssigner: a name keeps the color the page's other charts give it. */
  slots: SlotAssigner;
};

/**
 * 08: one point per process instance (or name), placed by bytes received (x)
 * and sent (y) on log axes. The diagonal separates uploaders from downloaders;
 * the dashed lines mark 10× either way. Drag a rectangle to list the points
 * under the chart; click a point to open the process page.
 * URL: `scatter_by=name`, `scatter_basis=range`.
 */
export function TxRxScatter({ range, filters, slots }: Props) {
  const search = new URLSearchParams(useSearch());
  const group = parseGroup(search.get(GROUP_PARAM));
  const basis = parseBasis(search.get(BASIS_PARAM));
  const q = useQuery<ScatterResponse>(urls.historyScatter(range, { group, basis, filters }));
  const scheme = useColorScheme();
  const chart = useEChartRef();
  const d = q.data;
  const points = d?.points;

  const [selected, setSelected] = useState<number[] | null>(null);
  // A new answer invalidates the selection (indexes into the old points).
  useEffect(() => {
    setSelected(null);
    chart.current?.dispatchAction({ type: 'brush', areas: [] });
  }, [points, chart]);

  // Axes, legend and series depend on the data; they are pushed with
  // replaceMerge (see push) so series of names that left the top 8 go away.
  const dynamic = useMemo(() => {
    const muted = cssVar('--muted');
    const pts = points ?? [];
    const grp = d?.group ?? group;
    const names = topNames(pts);
    const slotOf = colorSlots(names, (n) => slots.slot(n));
    const extent = axisExtent(pts);
    const item = (p: ScatterPoint, i: number) => ({ value: [clamp1(p.rx), clamp1(p.tx), i], symbolSize: symbolSize(grp, p.instances) });
    const byName = new Map<string, ReturnType<typeof item>[]>(names.map((n) => [n, []]));
    const rest: ReturnType<typeof item>[] = [];
    pts.forEach((p, i) => (byName.get(p.name) ?? rest).push(item(p, i)));
    const scatter = (id: string, name: string, color: string, data: ReturnType<typeof item>[]) => ({
      id,
      name,
      type: 'scatter',
      data,
      cursor: 'pointer',
      itemStyle: { color, opacity: 0.8, borderColor: 'rgba(0,0,0,0.25)', borderWidth: 0.5 },
      emphasis: { scale: 1.4, itemStyle: { opacity: 1 } },
      animation: false,
    });
    const axis = (name: string) => ({
      type: 'log',
      logBase: 10,
      min: extent[0],
      max: extent[1],
      name,
      nameLocation: 'middle',
      nameTextStyle: { color: muted },
      axisLabel: { formatter: fmtDecadeBytes },
      splitLine: { show: true, lineStyle: { opacity: 0.5 } },
      minorTick: { show: true, splitNumber: 9 },
    });
    const suffix = (d?.basis ?? basis) === 'lifetime' ? ' (lifetime) →' : ' (in range) →';
    const lines = refLines(extent);
    return {
      legend: { data: [...names, ...(rest.length ? ['other'] : [])] },
      xAxis: { ...axis(`received${suffix}`), nameGap: 30 },
      yAxis: { ...axis(`sent${suffix.replace(' →', ' ↑')}`), nameGap: 52 },
      series: [
        ...names.map((n) => {
          const slot = slotOf.get(n) ?? -1;
          return scatter(`sc:${n}`, n, slot >= 0 ? slotColor(slot, scheme) : OTHER[scheme], byName.get(n)!);
        }),
        scatter(OTHER_ID, 'other', OTHER[scheme], rest),
        {
          id: REF_ID,
          type: 'line',
          data: [],
          silent: true,
          tooltip: { show: false },
          markLine: {
            silent: true,
            animation: false,
            symbol: 'none',
            data: lines.map((l) => [
              {
                coord: l.from,
                lineStyle: { color: muted, type: l.id === 'even' ? 'solid' : 'dashed', width: 1, opacity: l.id === 'even' ? 0.7 : 0.6 },
                label: l.label ? { show: true, formatter: l.label, position: 'insideEndTop', color: muted, fontSize: 16 } : { show: false },
              },
              { coord: l.to },
            ]),
          },
        },
      ],
    };
  }, [points, d?.group, d?.basis, group, basis, scheme, slots]);

  const option = useMemo<EChartsCoreOption>(() => {
    const muted = cssVar('--muted');
    return {
      animation: false,
      grid: { left: 72, right: 24, top: 36, bottom: 52 },
      legend: { top: 0, left: 0, type: 'scroll' },
      xAxis: { type: 'log' },
      yAxis: { type: 'log' },
      // tipAt reads the latest data through a ref.
      tooltip: { trigger: 'item', confine: true, formatter: (p: { value?: [number, number, number] }) => tipAt(p.value?.[2]) },
      brush: {
        xAxisIndex: 0,
        yAxisIndex: 0,
        brushType: 'rect',
        brushMode: 'single',
        transformable: false,
        brushStyle: { color: 'rgba(128,128,128,0.15)', borderColor: muted, borderWidth: 1 },
        outOfBrush: { colorAlpha: 0.2 },
      },
    };
    // scheme re-reads the theme's colors.
  }, [scheme]);

  const push = (c: EChartsType | null) => c?.setOption(dynamic, { replaceMerge: ['series'] });
  useEffect(() => push(chart.current), [dynamic, chart]);

  const latest = useRef({ points, group: d?.group ?? group });
  latest.current = { points, group: d?.group ?? group };
  const tipAt = (i: number | undefined) => {
    const { points: pts, group: grp } = latest.current;
    const p = i === undefined ? undefined : pts?.[i];
    return p ? tooltip(p, grp) : '';
  };

  const onInit = (c: EChartsType) => {
    push(c);
    // Dragging draws a selection rectangle; a click still hits a point.
    c.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'rect', brushMode: 'single' } });
    c.on('brushEnd', (e: any) => {
      const area = e.areas?.[0]?.coordRange as [[number, number], [number, number]] | undefined;
      const pts = latest.current.points;
      setSelected(area && pts ? inRect(pts, area) : null);
    });
  };

  const onEvents = useMemo(
    () => ({
      click: (p: { seriesId?: string; value?: [number, number, number] }) => {
        if (!p.seriesId?.startsWith('sc:') || p.seriesId === REF_ID) return;
        const pt = p.value && latest.current.points?.[p.value[2]];
        if (pt) navigate(processPath(pt.id));
      },
    }),
    [],
  );

  const clear = () => {
    chart.current?.dispatchAction({ type: 'brush', areas: [] });
    setSelected(null);
  };

  const noun = group === 'name' ? 'process names' : 'process instances';
  const filtered = Object.values(filters).some((v) => v !== undefined);
  const subtitle = (
    <>
      {basis === 'lifetime'
        ? 'Lifetime totals of the processes that ran in the range (counted since the collector first saw them)'
        : `Bytes within the range${d ? ` from ${d.table === 'flows' ? 'raw flows' : 'the per-minute rollup'}` : ''}`}
      {filtered ? ', only processes with matching traffic in the range' : ''}
      {d?.truncated ? ` · the largest ${d.points.length} ${noun}` : ''} · drag a rectangle to list processes, click a point to open it
    </>
  );

  const rows = selected && points ? selected.slice(0, MAX_ROWS).map((i) => points[i]!) : null;

  return (
    <Panel
      title="Sent vs received"
      subtitle={subtitle}
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && !d.points.length ? 'No process traffic in this range.' : undefined}
      actions={
        <>
          <SegmentedControl<ScatterGroup>
            label="Point per"
            options={GROUP_OPTIONS}
            value={group}
            onChange={(v) => setSearchParams({ [GROUP_PARAM]: v === 'instance' ? null : v })}
          />
          <SegmentedControl<ScatterBasis>
            label="Totals"
            options={BASIS_OPTIONS}
            value={basis}
            onChange={(v) => setSearchParams({ [BASIS_PARAM]: v === 'lifetime' ? null : v })}
          />
        </>
      }
    >
      <div className="chart-wrap">
        <EChart
          option={option}
          onEvents={onEvents}
          onInit={onInit}
          chartRef={chart}
          height={420}
          ariaLabel={`Bytes sent against bytes received per ${group === 'name' ? 'process name' : 'process instance'}, log scales: ${points?.length ?? 0} points`}
        />
      </div>
      {rows && (
        <div className="scatter-selection">
          <p className="scatter-selection-head">
            <span>
              {selected!.length} selected{selected!.length > MAX_ROWS ? `, the largest ${MAX_ROWS} listed` : ''}
            </span>
            <button type="button" className="chip-clear" onClick={clear}>
              clear selection
            </button>
          </p>
          {rows.length > 0 && <SelectionTable rows={rows} group={d?.group ?? group} />}
        </div>
      )}
    </Panel>
  );
}

function SelectionTable({ rows, group }: { rows: ScatterPoint[]; group: ScatterGroup }) {
  return (
    <div className="table-scroll">
      <table className="tt">
        <thead>
          <tr>
            <th>process</th>
            <th className="tt-num">{group === 'name' ? 'instances' : 'pid'}</th>
            <th>user</th>
            <th className="tt-num">sent</th>
            <th className="tt-num">received</th>
            <th className="tt-num">ratio</th>
            <th className="tt-num">{group === 'name' ? 'span' : 'lifetime'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const life = lifetimeMs(p);
            return (
              <tr key={p.id} onClick={(e) => !(e.target as HTMLElement).closest('a') && navigate(processPath(p.id))}>
                <td className="tt-name">
                  <Link href={processPath(p.id)} className="tt-proc">
                    {p.name}
                  </Link>
                  {p.cmdline && (
                    <div className="tt-cmd" title={p.cmdline}>
                      {p.cmdline}
                    </div>
                  )}
                </td>
                <td className="num tt-num">{group === 'name' ? p.instances : p.pid}</td>
                <td>{p.user ?? <span className="muted">{p.uid === 4294967295 ? 'unknown' : p.uid}</span>}</td>
                <td className="num tt-num">{fmtBytes(p.tx)}</td>
                <td className="num tt-num">{fmtBytes(p.rx)}</td>
                <td className="num tt-num">{ratioText(p.tx, p.rx)}</td>
                <td className="num tt-num">
                  {life === null ? <span className="muted">—</span> : fmtDuration(life)}
                  {p.endedMs === null && p.startMs !== null && <span className="muted"> (running)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A point's tooltip: name, pid or instance count, cmdline, ↑/↓ totals, ratio, lifetime. */
function tooltip(p: ScatterPoint, group: ScatterGroup): string {
  const who = group === 'name' ? `${p.instances} instance${p.instances === 1 ? '' : 's'}` : `pid ${p.pid}`;
  const user = p.user ? ` · ${esc(p.user)}` : '';
  const zero = (v: number) => (v === 0 ? ' <span class="muted">(0, drawn at 1 B)</span>' : '');
  const life = lifetimeMs(p);
  const lifeText =
    p.startMs === null
      ? 'process details unknown'
      : `${group === 'name' ? 'first start' : 'started'} ${esc(fmtTime(p.startMs))}` +
        (life === null ? '' : `, ${p.endedMs === null ? 'running' : 'ran'} ${fmtDuration(life)}${p.endedMs === null ? ' (to last I/O)' : ''}`);
  return (
    `<div class="tip"><div class="tip-head"><span>${esc(p.name)}</span><span class="tip-num muted">${who}${user}</span></div>` +
    (p.cmdline ? `<div class="tip-cmd muted" style="padding-left:0">${esc(cut(p.cmdline, 100))}</div>` : '') +
    `<div class="tip-row"><span class="tip-name">↑ sent</span><span class="tip-num">${fmtBytes(p.tx)}${zero(p.tx)}</span></div>` +
    `<div class="tip-row"><span class="tip-name">↓ received</span><span class="tip-num">${fmtBytes(p.rx)}${zero(p.rx)}</span></div>` +
    `<div class="tip-row"><span class="tip-name">ratio</span><span class="tip-num">${ratioText(p.tx, p.rx)}</span></div>` +
    `<div class="tip-foot muted">${lifeText}</div>` +
    `<div class="tip-foot muted">click: open ${group === 'name' ? 'the busiest instance' : 'the process page'}</div></div>`
  );
}
