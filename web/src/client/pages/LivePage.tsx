import { useEffect, useMemo, useRef } from 'react';
import type { CompactTick } from '../../shared/api.ts';
import { EChart, useEChartRef } from '../charts/EChart.tsx';
import type { EChartsCoreOption, EChartsType } from '../charts/echarts.ts';
import { fmtDuration, fmtRate, fmtTime } from '../charts/format.ts';
import { RX, TX } from '../charts/palette.ts';
import { useColorScheme } from '../charts/useColorScheme.ts';
import { Panel } from '../components/Panel.tsx';
import { useLive, type LiveStatus } from '../hooks/useLive.ts';
import { useNow } from '../hooks/useNow.ts';
import { HealthStrip } from '../live/HealthStrip.tsx';
import { Link } from '../router.ts';

const WINDOW_S = 900;

type Point = [number, number | null];

/** Total tx above zero, rx below; a null point before each gap breaks the line. */
function totals(ticks: CompactTick[]): { tx: Point[]; rx: Point[] } {
  const tx: Point[] = [];
  const rx: Point[] = [];
  for (const t of ticks) {
    if (t.gap && tx.length) {
      tx.push([t.ts - 1, null]);
      rx.push([t.ts - 1, null]);
    }
    tx.push([t.ts, t.txKbps]);
    rx.push([t.ts, -t.rxKbps]);
  }
  return { tx, rx };
}

const STATUS_TEXT: Record<LiveStatus, string> = { connecting: 'connecting…', live: 'connected', reconnecting: 'reconnecting…' };

export function LivePage() {
  const live = useLive(WINDOW_S);
  const scheme = useColorScheme();
  const now = useNow(1000);
  const chart = useEChartRef();

  // Structure only; the data is pushed through the ref on each tick. It has
  // no `data` key, so re-applying it (theme change) keeps the current data.
  const option = useMemo<EChartsCoreOption>(
    () => ({
      grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
      legend: { top: 0, left: 0, data: ['tx', 'rx'] },
      tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v === null ? '—' : fmtRate(Math.abs(v))) },
      xAxis: { type: 'time', splitLine: { show: false } },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => fmtRate(Math.abs(v)) } },
      series: [
        { id: 'tx', name: 'tx', type: 'line', color: TX[scheme], areaStyle: { opacity: 0.2 }, showSymbol: false, animation: false },
        { id: 'rx', name: 'rx', type: 'line', color: RX[scheme], areaStyle: { opacity: 0.2 }, showSymbol: false, animation: false },
      ],
    }),
    [scheme],
  );

  const data = useMemo(() => totals(live.ticks), [live.ticks]);
  const latestData = useRef(data);
  latestData.current = data;
  const push = (c: EChartsType | null) =>
    c?.setOption({ series: [{ id: 'tx', data: latestData.current.tx }, { id: 'rx', data: latestData.current.rx }] });
  useEffect(() => push(chart.current), [data, chart]);

  const last = live.ticks.at(-1);
  const top = useMemo(() => [...(last?.procs ?? [])].sort((a, b) => b.tx + b.rx - (a.tx + a.rx)).slice(0, 8), [last]);
  const age = live.latestTs === null ? null : now - live.latestTs;
  const stale = age !== null && last !== undefined && age > 3 * last.intervalMs;

  return (
    <>
      <h1>Live</h1>
      <HealthStrip />
      <div className="panels">
        <Panel
          title="Throughput"
          subtitle={`All processes, last ${WINDOW_S / 60} min · tx above zero, rx below`}
          wide
          loading={live.status !== 'live' && !live.ticks.length}
          error={live.error}
          empty={live.status === 'live' && !live.ticks.length ? 'No ticks yet. Is the collector running?' : undefined}
        >
          <EChart option={option} chartRef={chart} onInit={push} height={260} ariaLabel="Total throughput, tx above zero and rx below" />
        </Panel>

        <Panel title="Feed" footnote={null}>
          <dl className="facts">
            <dt>Stream</dt>
            <dd>
              <span className={`dot dot-${live.status === 'live' ? (stale ? 'warn' : 'ok') : 'idle'}`} aria-hidden="true" />
              {STATUS_TEXT[live.status]}
            </dd>
            <dt>Last tick</dt>
            <dd>{last ? `${fmtTime(last.ts, 'time')} (${age! < 2000 ? 'just now' : `${fmtDuration(age!)} ago`})` : '—'}</dd>
            <dt>Buffered</dt>
            <dd>{live.ticks.length} ticks</dd>
            <dt>Processes / flows</dt>
            <dd>{last ? `${last.nProcs} / ${last.nFlows}` : '—'}</dd>
            <dt>Dropped events</dt>
            <dd>{last ? last.drops.toLocaleString() : '—'}</dd>
          </dl>
          {stale && <p className="note">No new ticks for {fmtDuration(age!)}. The collector may be stopped.</p>}
        </Panel>

        <Panel title="Active now" subtitle="Highest tx + rx in the latest tick">
          {top.length ? (
            <ol className="plain-list">
              {top.map((p) => {
                const [pid, start] = p.id.split(':');
                return (
                  <li key={p.id}>
                    <Link href={`/process/${pid}/${start}`}>{p.name}</Link>
                    <span className="muted"> {pid}</span>
                    <span className="num">
                      ↑ {fmtRate(p.tx)} · ↓ {fmtRate(p.rx)}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="muted">No traffic in the latest tick.</p>
          )}
        </Panel>
      </div>
    </>
  );
}
