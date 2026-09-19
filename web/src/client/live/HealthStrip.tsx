import { useMemo, useRef } from 'react';
import type { CompactTick, HistoryIngest, LiveMeta } from '../../shared/api.ts';
import { fmtDuration, fmtRate, fmtTime } from '../charts/format.ts';
import { Sparkline } from '../components/Sparkline.tsx';
import { StatTile, type Tone } from '../components/StatTile.tsx';
import { useLive } from '../hooks/useLive.ts';
import { useNow } from '../hooks/useNow.ts';
import { usePoll } from '../hooks/usePoll.ts';

/** Sparkline window. */
const SPARK_S = 300;
/** FLOW_MAP_ENTRIES in net-watch-common: per-interval flow slots in each kernel map. */
const MAP_CAPACITY = 1 << 20;
const RESTART_NOTE_MS = 5 * 60_000;
const INGEST_STALE_MS = 30_000;

type Point = number | null;

/** One array per sparkline; a null before each gap tick breaks the line. */
function sparkSeries(ticks: CompactTick[]) {
  const procs: Point[] = [];
  const flows: Point[] = [];
  const tx: Point[] = [];
  const rx: Point[] = [];
  for (const t of ticks) {
    if (t.gap && procs.length) for (const s of [procs, flows, tx, rx]) s.push(null);
    procs.push(t.nProcs);
    flows.push(t.nFlows);
    tx.push(t.txKbps);
    rx.push(t.rxKbps);
  }
  return { procs, flows, tx, rx };
}

interface DropTrack {
  /** Newest tick already folded in; null before the first. */
  lastTs: number | null;
  prev: number;
  /** Drops since this page was opened. */
  increase: number;
  /** Tick time (collector clock) of the last detected restart. */
  restartAt: number | null;
}

/**
 * Folds new ticks into the drop counter. `drops` is cumulative since collector
 * start, so a decrease means the collector restarted; the new value then
 * counts in full. Ticks buffered before the page opened only feed restart
 * detection. Idempotent per tick, so a repeated call (StrictMode) is harmless.
 */
function trackDrops(d: DropTrack, ticks: CompactTick[]): void {
  const first = d.lastTs === null;
  for (const t of ticks) {
    if (d.lastTs !== null && t.ts <= d.lastTs) continue;
    if (d.lastTs !== null) {
      if (t.drops < d.prev) {
        d.restartAt = t.ts;
        if (!first) d.increase += t.drops;
      } else if (!first) {
        d.increase += t.drops - d.prev;
      }
    }
    d.prev = t.drops;
    d.lastTs = t.ts;
  }
}

const count = (n: number) => n.toLocaleString();

