import { useMemo, useState } from 'react';
import type { BytesPerCallBy, BytesPerCallDir, BytesPerCallResponse, BytesPerCallRow, ProcessInfo } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption } from '../charts/echarts.ts';
import { fmtBytes, PAYLOAD_NOTE } from '../charts/format.ts';
import { tipRow } from '../charts/mirroredStack.ts';
import { RX, SEQUENTIAL, TX } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { ChartLayout } from '../components/ChartLayout.tsx';
import { ChartLegend, type LegendItem } from '../charts/ChartLegend.tsx';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { setSearchParams, useSearch } from '../router.ts';
import {
  BPC_BY_PARAM,
  BPC_DIR_PARAM,
  BUCKET_TICKS,
  bucketRange,
  cellText,
  fmtShare,
  heatCells,
  heatRows,
  meanNote,
  medianOf,
  medianX,
  parseBpcBy,
  parseBpcDir,
  rowLabel,
  shares,
} from './bytesPerCall.ts';
import { processCallsRange } from './callsSeries.ts';
import { fontPx } from '../charts/fonts.ts';

const DIR_OPTIONS = [
  { value: 'tx', label: 'sends', title: 'Bytes per send call' },
  { value: 'rx', label: 'receives', title: 'Bytes per receive call' },
] as const;
const BY_OPTIONS = [
  { value: 'app', label: 'app' },
  { value: 'name', label: 'process' },
] as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Filters = Partial<Record<'name' | 'app' | 'proto' | 'uid' | 'dest', string>>;

function useBpcParams() {
  const search = new URLSearchParams(useSearch());
  return { dir: parseBpcDir(search.get(BPC_DIR_PARAM)), by: parseBpcBy(search.get(BPC_BY_PARAM)) };
}

function DirControl({ dir }: { dir: BytesPerCallDir }) {
  return (
    <SegmentedControl<BytesPerCallDir>
      label="Calls"
      options={DIR_OPTIONS}
      value={dir}
      onChange={(v) => setSearchParams({ [BPC_DIR_PARAM]: v === 'tx' ? null : v })}
    />
  );
}

const footnote = (d: BytesPerCallResponse | null) => (d ? `${PAYLOAD_NOTE} · ${meanNote(d.table)}` : PAYLOAD_NOTE);
/** Empty buckets draw no bar (an outlined zero-height bar would still show a line). */
const nonZero = (v: number) => (v > 0 ? v : null);
const hasCalls =(d: BytesPerCallResponse) => d.total.totalCalls > 0;

/** A row's median as text: "median ≈ 1.4 KiB". */
function medianText(row: BytesPerCallRow): string | null {
  const m = medianOf(row.calls);
  if (!m) return null;
  return m.bucket >= BUCKET_TICKS.length - 1 ? 'median ≥ 1 MiB' : `median ≈ ${fmtBytes(m.bytes)}`;
}

/**
 * 10 on the History page: one row per app (or process name), the top 10 by
 * calls plus the rest and an "all" row; columns are log2 buckets of bytes per
 * call; color is the share of that row's calls, each row normalized to 100 %.
 * A dot marks each row's median. URL: `bpc_dir=rx`, `bpc_by=name`.
 */
