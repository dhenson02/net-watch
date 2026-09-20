import { useMemo, useRef, useState } from 'react';
import type { FlowAgg, HistoryFlowsResponse, LiveFlowsResponse } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { ChartLayout } from '../components/ChartLayout.tsx';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { usePoll } from '../hooks/usePoll.ts';
import { useQuery } from '../hooks/useQuery.ts';
import { useGeoEpoch } from '../geoStatus.ts';
import { navigate, setSearchParams, useSearchParam } from '../router.ts';
import { buildSankey, type FlowDir, type SankeyGraph, type SankeyNode } from './buildSankey.ts';
import { EChart } from './EChart.tsx';
import type { EChartsCoreOption } from './echarts.ts';
import { fmtBytes, fmtRate, fmtTime } from './format.ts';
import { appColor, OTHER, slotColor, type Scheme, type SlotAssigner } from './palette.ts';
import { useColorScheme } from './useColorScheme.ts';
import { fontPx } from './fonts.ts';

/** Live mode averages this many seconds of ticks, refreshed every 2 s. */
const LIVE_SECONDS = 10;
const LIVE_POLL_MS = 2000;

/** The History page's destination filter (one of its `filter.*` params, see history/useThroughput.ts). */
export const DEST_PARAM = 'filter.dest';

const DIR_OPTIONS = [
  { value: 'both', label: 'both', title: 'Sent plus received' },
  { value: 'tx', label: '↑ sent' },
  { value: 'rx', label: '↓ received' },
] as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Mode = 'live' | 'history';

/** Rates in live mode (kbps), byte totals in history mode. */
const formatter = (mode: Mode) => (mode === 'live' ? fmtRate : fmtBytes);

/** Opens a process node's busiest instance. */
function openProcess(id: string) {
  const i = id.indexOf(':');
  navigate(`/process/${id.slice(0, i)}/${id.slice(i + 1)}`);
}

/** Node color: processes by the page's slot map, apps by a fixed hue, destinations grey. */
function nodeColor(n: SankeyNode, slots: Map<string, number>, scheme: Scheme): string {
  if (n.kind === 'proc') return n.bucket ? OTHER[scheme] : slotColor(slots.get(n.label) ?? -1, scheme);
  if (n.kind === 'app') return appColor(n.label, scheme);
  return OTHER[scheme];
}

function breakdown(v: { tx: number; rx: number }, dir: FlowDir, fmt: (n: number) => string): string {
  return dir === 'both' ? ` <span class="muted">(↑ ${fmt(v.tx)} · ↓ ${fmt(v.rx)})</span>` : '';
}

type Props = {
  flows: readonly FlowAgg[];
  mode: Mode;
  dir: FlowDir;
  slots: SlotAssigner;
  /** A destination node was clicked (`ip:port`). */
  onDest: (dest: string) => void;
  /** 18: destinations collapsed to one node per ASN (flows with `geo`). */
  byAsn?: boolean;
  /** An ASN node was clicked. */
  onAsn?: (asn: number) => void;
};

/**
 * 03: process name → app protocol → destination. Link width is mean rate
 * (live) or bytes (history). Hovering a node highlights its neighbours;
 * clicking a process opens its busiest instance, clicking a destination
 * filters the History page to it.
 */
