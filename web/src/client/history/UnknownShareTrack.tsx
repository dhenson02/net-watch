import { useMemo, useRef, type RefObject } from 'react';
import type { ThroughputResponse } from '../../shared/api.ts';
import type { TimeRange } from '../api.ts';
import { cssVar } from '../charts/cssVar.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtDuration, fmtTime } from '../charts/format.ts';
import { GRID } from '../charts/mirroredStack.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { setSearchParams } from '../router.ts';
import { fmtShare, medianShare, sharePoints, UNKNOWN_DRILL, unknownText } from './unknownShare.ts';
import { useFollowZoom } from './useFollowZoom.ts';

/** The share's plot height (px), plus a little room above and below: 48 px in all. */
const TRACK = 40;
const PAD = 4;

type Props = {
  range: TimeRange;
  /** The throughput answer, requested with `unknown=1`; null while it loads. */
  answer: ThroughputResponse | null;
  /** The throughput chart above, whose zoom the track follows. */
  main: RefObject<EChartsType | null>;
};

/**
 * 16: the share of bytes the classifier labelled `unknown`, per bucket of the
 * throughput chart above, on a thin track under it (same time axis, follows
 * its zoom). Dashed: the range's median share. Clicking the track filters the
 * chart to unknown traffic stacked by destination.
 */
export function UnknownShareTrack({ range, answer, main }: Props) {
  const scheme = useColorScheme();
  const track = useEChartRef();
  useFollowZoom(main, track);

  const u = answer?.unknown ?? null;
  const median = useMemo(() => (u ? medianShare(u.share) : null), [u]);
  const latest = useRef({ answer });
  latest.current = { answer };

  const option = useMemo<EChartsCoreOption>(() => {
    const muted = cssVar('--muted');
    const warn = cssVar('--warn');
    const step = answer?.step ?? 60;
    const timeStyle = step < 60 ? 'time' : 'datetime';
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
        axisPointer: { label: { show: false } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 1,
        interval: 1,
        axisLabel: { fontSize: 10, color: muted, formatter: (v: number) => (v === 1 ? '100 %' : '0 %') },
        splitLine: { show: false },
      },
      // Driven by the chart above (useFollowZoom); a new range resets it like the chart does.
      dataZoom: [{ type: 'inside', xAxisIndex: 0, disabled: true, start: 0, end: 100 }],
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'line', lineStyle: { color: muted, type: 'dashed' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const a = latest.current.answer;
          const i = ps[0]?.dataIndex;
          if (!a?.unknown || i === undefined) return '';
          return (
            `<div class="tip"><div class="tip-time">${fmtTime(a.t[i]!, timeStyle)} <span class="muted">· ${fmtDuration(a.step * 1000)}</span></div>` +
            `<div>${unknownText(a.unknown, i)}</div><div class="tip-foot muted">click: list the unlabelled destinations</div></div>`
          );
        },
      },
      series: [
        {
          id: 'unknown:share',
          name: 'unknown share',
          type: 'line',
          // No symbols but on isolated points (see sharePoints).
          symbol: 'none',
          symbolSize: 4,
          connectNulls: false,
          lineStyle: { color: warn, width: 1.5 },
          itemStyle: { color: warn },
          areaStyle: { color: warn, opacity: 0.12 },
          data: answer && u ? sharePoints(answer.t, u) : [],
          markLine: {
            silent: true,
            animation: false,
            symbol: 'none',
            lineStyle: { color: muted, type: 'dashed', width: 1 },
            label: { show: false },
            data: median === null ? [] : [{ yAxis: median }],
          },
        },
      ],
    };
    // scheme re-reads the theme's colors.
  }, [answer, u, median, range.from, range.to, scheme]);

  const onClick = () => setSearchParams(UNKNOWN_DRILL);
  const note = !answer ? '' : median === null ? 'no traffic in this range' : `dashed: median ${fmtShare(median)}`;

  return (
    <div className="unknown-track">
      <div
        className="unknown-plot"
        role="button"
        tabIndex={0}
        title="Show the unlabelled traffic by destination"
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
      >
        <EChart
          option={option}
          chartRef={track}
          height={TRACK + 2 * PAD}
          ariaLabel={`Share of bytes with an unknown protocol${median === null ? '' : `, median ${fmtShare(median)}`}`}
        />
      </div>
      <p className="unknown-note muted">
        unknown-protocol share of all bytes{note && ` · ${note}`} · click to list the unlabelled destinations
      </p>
    </div>
  );
}