export function HistoryBytesPerCall({ range, filters }: { range: TimeRange; filters: Filters }) {
  const { dir, by } = useBpcParams();
  const q = useQuery<BytesPerCallResponse>(urls.historyBytesPerCall(range, { dir, by, filters }));
  const scheme = useColorScheme();
  const d = q.data ?? null;

  const rows = useMemo(() => (d ? heatRows(d) : []), [d]);
  const option = useMemo<EChartsCoreOption | null>(() => {
    if (!d || !rows.length) return null;
    const muted = cssVar('--muted');
    const surface = cssVar('--surface');
    const text = cssVar('--text');
    const labels = rows.map((r) => rowLabel(r, d.by, d.folded));
    const { data, max } = heatCells(rows);
    const medians = rows.flatMap((r, y) => {
      const m = medianOf(r.calls);
      return m ? [[medianX(m), y, m.bytes]] : [];
    });
    const tip = (p: { seriesId?: string; value?: number[] }) => {
      const [x, y] = p.value ?? [];
      const row = y === undefined ? undefined : rows[y];
      if (!row || x === undefined) return '';
      const label = labels[y!]!;
      if (p.seriesId === 'bpc:median') {
        return `<div class="tip"><div class="tip-head"><span>${esc(label)}</span></div><div class="tip-foot muted">${esc(medianText(row) ?? '')} per call (calls-weighted, of ${row.totalCalls.toLocaleString()} calls)</div></div>`;
      }
      const b = x;
      const s = shares(row);
      return (
        `<div class="tip"><div class="tip-head"><span>${esc(cellText(label, row, b))}</span></div>` +
        tipRow(dir === 'tx' ? TX[scheme] : RX[scheme], 'calls', `${row.calls[b]!.toLocaleString()} · ${fmtShare(s.calls[b]!)}`) +
        tipRow(muted, 'bytes', `${fmtBytes(row.bytes[b]!)} · ${fmtShare(s.bytes[b]!)}`) +
        `<div class="tip-foot muted">${esc(label)}: ${row.totalCalls.toLocaleString()} calls, ${fmtBytes(row.totalBytes)}${medianText(row) ? `, ${esc(medianText(row)!)}` : ''}</div></div>`
      );
    };
    return {
      animation: false,
      grid: { left: 150, right: 16, top: 4, bottom: 64 },
      xAxis: {
        type: 'category',
        data: BUCKET_TICKS,
        name: dir === 'tx' ? 'bytes per send' : 'bytes per receive',
        nameLocation: 'middle',
        nameGap: 26,
        nameTextStyle: { color: muted },
        splitArea: { show: false },
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { interval: 1, hideOverlap: true },
      },
      yAxis: {
        type: 'category',
        data: labels,
        inverse: true,
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { width: 138, overflow: 'truncate', fontWeight: (v: string) => (v === 'all' ? 'bold' : 'normal') },
      },
      tooltip: { trigger: 'item', confine: true, formatter: tip },
      visualMap: {
        type: 'continuous',
        seriesIndex: 0,
        dimension: 2,
        min: 0,
        max: max || 1,
        calculable: false,
        orient: 'horizontal',
        right: 16,
        bottom: 0,
        itemWidth: 10,
        itemHeight: 160,
        text: [fmtShare(max || 1), '0 %'],
        formatter: (v: number) => fmtShare(v),
        textGap: 8,
        textStyle: { color: muted, fontSize: fontPx(12) },
        inRange: { color: [...SEQUENTIAL[scheme]] },
      },
      series: [
        {
          id: 'bpc:heat',
          type: 'heatmap',
          data,
          itemStyle: { borderColor: surface, borderWidth: 2, borderRadius: 2 },
          emphasis: { itemStyle: { borderColor: text, borderWidth: 1 } },
        },
        {
          id: 'bpc:median',
          name: 'median',
          type: 'scatter',
          data: medians,
          symbol: 'diamond',
          symbolSize: 9,
          itemStyle: { color: text, borderColor: surface, borderWidth: 1 },
          z: 3,
        },
      ],
    };
  }, [d, rows, dir, scheme]);

  const filtered = Object.values(filters).some((v) => v !== undefined);
  return (
    <Panel
      title="Bytes per call"
      subtitle={`Share of each ${by === 'app' ? 'app' : 'process'}'s ${dir === 'tx' ? 'send' : 'receive'} calls by bytes per call (log2 buckets), every row 100 %${filtered ? ', filtered' : ''}; ◆ median. Small calls are chatty traffic (RPC, keepalives, DNS), large ones bulk transfer`}
      footnote={footnote(d)}
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && !hasCalls(d) ? 'No calls in this range.' : undefined}
    >
      <ChartLayout
        side={
          <>
            <DirControl dir={dir} />
            <SegmentedControl<BytesPerCallBy>
              label="Rows"
              options={BY_OPTIONS}
              value={by}
              onChange={(v) => setSearchParams({ [BPC_BY_PARAM]: v === 'app' ? null : v })}
            />
          </>
        }
      >
        {option && (
          <EChart
            option={option}
            height={80 + rows.length * 28}
            ariaLabel={`Share of calls by bytes per call${d ? `; overall ${medianText(d.total) ?? 'no calls'}` : ''}`}
          />
        )}
      </ChartLayout>
    </Panel>
  );
}

/**
 * 10 on the Process page: this instance's calls (bars) and bytes (outlined)
 * per bucket of bytes per call, from raw flows over its traffic window, the
 * median marked. URL: `bpc_dir=rx`.
 */