export function FlowSankey({ flows: incoming, mode, dir, slots, onDest, byAsn = false, onAsn }: Props) {
  const scheme = useColorScheme();
  // Live: hold the picture while the pointer is over the chart, so a refresh
  // does not drop the hover highlight or move the node being read.
  const [hovering, setHovering] = useState(false);
  const shown = useRef(incoming);
  if (!(hovering && mode === 'live')) shown.current = incoming;
  const flows = shown.current;
  const graph = useMemo(() => buildSankey(flows, { dir, byAsn }), [flows, dir, byAsn]);
  const procSlots = useMemo(() => {
    // Rank order: the largest process gets the first free slot.
    const procs = graph.nodes.filter((n) => n.kind === 'proc' && !n.bucket).sort((a, b) => b.value - a.value);
    return slots.assign(procs.map((n) => n.label));
  }, [graph, slots]);

  // Click and tooltip handlers read the latest graph without re-binding.
  const latest = useRef<{ graph: SankeyGraph; onDest: (d: string) => void; onAsn?: (asn: number) => void }>({ graph, onDest, onAsn });
  latest.current = { graph, onDest, onAsn };

  const option = useMemo<EChartsCoreOption>(() => {
    const fmt = formatter(mode);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const label = (id: string) => byId.get(id)?.label ?? id;
    const tooltip = (p: any): string => {
      if (p.dataType === 'edge') {
        const l = p.data as { source: string; target: string; value: number; tx: number; rx: number };
        return `${esc(label(l.source))} → ${esc(label(l.target))}: <b>${fmt(l.value)}</b>${breakdown(l, dir, fmt)}`;
      }
      const n = byId.get(p.name as string);
      if (!n) return '';
      const hint =
        n.kind === 'proc' && n.target
          ? 'click to open its busiest instance'
          : n.kind === 'dest' && n.target
            ? `click to ${mode === 'live' ? 'open History filtered to it' : 'filter this page to it'}`
            : n.asn !== undefined
              ? 'click to list its destinations'
              : '';
      const share = graph.total > 0 ? ` · ${((n.value / graph.total) * 100).toFixed(1)}%` : '';
      return (
        `<b>${esc(n.label)}</b>: ${fmt(n.value)}${share}${breakdown(n, dir, fmt)}` + (hint ? `<div class="muted" style="font-size:11px">${hint}</div>` : '')
      );
    };
    return {
      // Live refreshes every 2 s; animating each relayout would be busy.
      animation: mode === 'history',
      tooltip: { trigger: 'item', confine: true, formatter: tooltip },
      series: [
        {
          id: 'flows',
          type: 'sankey',
          left: 8,
          top: 8,
          bottom: 8,
          right: 150,
          nodeAlign: 'justify',
          nodeWidth: 14,
          nodeGap: 10,
          // History uses ECharts' relaxation for the fewest crossings. Live keeps
          // buildSankey's deterministic order: relaxing on every refresh
          // reshuffles nodes as their values drift.
          layoutIterations: mode === 'history' ? 32 : 0,
          draggable: false,
          emphasis: { focus: 'adjacency' },
          lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.35 },
          label: { fontSize: fontPx(12), formatter: (p: { name: string }) => label(p.name) },
          data: graph.nodes.map((n) => ({
            name: n.id,
            depth: n.depth,
            value: n.value,
            itemStyle: { color: nodeColor(n, procSlots, scheme), borderWidth: 0 },
          })),
          links: graph.links.map((l) => ({ ...l })),
        },
      ],
    };
  }, [graph, procSlots, scheme, mode, dir]);

  const onEvents = useMemo(
    () => ({
      click: (p: any) => {
        if (p.dataType !== 'node') return;
        const n = latest.current.graph.nodes.find((x) => x.id === p.name);
        if (n?.asn !== undefined) latest.current.onAsn?.(n.asn);
        if (!n?.target) return;
        if (n.kind === 'proc') openProcess(n.target);
        else if (n.kind === 'dest') latest.current.onDest(n.target);
      },
    }),
    [],
  );

  // Tall enough for the busiest column.
  const perLayer = [0, 0, 0];
  for (const n of graph.nodes) perLayer[n.depth]!++;
  const height = Math.min(640, Math.max(280, Math.max(...perLayer) * 26 + 24));

  return (
    // onMouseMove, not onMouseEnter: the pointer may already be there when the chart mounts.
    <div onMouseMove={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
      <EChart option={option} onEvents={onEvents} height={height} ariaLabel="Traffic from process names through application protocols to destinations" />
    </div>
  );
}

function useDir(): [FlowDir, (d: FlowDir) => void] {
  const [raw, set] = useSearchParam('flow_dir', 'both');
  const dir: FlowDir = raw === 'tx' || raw === 'rx' ? raw : 'both';
  return [dir, (d) => set(d, { replace: true })];
}

/** 18: `flow_asn=1` collapses destinations to one node per ASN. */
function useByAsn(): [boolean, (v: boolean) => void] {
  const [raw, set] = useSearchParam('flow_asn', '0');
  return [raw === '1', (v) => set(v ? '1' : '0', { replace: true })];
}

const ASN_OPTIONS = [
  { value: 'ip', label: 'ip:port' },
  { value: 'asn', label: 'ASN', title: 'One node per network (ASN) instead of per address; local and unknown addresses stay as they are' },
] as const;

