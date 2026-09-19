import { useMemo, useRef } from 'react';
import type { TreemapDir, TreemapResponse } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtBytes } from '../charts/format.ts';
import { CATEGORICAL } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Panel } from '../components/Panel.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { setSearchParams, useSearch } from '../router.ts';
import {
  DIR_PARAM,
  parseDir,
  parseView,
  pathText,
  ROOT_SLOT,
  ROOT_UID,
  seriesData,
  shareText,
  UNKNOWN_UID,
  VIEW_PARAM,
  type NodeInfo,
  type TreemapView,
} from './treemapData.ts';

const DIR_OPTIONS = [
  { value: 'total', label: 'total', title: 'Bytes sent + received' },
  { value: 'tx', label: 'sent', title: 'Bytes sent (tx)' },
  { value: 'rx', label: 'received', title: 'Bytes received (rx)' },
] as const;
const VIEW_OPTIONS = [
  { value: 'treemap', label: 'treemap', title: 'Rectangles: area is bytes; click to drill into a user or process' },
  { value: 'sunburst', label: 'sunburst', title: 'Rings: users, processes, apps; reads better on a narrow screen' },
] as const;

const DIR_NOUN: Record<TreemapDir, string> = { total: 'Bytes sent + received', tx: 'Bytes sent', rx: 'Bytes received' };
const LEVEL_NOUN: Record<NodeInfo['kind'], string> = { user: 'user', proc: 'process', app: 'app' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Props = {
  range: TimeRange;
  filters: Partial<Record<'name' | 'app' | 'proto' | 'uid' | 'dest', string>>;
};

/** The node the treemap is currently drilled into (ECharts internals: no public getter). */
function viewRoot(chart: EChartsType | null) {
  const series = (chart as any)?.getModel?.().getSeriesByIndex(0);
  return series?.getViewRoot?.() as { dataIndex: number; parentNode?: unknown } | undefined;
}

type NodeParams = {
  name?: string;
  value?: number;
  data?: { info?: NodeInfo };
  treePathInfo?: { name: string; value: number | number[] }[];
};

/**
 * 07: what used the bandwidth over the page range, as nested rectangles
 * (area = bytes): user → process name → app. Users have a color each, root
 * always red; a user's processes vary in shade by bytes. Click drills in, the
 * breadcrumb goes back out. `tm=sunburst` shows the same tree as rings.
 * URL: `tm=sunburst`, `tm_dir=tx|rx`.
 */
export function BandwidthTreemap({ range, filters }: Props) {
  const search = new URLSearchParams(useSearch());
  const view = parseView(search.get(VIEW_PARAM));
  const dir = parseDir(search.get(DIR_PARAM));
  const q = useQuery<TreemapResponse>(urls.historyTreemap(range, { dir, filters }));
  const scheme = useColorScheme();
  const d = q.data;
  // Whether the pointer is over a node with nothing to drill into. The treemap
  // has no per-node nodeClick, so the panel swallows those clicks itself.
  const overLeaf = useRef(false);
  // Whether it is over the drilled-into node itself (its header or border, the
  // container around the children): a click there rolls back up one level.
  const overRoot = useRef(false);
  const chartRef = useEChartRef();
  const events = useMemo(
    () => ({
      mouseover: (p: NodeParams & { dataIndex?: number }) => {
        overLeaf.current = p.data?.info?.kind === 'app' || (p.data as { nodeClick?: unknown } | undefined)?.nodeClick === false;
        const root = viewRoot(chartRef.current);
        overRoot.current = !!root?.parentNode && root.dataIndex === p.dataIndex;
      },
      mouseout: () => {
        overLeaf.current = false;
        overRoot.current = false;
      },
    }),
    [chartRef],
  );

  const option = useMemo<EChartsCoreOption>(() => {
    const surface = cssVar('--surface');
    const muted = cssVar('--muted');
    const text = cssVar('--text');
    const border = cssVar('--border');
    const total = d?.total ?? 0;
    const users = d?.users ?? [];
    const tip = (p: NodeParams) => {
      const info = p.data?.info;
      if (!info) return '';
      const value = p.value ?? 0;
      const path = p.treePathInfo ?? [];
      const parent = path.length > 2 ? path[path.length - 2] : undefined;
      const parentValue = parent ? Number(Array.isArray(parent.value) ? parent.value[0] : parent.value) : 0;
      const who =
        info.uid === UNKNOWN_UID ? 'process not in the processes table' : info.uid === ROOT_UID ? 'uid 0 (root)' : `uid ${info.uid}`;
      return (
        `<div class="tip"><div class="tip-head"><span>${esc(pathText(path) || (p.name ?? ''))}</span><span class="tip-num muted">${LEVEL_NOUN[info.kind]}</span></div>` +
        `<div class="tip-row"><span class="tip-name">${fmtBytes(value)}</span><span class="tip-num">${shareText(value, total)} of all</span></div>` +
        (parent ? `<div class="tip-row"><span class="tip-name"></span><span class="tip-num muted">${shareText(value, parentValue)} of ${esc(parent.name)}</span></div>` : '') +
        (info.folded ? `<div class="tip-foot muted">${info.folded} smaller processes, summed</div>` : '') +
        `<div class="tip-foot muted">${esc(who)}</div></div>`
      );
    };
    const label = (p: NodeParams) => `${p.name}\n${fmtBytes(p.value ?? 0)}`;
    const series =
      view === 'treemap'
        ? {
            id: 'treemap',
            type: 'treemap',
            name: 'all users',
            data: seriesData(users, scheme),
            leafDepth: 2,
            roam: false,
            nodeClick: 'zoomToNode',
            visibleMin: 300,
            top: 0,
            left: 0,
            right: 0,
            bottom: 30,
            squareRatio: 0.5 * (1 + Math.sqrt(5)),
            breadcrumb: {
              show: true,
              left: 0,
              bottom: 0,
              height: 22,
              itemStyle: { color: surface, borderColor: border, borderWidth: 1, textStyle: { color: text } },
              emphasis: { itemStyle: { color: border, textStyle: { color: text } } },
            },
            label: { show: true, formatter: label, fontSize: 12, lineHeight: 15, overflow: 'truncate' },
            // The header strip of a node whose children are shown (a user, or a drilled-into process).
            upperLabel: {
              show: true,
              height: 20,
              color: '#fff',
              fontWeight: 600,
              overflow: 'truncate',
              formatter: (p: NodeParams) => `${p.name}  ${fmtBytes(p.value ?? 0)}`,
            },
            itemStyle: { borderColor: surface },
            levels: [
              // The series' own root: a gap between users.
              { itemStyle: { borderWidth: 0, gapWidth: 3 }, upperLabel: { show: false } },
              // Users: processes spread over a range by bytes, larger ones stronger. (ECharts'
              // colorSaturation actually sets HSL lightness; kept dark enough for white labels.)
              // The header strip is filled with the border color: a darker shade of the user's.
              { colorSaturation: [0.56, 0.4], itemStyle: { borderWidth: 3, gapWidth: 1, borderColorSaturation: 0.3 } },
              // Processes (the leaves until drilled into): apps vary again.
              { colorSaturation: [0.56, 0.4], itemStyle: { borderWidth: 2, gapWidth: 1, borderColorSaturation: 0.3 } },
              { itemStyle: { borderWidth: 1, borderColorSaturation: 0.5 } },
            ],
          }
        : {
            id: 'sunburst',
            type: 'sunburst',
            data: seriesData(users, scheme, true),
            nodeClick: 'rootToNode',
            radius: ['0%', '95%'],
            itemStyle: { borderColor: surface, borderWidth: 1 },
            label: { formatter: (p: NodeParams) => p.name ?? '', minAngle: 8, overflow: 'truncate', color: '#fff', fontSize: 11 },
            levels: [
              {},
              { r0: '14%', r: '44%', itemStyle: { borderWidth: 2 }, label: { rotate: 'tangential', fontWeight: 600, fontSize: 12 } },
              { r0: '44%', r: '74%', label: { rotate: 'radial', width: 80 } },
              { r0: '74%', r: '95%', label: { rotate: 'radial', width: 50, fontSize: 10 } },
            ],
          };
    return {
      animation: false,
      tooltip: { trigger: 'item', confine: true, formatter: tip, textStyle: { color: text }, borderColor: border },
      textStyle: { color: muted },
      series: [series],
    };
  }, [d, view, scheme]);

  const filtered = Object.values(filters).some((v) => v !== undefined);
  const root = d?.users.find((u) => u.uid === ROOT_UID);
  const subtitle = (
    <>
      {DIR_NOUN[dir]} per user, process name and app over the range
      {d ? ` (${d.table === 'flows' ? 'raw flows' : 'per-minute rollup'}${filtered ? ', filtered' : ''})` : ''}
      {d && d.total > 0 ? `: ${fmtBytes(d.total)}` : ''} · each user keeps its {d?.top ?? 30} largest processes, the rest summed ·{' '}
      <span style={{ color: CATEGORICAL[scheme][ROOT_SLOT] }}>
        ■
      </span>{' '}
      root{root ? ` ${shareText(root.value, d!.total)}` : ''} · click to drill in, click the outer frame or breadcrumb to go back{d?.truncated ? ' · only the largest rows were read' : ''}
    </>
  );

  const largest = d?.users[0];
  return (
    <Panel
      title="Bandwidth by user, process and app"
      subtitle={subtitle}
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && !d.users.length ? 'No traffic in this range.' : undefined}
      actions={
        <>
          <SegmentedControl<TreemapDir>
            label="Bytes"
            options={DIR_OPTIONS}
            value={dir}
            onChange={(v) => setSearchParams({ [DIR_PARAM]: v === 'total' ? null : v })}
          />
          <SegmentedControl<TreemapView>
            label="View"
            options={VIEW_OPTIONS}
            value={view}
            onChange={(v) => setSearchParams({ [VIEW_PARAM]: v === 'treemap' ? null : v })}
          />
        </>
      }
    >
      <div
        className="chart-wrap"
        onClickCapture={(e) => {
          if (view !== 'treemap') return;
          if (overRoot.current) {
            e.stopPropagation();
            overRoot.current = false;
            const parent = viewRoot(chartRef.current)?.parentNode;
            if (parent) chartRef.current!.dispatchAction({ type: 'treemapRootToNode', seriesId: 'treemap', targetNode: parent });
          } else if (overLeaf.current) e.stopPropagation();
        }}
      >
        <EChart
          onEvents={events}
          chartRef={chartRef}
          // The two views are different series types: re-create rather than merge.
          key={view}
          option={option}
          height={view === 'treemap' ? 440 : 480}
          ariaLabel={`${DIR_NOUN[dir]} per user, process and app${largest ? `; largest user ${largest.name} with ${fmtBytes(largest.value)} of ${fmtBytes(d!.total)}` : ''}`}
        />
      </div>
    </Panel>
  );
}