/** KPI strip at the top of the Live page: is the pipeline running? */
export function HealthStrip() {
  const live = useLive(SPARK_S);
  const meta = usePoll<LiveMeta>('/api/live/meta');
  const ingest = usePoll<HistoryIngest>('/api/history/ingest');
  const browserNow = useNow(1000);

  const drops = useRef<DropTrack>({ lastTs: null, prev: 0, increase: 0, restartAt: null });
  // Recomputed per tick; trackDrops only reads ticks it has not seen.
  const dropState = useMemo(() => {
    trackDrops(drops.current, live.ticks);
    return { ...drops.current };
  }, [live.ticks]);

  const spark = useMemo(() => sparkSeries(live.ticks), [live.ticks]);
  const last = live.ticks.at(-1);

  // The collector writes its own clock into ticks and meta; it runs on the
  // API server's host, whose clock may differ from the browser's.
  const skew = meta.data ? meta.data.serverTimeMs - meta.receivedAt : 0;
  const now = browserNow + skew;

  // --- Collector lag: the newest tick from either the stream or meta.
  const lastTick = Math.max(live.latestTs ?? 0, meta.data?.lastTickMs ?? 0) || null;
  const interval = last?.intervalMs ?? meta.data?.intervalMs ?? 1000;
  const lag = lastTick === null ? null : Math.max(0, now - lastTick);
  let lagTone: Tone | undefined;
  let lagStatus: string | undefined;
  if (lag !== null) {
    [lagTone, lagStatus] = lag > 10 * interval ? ['bad', 'Stalled'] : lag > 3 * interval ? ['warn', 'Lagging'] : ['ok', 'OK'];
  } else if (meta.error || (meta.data && live.status === 'live')) {
    [lagTone, lagStatus] = ['bad', 'No data'];
  }
  const restarted = dropState.restartAt !== null && now - dropState.restartAt < RESTART_NOTE_MS;
  const lagSub = restarted
    ? `collector restarted at ${fmtTime(dropState.restartAt!, 'time')}`
    : lastTick !== null
      ? `last tick ${fmtTime(lastTick, 'time')}`
      : (meta.error ?? 'no ticks yet');

  // --- Drops
  const allTime = last?.drops ?? meta.data?.drops ?? null;
  const dropTone: Tone | undefined = allTime === null ? undefined : dropState.increase > 0 ? 'bad' : 'ok';

  // --- Flows vs map capacity
  const pct = last ? (last.nFlows / MAP_CAPACITY) * 100 : null;
  const flowTone: Tone | undefined = pct === null ? undefined : pct > 80 ? 'bad' : pct > 50 ? 'warn' : 'ok';
  const flowStatus = { ok: 'OK', warn: 'High', bad: 'Near full' }[flowTone ?? 'ok'];

  // --- ClickHouse ingest: its clock offset comes from its own response.
  const chNow = browserNow + (ingest.data ? ingest.data.serverTimeMs - ingest.receivedAt : skew);
  const chAge = ingest.data?.lastTsMs != null ? Math.max(0, chNow - ingest.data.lastTsMs) : null;
  let chTone: Tone | undefined;
  let chStatus: string | undefined;
  let chSub: string;
  if (ingest.error) {
    [chTone, chStatus, chSub] = ['bad', 'Unreachable', ingest.error];
  } else if (!ingest.data) {
    chSub = 'checking…';
  } else if (chAge === null) {
    [chTone, chStatus, chSub] = ['bad', 'Stale', 'no rows in the last 10 min'];
  } else {
    [chTone, chStatus] = chAge > INGEST_STALE_MS ? ['bad', 'Stale'] : ['ok', 'OK'];
    chSub = `latest row ${chAge < 2000 ? 'just now' : `${fmtDuration(chAge)} ago`}`;
  }

  return (
    <div className="health-strip" role="group" aria-label="Pipeline health">
      <StatTile
        label="Collector lag"
        value={lag === null ? '—' : fmtDuration(lag)}
        tone={lagTone}
        status={lagStatus}
        subtitle={lagSub}
      />
      <StatTile
        label="Dropped inserts"
        value={allTime === null ? '—' : count(dropState.increase)}
        tone={dropTone}
        status={dropTone === 'bad' ? 'Dropping' : 'OK'}
        subtitle={allTime === null ? 'no ticks yet' : `since page opened · ${count(allTime)} since collector start`}
      />
      <StatTile
        label="Live processes"
        value={last ? count(last.nProcs) : '—'}
        spark={last && <Sparkline values={spark.procs} width="100%" fmt={count} />}
        subtitle={meta.data ? `${count(meta.data.ended)} ended, kept in Redis` : undefined}
      />
      <StatTile
        label="Active flows"
        value={last ? count(last.nFlows) : '—'}
        spark={last && <Sparkline values={spark.flows} width="100%" fmt={count} />}
        tone={flowTone}
        status={flowStatus}
        subtitle={pct === null ? undefined : `${pct < 0.1 ? '<0.1' : pct.toFixed(1)}% of ${count(MAP_CAPACITY)} map slots`}
      />
      <StatTile
        label="Total ↑ / ↓"
        value={
          last ? (
            <span className="stat-pair">
              <span>↑ {fmtRate(last.txKbps)}</span> <span>↓ {fmtRate(last.rxKbps)}</span>
            </span>
          ) : (
            '—'
          )
        }
        spark={last && <Sparkline tx={spark.tx} rx={spark.rx} width="100%" fmt={fmtRate} />}
        subtitle={`last ${SPARK_S / 60} min · tx above, rx below`}
      />
      <StatTile
        label="ClickHouse ingest"
        value={ingest.data ? count(ingest.data.rows1m) : '—'}
        unit={ingest.data ? 'rows/min' : undefined}
        tone={chTone}
        status={chStatus}
        subtitle={chSub}
      />
    </div>
  );
}
