import { useMemo, useRef, useState } from 'react';
import type { ProcessCallsResponse, ProcessInfo } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { fmtBytes, fmtDuration, fmtRate, fmtTime } from '../charts/format.ts';
import { tipRow } from '../charts/mirroredStack.ts';
import { RX, TX } from '../charts/palette.ts';
import { SmallMultiples } from '../charts/SmallMultiples.tsx';
import type { SmallMultiplesSpec } from '../charts/smallMultiples.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Panel } from '../components/Panel.tsx';
import { useQuery } from '../hooks/useQuery.ts';
import { setSearchParams } from '../router.ts';
import { bytesPerCall, CALLS_PARAM, callsPoints, dotIsolated, fmtCalls, fromThroughput, hasTraffic, processCallsRange, type CallsData } from './callsSeries.ts';
import type { ThroughputAnswer } from './ThroughputChart.tsx';

const HEIGHT = 380;
/** Bytes 40 %, calls 30 %, bytes per call 30 %. */
const WEIGHTS = [40, 30, 30] as const;

const SUBTITLE =
  'Totals on one time axis: calls rising while bytes stay flat suggest polling or retries; bytes rising while calls stay flat, bigger transfers';

type Props = {
  data: CallsData | null;
  /** The x extent while data loads. */
  range: TimeRange;
  /** Links cursor and zoom with the History throughput chart. */
  group?: string;
};

/**
 * 14: bytes/s, calls/s and bytes per call in three panels on one time axis
 * (tx above zero, rx below; bytes per call on a log axis, per direction).
 */
function CallsChart({ data, range, group }: Props) {
  const scheme = useColorScheme();
  const latest = useRef(data);
  latest.current = data;

  const spec = useMemo<SmallMultiplesSpec>(() => {
    const tx = TX[scheme];
    const rx = RX[scheme];
    const p = data ? callsPoints(data) : null;
    const line = (id: string, name: string, color: string, points: [number, number | null][] | undefined, area: boolean) => ({
      id,
      name,
      type: 'line',
      data: points ?? [],
      color,
      lineStyle: { width: 1.25 },
      symbol: 'none',
      showSymbol: false,
      sampling: 'lttb',
      emphasis: { disabled: true },
      ...(area && { areaStyle: { opacity: 0.18 } }),
    });
    const perCall = (id: string, name: string, color: string, points: [number, number | null][] | undefined) => ({
      id,
      name,
      type: 'line',
      data: points ? dotIsolated(points) : [],
      color,
      lineStyle: { width: 1.25 },
      symbol: 'none',
      symbolSize: 4,
      connectNulls: false,
      emphasis: { disabled: true },
    });
    const step = data?.step ?? 60;
    return {
      x: { min: data?.from ?? range.from, max: data?.to ?? range.to },
      panels: [
        {
          name: 'throughput  ↑ sent · ↓ received',
          weight: WEIGHTS[0],
          yAxis: { axisLabel: { formatter: (v: number) => fmtRate(Math.abs(v)) } },
          series: [line('calls:bytes:tx', '↑ sent', tx, p?.bytes.tx, true), line('calls:bytes:rx', '↓ received', rx, p?.bytes.rx, true)],
        },
        {
          name: 'calls per second',
          weight: WEIGHTS[1],
          yAxis: { axisLabel: { formatter: (v: number) => fmtCalls(Math.abs(v)).replace('/s', '') } },
          series: [line('calls:n:tx', 'send calls', tx, p?.calls.tx, true), line('calls:n:rx', 'receive calls', rx, p?.calls.rx, true)],
        },
        {
          name: 'bytes per call (log)',
          weight: WEIGHTS[2],
          yAxis: { type: 'log', logBase: 10, axisLabel: { formatter: (v: number) => fmtBytes(v) } },
          series: [perCall('calls:per:tx', 'per send', tx, p?.perCall.tx), perCall('calls:per:rx', 'per receive', rx, p?.perCall.rx)],
        },
      ],
      tooltip: (params: { dataIndex: number }[]) => {
        const d = latest.current;
        const i = params[0]?.dataIndex;
        if (!d || i === undefined || d.t[i] === undefined) return '';
        const section = (label: string, color: string, kbps: number, perSec: number) => {
          const per = bytesPerCall(kbps, perSec);
          return (
            `<div class="tip-head"><span>${label}</span><span class="tip-num">${fmtRate(kbps)}</span></div>` +
            tipRow(color, 'calls', fmtCalls(perSec)) +
            tipRow(color, 'bytes per call', per === null ? '—' : fmtBytes(per))
          );
        };
        return (
          `<div class="tip"><div class="tip-time">${fmtTime(d.t[i]!, step < 60 ? 'time' : 'datetime')} <span class="muted">${fmtDuration(step * 1000)} mean</span></div>` +
          section('↑ sent', tx, d.tx[i]!, d.calls.tx[i]!) +
          section('↓ received', rx, d.rx[i]!, d.calls.rx[i]!) +
          '</div>'
        );
      },
    };
  }, [data, range.from, range.to, scheme]);

  return <SmallMultiples spec={spec} height={HEIGHT} group={group} ariaLabel="Throughput, calls per second and bytes per call on one time axis" />;
}

/**
 * The History page's panel, closed by default (URL `calls=1` opens it). It
 * reads the throughput chart's answer, which asks for the calls while the
 * panel is open, and shares its cursor and zoom (group `history`).
 */
export function HistoryCallsPanel({ range, open, answer }: { range: TimeRange; open: boolean; answer: ThroughputAnswer | null }) {
  const data = useMemo(() => (answer?.data ? fromThroughput(answer.data) : null), [answer?.data]);
  const fresh = answer && !answer.stale && data;
  return (
    <Panel
      title="Calls & efficiency"
      subtitle={open ? `${SUBTITLE}; the page's filters apply` : 'Bytes, calls and bytes per call on one time axis'}
      collapsible={{ collapsed: !open, onToggle: () => setSearchParams({ [CALLS_PARAM]: open ? null : '1' }) }}
      wide
      loading={open && (answer?.loading ?? true)}
      error={open ? (answer?.error ?? null) : null}
      empty={fresh && !hasTraffic(data) ? 'No traffic in this range.' : undefined}
    >
      {open && <CallsChart data={data} range={range} group="history" />}
    </Panel>
  );
}

/** The Process page's panel: this instance over its traffic window, from raw flows. */
export function ProcessCallsPanel({ p }: { p: ProcessInfo }) {
  const [now] = useState(() => Date.now());
  const range = useMemo(() => processCallsRange(p, now), [p, now]);
  const q = useQuery<ProcessCallsResponse>(urls.processCalls(String(p.pid), p.start_ns, range));
  const d = q.data ?? null;
  return (
    <Panel
      title="Bytes vs calls"
      subtitle={`${SUBTITLE}${d ? ` · ${fmtDuration(d.step * 1000)} buckets over this instance's traffic` : ''}`}
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && !hasTraffic(d) ? 'No traffic recorded for this instance.' : undefined}
    >
      <CallsChart data={d} range={range} />
    </Panel>
  );
}