export function ProcessBytesPerCall({ p }: { p: ProcessInfo }) {
  const { dir } = useBpcParams();
  const [now] = useState(() => Date.now());
  const range = useMemo(() => processCallsRange(p, now), [p, now]);
  const q = useQuery<BytesPerCallResponse>(urls.processBytesPerCall(String(p.pid), p.start_ns, range, dir));
  const scheme = useColorScheme();
  const d = q.data ?? null;

  const option = useMemo<EChartsCoreOption | null>(() => {
    if (!d) return null;
    const muted = cssVar('--muted');
    const text = cssVar('--text');
    const color = dir === 'tx' ? TX[scheme] : RX[scheme];
    const row = d.total;
    const s = shares(row);
    const m = medianOf(row.calls);
    const tip = (params: { dataIndex: number }[]) => {
      const b = params[0]?.dataIndex;
      if (b === undefined) return '';
      return (
        `<div class="tip"><div class="tip-head"><span>${esc(bucketRange(b))} per call</span></div>` +
        tipRow(color, 'calls', `${row.calls[b]!.toLocaleString()} · ${fmtShare(s.calls[b]!)}`) +
        tipRow(muted, 'bytes', `${fmtBytes(row.bytes[b]!)} · ${fmtShare(s.bytes[b]!)}`) +
        '</div>'
      );
    };
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 16, bottom: 44 },
      legend: { show: false, data: ['share of calls', 'share of bytes'] },
      xAxis: {
        type: 'category',
        data: BUCKET_TICKS,
        name: dir === 'tx' ? 'bytes per send' : 'bytes per receive',
        nameLocation: 'middle',
        nameGap: 28,
        nameTextStyle: { color: muted },
        axisTick: { alignWithLabel: true },
        axisLabel: { interval: 1, hideOverlap: true },
      },
      yAxis: { type: 'value', max: (v: { max: number }) => Math.min(1, Math.ceil(v.max * 10) / 10 || 1), axisLabel: { formatter: (v: number) => fmtShare(v) } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, formatter: tip },
      series: [
        {
          id: 'bpc:calls',
          name: 'share of calls',
          type: 'bar',
          data: s.calls.map(nonZero),
          color,
          barGap: '-100%',
          barCategoryGap: '20%',
          markLine: m
            ? {
                symbol: 'none',
                silent: true,
                lineStyle: { color: text, type: 'dashed', width: 1 },
                label: { formatter: medianText(row) ?? '', color: text, position: 'end' },
                data: [{ xAxis: medianX(m) }],
              }
            : undefined,
        },
        {
          id: 'bpc:bytes',
          name: 'share of bytes',
          type: 'bar',
          data: s.bytes.map(nonZero),
          color: 'transparent',
          itemStyle: { color: 'transparent', borderColor: muted, borderWidth: 1.5, borderType: 'solid' },
          barGap: '-100%',
          barCategoryGap: '20%',
        },
      ],
    };
  }, [d, dir, scheme]);

  const chart = useEChartRef();
  const legendItems = useMemo<LegendItem[]>(
    () => [
      { name: 'share of calls', color: dir === 'tx' ? TX[scheme] : RX[scheme] },
      { name: 'share of bytes', color: cssVar('--muted') },
    ],
    // cssVar reads the current theme's colors.
    [dir, scheme],
  );
  const median = d ? medianText(d.total) : null;
  return (
    <Panel
      title="Bytes per call"
      subtitle={`This instance's ${dir === 'tx' ? 'send' : 'receive'} calls by bytes per call (log2 buckets), over its traffic window${median ? `; ${median}` : ''}. Filled: share of calls; outlined: share of bytes. The gap between them is chatty vs bulk traffic`}
      footnote={footnote(d)}
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && !hasCalls(d) ? `No ${dir === 'tx' ? 'send' : 'receive'} calls recorded for this instance.` : undefined}
    >
      <ChartLayout
        side={
          <>
            <DirControl dir={dir} />
            <ChartLegend chart={chart} items={legendItems} title="Shown" />
          </>
        }
      >
        {option && <EChart option={option} chartRef={chart} height={300} ariaLabel={`Share of calls by bytes per call${median ? `; ${median}` : ''}`} />}
      </ChartLayout>
    </Panel>
  );
}