/** The toggle, shown only when some flow carries geo (a geo table is loaded). */
function AsnControl({ flows, byAsn, onChange }: { flows: readonly FlowAgg[] | undefined; byAsn: boolean; onChange: (v: boolean) => void }) {
  if (!flows?.some((f) => f.geo)) return null;
  return (
    <SegmentedControl<'ip' | 'asn'> label="Destination nodes" options={ASN_OPTIONS} value={byAsn ? 'asn' : 'ip'} onChange={(v) => onChange(v === 'asn')} />
  );
}

/** The Destinations page for one ASN, over `range` when given. */
function openAsn(asn: number, range?: TimeRange) {
  const p = new URLSearchParams(range ? { from: String(range.from), to: String(range.to) } : {});
  p.set('asn', String(asn));
  navigate(`/destinations?${p}`);
  scrollTo(0, 0);
}

const DirControl = ({ dir, onChange }: { dir: FlowDir; onChange: (d: FlowDir) => void }) => (
  <SegmentedControl label="Direction" options={DIR_OPTIONS} value={dir} onChange={onChange} />
);

const EXPLAIN: Record<Mode, string> = {
  live: 'hover to trace a path · click a process to open it, a destination to see its history',
  history: 'hover to trace a path · click a process to open it, a destination to filter to it',
};

/** The Sankey on the Live page: mean rates over the last 10 s, refreshed every 2 s. */
export function LiveFlowSankey({ slots }: { slots: SlotAssigner }) {
  const [dir, setDir] = useDir();
  const [byAsn, setByAsn] = useByAsn();
  const poll = usePoll<LiveFlowsResponse>(urls.liveFlows(LIVE_SECONDS), LIVE_POLL_MS);
  const d = poll.data;
  const onDest = (dest: string) => navigate(`/history?${new URLSearchParams({ [DEST_PARAM]: dest })}`);
  return (
    <Panel
      title="Who talks to what"
      subtitle={
        <>
          Mean rate over the last {d && d.ticks > 0 ? `${d.ticks} ticks` : `${LIVE_SECONDS} s`}
          {d?.ts ? ` (as of ${fmtTime(d.ts, 'time')})` : ''} · {EXPLAIN.live}
        </>
      }
      wide
      loading={!d && !poll.error}
      error={!d ? poll.error : null}
      empty={d && !d.flows.some((f) => f.tx + f.rx > 0) ? 'No traffic in the last ticks.' : undefined}
    >
      {d && (
        <ChartLayout
          side={
            <>
              <AsnControl flows={d?.flows} byAsn={byAsn} onChange={setByAsn} />
              <DirControl dir={dir} onChange={setDir} />
            </>
          }
        >
          <FlowSankey flows={d.flows} mode="live" dir={dir} slots={slots} onDest={onDest} byAsn={byAsn} onAsn={(asn) => openAsn(asn)} />
        </ChartLayout>
      )}
    </Panel>
  );
}

/** The Sankey on the History page: bytes over the selected range, with the page's filters. */
export function HistoryFlowSankey({ range, filters, slots }: { range: TimeRange; filters: Partial<Record<string, string>>; slots: SlotAssigner }) {
  const [dir, setDir] = useDir();
  const [byAsn, setByAsn] = useByAsn();
  const q = useQuery<HistoryFlowsResponse>(urls.historyFlows(range, filters), useGeoEpoch());
  const dest = filters.dest;
  const d = q.data;
  const onDest = (key: string) => setSearchParams({ [DEST_PARAM]: key });
  return (
    <Panel
      title="Who talks to what"
      subtitle={
        <>
          Bytes over the range{dest ? ` to ${dest}` : ''}
          {d?.truncated ? ` (largest ${d.flows.length} flows)` : ''} · {EXPLAIN.history}
        </>
      }
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !d.flows.length ? 'No traffic in this range.' : undefined}
    >
      {d && (
        <ChartLayout
          side={
            <>
              <AsnControl flows={d?.flows} byAsn={byAsn} onChange={setByAsn} />
              <DirControl dir={dir} onChange={setDir} />
            </>
          }
        >
          <FlowSankey flows={d.flows} mode="history" dir={dir} slots={slots} onDest={onDest} byAsn={byAsn} onAsn={(asn) => openAsn(asn, range)} />
        </ChartLayout>
      )}
    </Panel>
  );
}
