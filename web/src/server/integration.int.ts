// Integration checks against the compose stack (`docker compose up -d --wait`
// in the repo root). Not part of `npm test`; run with `npm run test:int`.
// Starts the real server on a spare port and checks every endpoint's shape.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, test } from 'node:test';
import type {
  AsnResponse,
  CountriesResponse,
  DestinationsResponse,
  RdnsResponse,
  BeaconsResponse,
  BurstResponse,
  BytesPerCallResponse,
  CompactTick,
  FlowAgg,
  HealthResponse,
  HeatmapResponse,
  HistoryFlowsResponse,
  HistoryIngest,
  HistorySummary,
  LifecycleResponse,
  LifetimesResponse,
  LiveFlowsResponse,
  LiveMeta,
  LiveSnapshotResponse,
  NewDestsResponse,
  ProcessCallsResponse,
  ProcessInfo,
  ScatterResponse,
  ThroughputCompare,
  ThroughputResponse,
  TreemapResponse,
} from '../shared/api.ts';
import { BPC_BUCKETS, THROUGHPUT_OTHER } from '../shared/api.ts';
import { parseRange } from './ch/range.ts';
import { DISPLAY_IP } from './ch/sql.ts';
import { alignRange, compareQuery, FIRST_MINUTE_SQL, throughputQuery } from './ch/throughput.ts';
import { config } from './config.ts';
import { orgDestLabel } from '../shared/org.ts';
import { createClickHouse } from './db/clickhouse.ts';

const PORT = Number(process.env.INT_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;

// Range end for tests that compare two queries: two whole minutes back, so rows
// the running collector is still writing can't land between the two reads.
function settledNow(): number {
  return Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
}
let server: ChildProcess;

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: (await res.json()) as T };
}

before(async () => {
  server = spawn(process.execPath, ['src/server/index.ts'], {
    cwd: new URL('../../', import.meta.url),
    // 18: the hand-written fixture table, not a real download; reverse DNS off.
    env: { ...process.env, WEB_PORT: String(PORT), LOG_LEVEL: 'warn', GEOIP_FILE: 'src/server/geo/fixtures/ip2asn-test.tsv', RDNS: '0' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const { body } = await get<HealthResponse>('/api/health');
      if (body.redis.ok && body.geo.loaded) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up with Redis connected');
});

after(() => {
  server?.kill();
});

test('health: both backends up', async () => {
  const { status, body } = await get<HealthResponse>('/api/health');
  assert.equal(status, 200);
  assert.ok(body.redis.ok, body.redis.error ?? '');
  assert.ok(body.clickhouse.ok, body.clickhouse.error ?? '');
});

test('live series: compact ticks, oldest first', async () => {
  const { status, body } = await get<CompactTick[]>('/api/live/series?seconds=900');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  for (let i = 1; i < body.length; i++) assert.ok(body[i]!.ts > body[i - 1]!.ts, 'ascending ts');
  for (const t of body.slice(-5)) {
    for (const k of ['ts', 'intervalMs', 'drops', 'nProcs', 'nFlows', 'txKbps', 'rxKbps'] as const) assert.equal(typeof t[k], 'number', k);
    for (const p of t.procs) assert.match(p.id, /^\d+:\d+$/);
    for (const v of Object.values(t.apps)) assert.equal(v.length, 2);
  }
  assert.equal((await get('/api/live/series?seconds=0')).status, 400);
});

test('live snapshot: process rows, ids kept as strings', async () => {
  const { status, body } = await get<LiveSnapshotResponse>('/api/live/snapshot');
  if (status === 503) return; // stream empty: nothing to check
  assert.equal(status, 200);
  assert.equal(typeof body.ts, 'number');
  assert.equal(typeof body.serverTimeMs, 'number');
  for (const p of body.processes) {
    assert.equal(typeof p.startNs, 'string');
    assert.equal(p.id, `${p.pid}:${p.startNs}`);
    assert.ok(p.cmdline.length <= 300, 'cmdline truncated');
    assert.ok(p.user === null || typeof p.user === 'string');
    assert.equal(typeof p.nFlows, 'number');
  }
});

function assertFlow(f: FlowAgg) {
  for (const k of ['name', 'proto', 'app', 'ip', 'id'] as const) assert.equal(typeof f[k], 'string', k);
  for (const k of ['rport', 'tx', 'rx'] as const) assert.equal(typeof f[k], 'number', k);
  assert.match(f.id, /^\d+:\d+$/);
  assert.ok(!f.ip.startsWith('::ffff:'), 'IPv4 shown plain');
}

test('live flows: mean kbps per (name, proto, app, ip, port), largest first', async () => {
  const { status, body } = await get<LiveFlowsResponse>('/api/live/flows?seconds=10');
  assert.equal(status, 200);
  assert.equal(typeof body.ticks, 'number');
  assert.ok(body.ticks <= 30);
  assert.equal(body.ts === null, body.ticks === 0);
  for (const f of body.flows) assertFlow(f);
  for (let i = 1; i < body.flows.length; i++) assert.ok(body.flows[i - 1]!.tx + body.flows[i - 1]!.rx >= body.flows[i]!.tx + body.flows[i]!.rx);
  assert.equal((await get('/api/live/flows?seconds=31')).status, 400);
  assert.equal((await get('/api/live/flows?seconds=0')).status, 400);
});

test('history flows: bytes per destination, both tables, dest filter', async () => {
  const now = settledNow();
  const week = await get<HistoryFlowsResponse>(`/api/history/flows?from=${now - 7 * 86_400_000}&to=${now}&limit=50`);
  assert.equal(week.status, 200);
  assert.equal(week.body.range.table, 'flows_1m');
  assert.ok(week.body.flows.length <= 50);
  assert.equal(typeof week.body.truncated, 'boolean');
  for (const f of week.body.flows) assertFlow(f);
  for (let i = 1; i < week.body.flows.length; i++) {
    const [a, b] = [week.body.flows[i - 1]!, week.body.flows[i]!];
    assert.ok(a.tx + a.rx >= b.tx + b.rx, 'largest first');
  }

  const raw = await get<HistoryFlowsResponse>(`/api/history/flows?from=${now - 3_600_000}&to=${now}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.body.range.table, 'flows');

  const top = week.body.flows[0];
  if (top) {
    const dest = top.ip.includes(':') ? `[${top.ip}]:${top.rport}` : `${top.ip}:${top.rport}`;
    const one = await get<HistoryFlowsResponse>(`/api/history/flows?from=${now - 7 * 86_400_000}&to=${now}&dest=${encodeURIComponent(dest)}`);
    assert.equal(one.status, 200);
    assert.ok(one.body.flows.length > 0);
    for (const f of one.body.flows) assert.deepEqual([f.ip, f.rport], [top.ip, top.rport]);
  }

  for (const q of ['dest=example.com:443', 'dest=1.2.3.4', 'limit=0', 'limit=2001', 'limit=x']) {
    assert.equal((await get(`/api/history/flows?${q}`)).status, 400, q);
  }
});

function assertThroughput(b: ThroughputResponse) {
  assert.ok(b.t.length > 0);
  assert.equal(b.from % (b.step * 1000), 0, 'from on a bucket start');
  for (let i = 0; i < b.t.length; i++) assert.equal(b.t[i], b.from + i * b.step * 1000, 'contiguous buckets');
  assert.ok(b.t.at(-1)! < b.to);
  assert.deepEqual(Object.keys(b.tx).sort(), [...b.keys].sort());
  assert.deepEqual(Object.keys(b.rx).sort(), [...b.keys].sort());
  for (const k of b.keys) {
    assert.equal(b.tx[k]!.length, b.t.length, `tx ${k} padded`);
    assert.equal(b.rx[k]!.length, b.t.length, `rx ${k} padded`);
    for (const v of [...b.tx[k]!, ...b.rx[k]!]) assert.ok(typeof v === 'number' && v >= 0);
  }
  const i = b.keys.indexOf(THROUGHPUT_OTHER);
  assert.ok(i === -1 || i === b.keys.length - 1, 'other last');
}

/** Bytes back from kbps: Σ kbps × bucket seconds × 1000 / 8. */
function bytesOf(b: ThroughputResponse, dir: 'tx' | 'rx'): number {
  let sum = 0;
  for (const k of b.keys) {
    b[dir][k]!.forEach((v, i) => {
      const secs = (Math.min(b.t[i]! + b.step * 1000, b.table === 'flows' ? b.to : Math.ceil(b.to / 60_000) * 60_000) - b.t[i]!) / 1000;
      sum += (v * secs * 1000) / 8;
    });
  }
  return sum;
}

test('history throughput: padded kbps per top key, both tables, filters, drill keys', async () => {
  const now = settledNow();
  const day = await get<ThroughputResponse>(`/api/history/throughput?from=${now - 86_400_000}&to=${now}`);
  assert.equal(day.status, 200);
  assert.equal(day.body.table, 'flows_1m');
  assertThroughput(day.body);
  assert.ok(day.body.keys.filter((k) => k !== THROUGHPUT_OTHER).length <= 8);

  // Rates convert back to the summary's bytes over the same (bucket-aligned) range.
  const sum = await get<HistorySummary>(`/api/history/summary?from=${day.body.from}&to=${now}`);
  for (const [dir, want] of [
    ['tx', sum.body.txBytes],
    ['rx', sum.body.rxBytes],
  ] as const) {
    assert.ok(Math.abs(bytesOf(day.body, dir) - want) <= Math.max(1, want * 0.005), `${dir}: ${bytesOf(day.body, dir)} vs ${want}`);
  }

  // Ranked by the direction's total
  const tx = await get<ThroughputResponse>(`/api/history/throughput?from=${now - 86_400_000}&to=${now}&dir=tx&top=5&by=name`);
  assertThroughput(tx.body);
  const ranked = tx.body.keys.filter((k) => k !== THROUGHPUT_OTHER).map((k) => tx.body.tx[k]!.reduce((a, b) => a + b, 0));
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1]! >= ranked[i]! - 1e-6, 'largest tx first');
  assert.ok(ranked.length <= 5);

  // uid on the rollup (joined to processes) and on raw flows
  const uid = await get<ThroughputResponse>(`/api/history/throughput?from=${now - 86_400_000}&to=${now}&by=uid`);
  assertThroughput(uid.body);
  for (const k of uid.body.keys) if (k !== THROUGHPUT_OTHER) assert.match(k, /^\d+$/);
  const rawUid = await get<ThroughputResponse>(`/api/history/throughput?from=${now - 3_600_000}&to=${now}&by=uid`);
  assert.equal(rawUid.body.table, 'flows');
  assertThroughput(rawUid.body);

  // Every key of every dimension works as its own filter (the drill-down).
  for (const by of ['app', 'name', 'proto', 'uid', 'dest'] as const) {
    const all = await get<ThroughputResponse>(`/api/history/throughput?from=${now - 86_400_000}&to=${now}&by=${by}&top=5`);
    assert.equal(all.status, 200, by);
    const key = all.body.keys.find((k) => k !== THROUGHPUT_OTHER);
    if (!key) continue;
    const one = await get<ThroughputResponse>(`/api/history/throughput?from=${now - 86_400_000}&to=${now}&by=${by}&${by}=${encodeURIComponent(key)}`);
    assert.equal(one.status, 200, `${by}=${key}`);
    assert.deepEqual(one.body.keys, [key], `${by}=${key}`);
    const drilled = await get<ThroughputResponse>(`/api/history/throughput?from=${now - 86_400_000}&to=${now}&by=name&${by}=${encodeURIComponent(key)}`);
    assert.equal(drilled.status, 200);
    assert.ok(drilled.body.keys.length > 0, `name within ${by}=${key}`);
  }

  for (const q of ['by=raddr', 'by=toString(uid)', 'dir=up', 'top=4', 'top=21', 'uid=x', 'dest=host:1', `name=${'x'.repeat(300)}`]) {
    assert.equal((await get(`/api/history/throughput?${q}`)).status, 400, q);
  }
});

/** Bytes a ghost's kbps stand for, over the time each bucket covers (as the server divides them). */
function ghostBytes(c: ThroughputCompare, to: number, dir: 'tx' | 'rx'): number {
  const end = Math.ceil(to / 60_000) * 60_000;
  let sum = 0;
  c[dir].forEach((v, i) => {
    const start = c.t[i]!;
    if (v !== null) sum += (v * ((Math.min(start + c.step * 1000, end) - Math.max(start, c.since)) / 1000) * 1000) / 8;
  });
  return sum;
}

test('history throughput compare: the earlier window shifted onto the range, null before the data', async () => {
  const now = settledNow();
  const DAY = 86_400_000;
  const plain = await get<ThroughputResponse>(`/api/history/throughput?from=${now - DAY}&to=${now}`);
  assert.equal(plain.body.compare, undefined);

  const ch = createClickHouse(config.clickhouse);
  let first: number | null;
  try {
    const rs = await ch.query({ query: FIRST_MINUTE_SQL, format: 'JSONEachRow' });
    const [row] = await rs.json<{ first: number }>();
    first = row ? Number(row.first) * 1000 : null;
  } finally {
    await ch.close();
  }

  // The week before the last day: null unless the table is older than that.
  const week = await get<ThroughputResponse>(`/api/history/throughput?from=${now - DAY}&to=${now}&compare=1w`);
  assert.equal(week.status, 200);
  if (first === null || first >= now - 7 * DAY) assert.equal(week.body.compare, null);
  else assert.ok(week.body.compare);

  // The day ahead compared with a day before is the last day, so the ghost is
  // the last day's traffic: its bytes match the summary's over the same span.
  if (first === null) return;
  const res = await get<ThroughputResponse>(`/api/history/throughput?from=${now}&to=${now + DAY}&compare=1d`);
  assert.equal(res.status, 200);
  const c = res.body.compare!;
  assert.ok(c, 'compare present');
  assert.equal(c.offset, DAY);
  assert.equal(c.step, 60);
  assert.equal(c.t.length, c.tx.length);
  for (let i = 0; i < c.t.length; i++) assert.equal(c.t[i], c.t[0]! + i * 60_000);
  assert.ok(c.t[0]! <= now && c.t[0]! > now - 60_000, 'first bucket on the range start');
  assert.equal(c.since, Math.max(c.t[0]!, first + DAY));
  c.tx.forEach((v, i) => assert.equal(v === null, c.t[i]! + 60_000 <= c.since, `null only before since (${i})`));
  const sum = await get<HistorySummary>(`/api/history/summary?from=${c.t[0]! - DAY}&to=${now}`);
  for (const [dir, want] of [
    ['tx', sum.body.txBytes],
    ['rx', sum.body.rxBytes],
  ] as const) {
    const got = ghostBytes(c, now + DAY, dir);
    assert.ok(Math.abs(got - want) <= Math.max(1, want * 0.005), `${dir}: ${got} vs ${want}`);
  }

  // Filters apply to the ghost too.
  const top = (await get<ThroughputResponse>(`/api/history/throughput?from=${now - DAY}&to=${now}&by=name&top=5`)).body.keys[0];
  if (top && top !== THROUGHPUT_OTHER) {
    const one = await get<ThroughputResponse>(`/api/history/throughput?from=${now}&to=${now + DAY}&compare=1d&name=${encodeURIComponent(top)}`);
    const got = ghostBytes(one.body.compare!, now + DAY, 'tx') + ghostBytes(one.body.compare!, now + DAY, 'rx');
    assert.ok(got > 0 && got <= ghostBytes(c, now + DAY, 'tx') + ghostBytes(c, now + DAY, 'rx') + 1, `name=${top}`);
    const uid = await get<ThroughputResponse>(`/api/history/throughput?from=${now}&to=${now + DAY}&compare=1d&uid=0`);
    assert.equal(uid.status, 200);
  }

  for (const q of ['compare=2d', 'compare=1W', 'compare=true']) assert.equal((await get(`/api/history/throughput?${q}`)).status, 400, q);
});

test('history throughput unknown: the unlabelled share per bucket, on the main grid, filters', async () => {
  const now = settledNow();
  const DAY = 86_400_000;
  for (const span of [DAY, 3_600_000]) {
    const from = now - span;
    const res = await get<ThroughputResponse>(`/api/history/throughput?from=${from}&to=${now}&unknown=1`);
    assert.equal(res.status, 200);
    const u = res.body.unknown!;
    assert.ok(u, 'unknown present');
    for (const a of [u.share, u.bytes, u.total]) assert.equal(a.length, res.body.t.length);
    u.share.forEach((s, i) => {
      if (u.total[i] === 0) assert.equal(s, null, `null without traffic (${i})`);
      else assert.ok(Math.abs(s! - u.bytes[i]! / u.total[i]!) < 1e-4 && u.bytes[i]! <= u.total[i]!, `share (${i})`);
    });
    // All bytes over the grid match the totals over the same span.
    const sum = await get<HistorySummary>(`/api/history/summary?from=${res.body.from}&to=${now}`);
    const total = u.total.reduce((a, b) => a + b, 0);
    const want = sum.body.txBytes + sum.body.rxBytes;
    assert.ok(Math.abs(total - want) <= Math.max(1, want * 0.005), `${span}: ${total} vs ${want}`);

    // Filtered to app=unknown, every bucket with traffic is 100 % unknown.
    const only = (await get<ThroughputResponse>(`/api/history/throughput?from=${from}&to=${now}&unknown=1&app=unknown`)).body.unknown!;
    only.share.forEach((s, i) => assert.ok(s === null || s === 1, `app=unknown (${i}): ${s}`));
    assert.deepEqual(only.bytes, u.bytes);
  }
  const plain = await get<ThroughputResponse>(`/api/history/throughput?from=${now - DAY}&to=${now}`);
  assert.equal(plain.body.unknown, undefined);
  for (const q of ['unknown=yes', 'unknown=2', 'unknown=true']) assert.equal((await get(`/api/history/throughput?${q}`)).status, 400, q);
});

test('history throughput calls: calls per second on the main grid, totals match flows, filters', async () => {
  const now = settledNow();
  const ch = createClickHouse(config.clickhouse);
  try {
    for (const span of [86_400_000, 3_600_000]) {
      const res = await get<ThroughputResponse>(`/api/history/throughput?from=${now - span}&to=${now}&calls=1`);
      assert.equal(res.status, 200);
      const { calls, t, step, table } = res.body;
      assert.ok(calls, 'calls present');
      for (const a of [calls.tx, calls.rx]) {
        assert.equal(a.length, t.length);
        for (const v of a) assert.ok(v >= 0 && Number.isFinite(v));
      }
      // Whole buckets (all but the last): calls/s * step sums to the table's calls.
      const end = t[t.length - 1]!;
      const col = table === 'flows' ? 'ts' : 'minute';
      const rs = await ch.query({
        query: `SELECT sum(tx_calls) AS tx, sum(rx_calls) AS rx FROM ${table}
                WHERE ${col} >= fromUnixTimestamp64Milli({from:Int64}) AND ${col} < fromUnixTimestamp64Milli({to:Int64})`,
        query_params: { from: res.body.from, to: end },
        format: 'JSONEachRow',
      });
      const [want] = await rs.json<{ tx: string; rx: string }>();
      for (const d of ['tx', 'rx'] as const) {
        const got: number = calls[d].slice(0, -1).reduce((a, v) => a + v * step, 0);
        const w = Number(want![d]);
        assert.ok(Math.abs(got - w) <= Math.max(1, w * 0.001), `${span} ${d}: ${got} vs ${w}`);
      }
      // A filter keeps a subset.
      const top = (await get<ThroughputResponse>(`/api/history/throughput?from=${now - span}&to=${now}&by=name&top=5`)).body.keys[0];
      if (top && top !== THROUGHPUT_OTHER) {
        const one = (await get<ThroughputResponse>(`/api/history/throughput?from=${now - span}&to=${now}&calls=1&name=${encodeURIComponent(top)}`)).body.calls!;
        one.tx.forEach((v, i) => assert.ok(v <= calls.tx[i]! + 1e-6, `filtered tx (${i})`));
      }
    }
  } finally {
    await ch.close();
  }
  const plain = await get<ThroughputResponse>(`/api/history/throughput?from=${now - 3_600_000}&to=${now}`);
  assert.equal(plain.body.calls, undefined);
  for (const q of ['calls=yes', 'calls=2', 'calls=true']) assert.equal((await get(`/api/history/throughput?${q}`)).status, 400, q);
});

test('history burst: mean/p95/max per bucket on the throughput grid, bytes match flows, filters, limits', async () => {
  // End in the past so both queries see the same rows while the collector writes.
  const to = Date.now() - 5 * 60_000;
  const ch = createClickHouse(config.clickhouse);
  try {
    for (const span of [86_400_000, 3_600_000]) {
      const from = to - span;
      const step = Math.ceil(span / 1000 / 1500);
      const res = await get<BurstResponse>(`/api/history/burst?from=${from}&to=${to}&step=${step}&dir=both`);
      assert.equal(res.status, 200);
      const b = res.body;
      const tp = (await get<ThroughputResponse>(`/api/history/throughput?from=${from}&to=${to}&step=${step}&dir=both`)).body;
      assert.deepEqual([b.step, b.from, b.t.length], [tp.step, tp.from, tp.t.length], 'same buckets as the throughput chart');
      assert.equal(b.dir, 'both');
      assert.equal(b.total, undefined);
      for (const side of [b.tx!, b.rx!]) {
        for (const a of [side.mean, side.p95, side.max]) assert.equal(a.length, b.t.length);
        side.mean.forEach((m, i) => {
          assert.ok(side.p95[i]! >= 0 && side.max[i]! >= side.p95[i]!, `max ≥ p95 ≥ 0 (${i})`);
          // Whole buckets only: a tick's bytes cover the second before its ts, so a
          // bucket cut short by `to` overstates its mean (as 05's totals do). Tick
          // intervals jitter around 1 s, so the mean can edge past the busiest tick.
          if (i < b.t.length - 1) assert.ok(m <= side.max[i]! * 1.1 + 0.01, `mean ≤ max (${i}): ${m} vs ${side.max[i]}`);
        });
      }
      // Whole buckets (all but the last): the means add up to the raw bytes.
      const end = b.t[b.t.length - 1]!;
      const rs = await ch.query({
        query: `SELECT sum(tx_bytes) AS tx, sum(rx_bytes) AS rx FROM flows
                WHERE ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})`,
        query_params: { from: b.from, to: end },
        format: 'JSONEachRow',
      });
      const [want] = await rs.json<{ tx: string; rx: string }>();
      for (const d of ['tx', 'rx'] as const) {
        const got = (b[d]!.mean.slice(0, -1).reduce((a, v) => a + v * b.step, 0) * 1000) / 8;
        const w = Number(want![d]);
        assert.ok(Math.abs(got - w) <= Math.max(2, w * 0.001), `${span} ${d}: ${got} vs ${w}`);
      }
      // One side alone; a filter keeps every tick at or under the unfiltered one.
      const total = (await get<BurstResponse>(`/api/history/burst?from=${from}&to=${to}&step=${step}`)).body;
      assert.equal(total.dir, 'total');
      assert.ok(total.total && !total.tx && !total.rx);
      const top = tp.keys[0];
      if (top && top !== THROUGHPUT_OTHER) {
        const one = (await get<BurstResponse>(`/api/history/burst?from=${from}&to=${to}&step=${step}&app=${encodeURIComponent(top)}`)).body.total!;
        one.max.forEach((v, i) => assert.ok(v <= total.total!.max[i]! + 1e-6, `filtered max (${i})`));
        one.p95.forEach((v, i) => assert.ok(v <= total.total!.p95[i]! + 1e-6, `filtered p95 (${i})`));
      }
    }
    // One instance reads by the primary key, so any range is allowed.
    const rs = await ch.query({
      query: `SELECT pid, toString(proc_start) AS start FROM flows GROUP BY pid, proc_start ORDER BY sum(tx_bytes + rx_bytes) DESC LIMIT 1`,
      format: 'JSONEachRow',
    });
    const [inst] = await rs.json<{ pid: number; start: string }>();
    if (inst) {
      const r = await get<BurstResponse>(`/api/history/burst?from=${to - 7 * 86_400_000}&to=${to}&pid=${inst.pid}&start=${inst.start}`);
      assert.equal(r.status, 200);
      assert.ok(r.body.total!.max.some((v) => v > 0), 'the busiest instance moved bytes');
    }
  } finally {
    await ch.close();
  }
  const long = await get<{ error: string }>(`/api/history/burst?from=${to - 86_400_000 - 1}&to=${to}`);
  assert.equal(long.status, 400);
  assert.match(long.body.error, /24 h/);
  assert.equal((await get('/api/history/burst?dir=sum')).status, 400);
  assert.equal((await get('/api/history/burst?pid=1')).status, 400);
});

test('process calls: one instance from raw flows, bytes and calls per bucket', async () => {
  const ch = createClickHouse(config.clickhouse);
  try {
    // The instance with the most raw calls.
    const rs = await ch.query({
      query: `SELECT pid, toString(proc_start) AS start, toUnixTimestamp64Milli(min(ts)) AS first, toUnixTimestamp64Milli(max(ts)) AS last,
                     sum(tx_bytes) AS txb, sum(rx_bytes) AS rxb, sum(tx_calls) AS txc, sum(rx_calls) AS rxc
              FROM flows GROUP BY pid, proc_start ORDER BY txc + rxc DESC LIMIT 1`,
      format: 'JSONEachRow',
    });
    const [row] = await rs.json<{ pid: number; start: string; first: string; last: string; txb: string; rxb: string; txc: string; rxc: string }>();
    if (row) {
      // Over 2 h (minute steps), ending well after the last row, so every bucket with data is whole.
      const from = Number(row.first) - 60_000;
      const to = Number(row.last) + 3 * 3_600_000;
      const res = await get<ProcessCallsResponse>(`/api/process/${row.pid}/${row.start}/calls?from=${from}&to=${to}`);
      assert.equal(res.status, 200);
      const b = res.body;
      assert.ok(b.step >= 60, 'a span over 2 h gets minute steps');
      for (const a of [b.tx, b.rx, b.calls.tx, b.calls.rx]) assert.equal(a.length, b.t.length);
      assert.equal(b.from % (b.step * 1000), 0);
      const sum = (a: number[]) => a.reduce((s, v) => s + v * b.step, 0);
      const near = (got: number, want: number, what: string) => assert.ok(Math.abs(got - want) <= Math.max(2, want * 0.002), `${what}: ${got} vs ${want}`);
      near(sum(b.calls.tx), Number(row.txc), 'tx calls');
      near(sum(b.calls.rx), Number(row.rxc), 'rx calls');
      near((sum(b.tx) * 1000) / 8, Number(row.txb), 'tx bytes');
      near((sum(b.rx) * 1000) / 8, Number(row.rxb), 'rx bytes');
    }
  } finally {
    await ch.close();
  }
  const none = await get<ProcessCallsResponse>('/api/process/1/18446744073709551615/calls');
  assert.equal(none.status, 200);
  assert.ok(none.body.calls.tx.every((v) => v === 0));
  assert.equal((await get('/api/process/x/1/calls')).status, 400);
  assert.equal((await get('/api/process/1/1/calls?from=5&to=1')).status, 400);
});

test('history bytes-per-call: calls per bucket match the table, top keys, filters, one instance', async () => {
  const now = settledNow();
  const ch = createClickHouse(config.clickhouse);
  const sumCalls = (r: { calls: number[] }) => r.calls.reduce((a, v) => a + v, 0);
  try {
    for (const span of [86_400_000, 3_600_000]) {
      for (const dir of ['tx', 'rx'] as const) {
        const res = await get<BytesPerCallResponse>(`/api/history/bytes-per-call?from=${now - span}&to=${now}&dir=${dir}`);
        assert.equal(res.status, 200);
        const b = res.body;
        assert.equal(b.table, span > 7_200_000 ? 'flows_1m' : 'flows');
        assert.deepEqual([b.dir, b.by], [dir, 'app']);
        assert.equal(b.total.calls.length, BPC_BUCKETS);
        assert.ok(b.rows.filter((r) => r.key !== null).length <= 10);
        assert.equal(b.folded > 0, b.rows.some((r) => r.key === null));
        // Rows are most calls first; they add up to the total.
        const keyed = b.rows.filter((r) => r.key !== null);
        keyed.forEach((r, i) => i && assert.ok(r.totalCalls <= keyed[i - 1]!.totalCalls));
        assert.equal(b.rows.reduce((a, r) => a + r.totalCalls, 0), b.total.totalCalls);
        assert.equal(sumCalls(b.total), b.total.totalCalls);
        // Every call with payload counted once: the table's calls in range.
        const col = b.table === 'flows' ? 'ts' : 'minute';
        const time =
          col === 'ts'
            ? 'ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})'
            : 'minute >= toDateTime(intDiv({from:Int64}, 1000)) AND minute < toDateTime(intDiv({to:Int64}, 1000))';
        const rs = await ch.query({
          query: `SELECT sum(${dir}_calls) AS c, sum(${dir}_bytes) AS b FROM ${b.table} WHERE ${time} AND ${dir}_calls > 0`,
          query_params: { from: b.from, to: b.to },
          format: 'JSONEachRow',
        });
        const [want] = await rs.json<{ c: string; b: string }>();
        assert.equal(b.total.totalCalls, Number(want!.c), `${span} ${dir} calls`);
        assert.equal(b.total.totalBytes, Number(want!.b), `${span} ${dir} bytes`);
        // A filter keeps one key.
        const top = keyed[0]?.key;
        if (top) {
          const one = (await get<BytesPerCallResponse>(`/api/history/bytes-per-call?from=${now - span}&to=${now}&dir=${dir}&app=${encodeURIComponent(top)}`)).body;
          assert.deepEqual(
            one.rows.map((r) => r.key),
            [top],
          );
          assert.deepEqual(one.total.calls, keyed[0]!.calls);
        }
      }
    }
    // by=name, with a uid filter (the rollup joins processes).
    const byName = await get<BytesPerCallResponse>(`/api/history/bytes-per-call?from=${now - 86_400_000}&to=${now}&by=name&uid=0`);
    assert.equal(byName.status, 200);
    assert.equal(byName.body.by, 'name');

    // One instance: history ?pid&start and the process route agree, from raw flows.
    const rs = await ch.query({
      query: `SELECT pid, toString(proc_start) AS start, toUnixTimestamp64Milli(min(ts)) AS first, toUnixTimestamp64Milli(max(ts)) AS last, sum(tx_calls) AS c
              FROM flows WHERE tx_calls > 0 GROUP BY pid, proc_start ORDER BY c DESC LIMIT 1`,
      format: 'JSONEachRow',
    });
    const [row] = await rs.json<{ pid: number; start: string; first: string; last: string; c: string }>();
    if (row) {
      const range = `from=${Number(row.first) - 1000}&to=${Number(row.last) + 3 * 3_600_000}`;
      const a = await get<BytesPerCallResponse>(`/api/process/${row.pid}/${row.start}/bytes-per-call?${range}`);
      const h = await get<BytesPerCallResponse>(`/api/history/bytes-per-call?${range}&pid=${row.pid}&start=${row.start}`);
      assert.equal(a.status, 200);
      assert.equal(a.body.table, 'flows');
      assert.equal(a.body.total.totalCalls, Number(row.c));
      assert.deepEqual(h.body, a.body);
    }
  } finally {
    await ch.close();
  }
  const none = await get<BytesPerCallResponse>('/api/process/1/18446744073709551615/bytes-per-call');
  assert.equal(none.status, 200);
  assert.deepEqual([none.body.rows, none.body.total.totalCalls], [[], 0]);
  for (const q of ['dir=both', 'by=uid', 'pid=1', 'pid=x&start=1', 'from=5&to=1']) assert.equal((await get(`/api/history/bytes-per-call?${q}`)).status, 400, q);
  assert.equal((await get('/api/process/1/1/bytes-per-call?dir=sum')).status, 400);
});

test('history lifecycle: processes whose first I/O or end is in range, largest first, filters', async () => {
  const now = settledNow();
  const range = `from=${now - 7 * 86_400_000}&to=${now}`;
  const all = await get<LifecycleResponse>(`/api/history/lifecycle?${range}`);
  assert.equal(all.status, 200);
  assert.equal(typeof all.body.truncated, 'boolean');
  assert.ok(all.body.procs.length <= 200);
  const inRange = (t: number | null) => t !== null && t >= all.body.from && t < all.body.to;
  for (const p of all.body.procs) {
    assert.match(p.id, /^\d+:\d+$/);
    assert.equal(p.id.split(':')[0], String(p.pid));
    assert.equal(typeof p.name, 'string');
    assert.ok(p.cmdline.length <= 120);
    assert.ok(Number.isFinite(p.bytes) && p.bytes >= 0);
    assert.ok(inRange(p.firstSeenMs) || inRange(p.endedMs), p.id);
  }
  for (let i = 1; i < all.body.procs.length; i++) assert.ok(all.body.procs[i - 1]!.bytes >= all.body.procs[i]!.bytes, 'largest first');

  const first = all.body.procs[0];
  if (first) {
    // The id opens the process page.
    const [pid, start] = first.id.split(':');
    assert.equal((await get(`/api/process/${pid}/${start}`)).status, 200);
    const named = await get<LifecycleResponse>(`/api/history/lifecycle?${range}&names=${encodeURIComponent(first.name)},no-such-proc`);
    assert.equal(named.status, 200);
    assert.ok(named.body.procs.length > 0);
    for (const p of named.body.procs) assert.equal(p.name, first.name);
    const one = await get<LifecycleResponse>(`/api/history/lifecycle?${range}&limit=1`);
    assert.equal(one.body.procs.length, 1);
    assert.equal(one.body.truncated, all.body.procs.length > 1);
  }
  const none = await get<LifecycleResponse>(`/api/history/lifecycle?${range}&names=no-such-proc`);
  assert.deepEqual(none.body.procs, []);
  const empty = await get<LifecycleResponse>(`/api/history/lifecycle?from=1000&to=2000`);
  assert.deepEqual(empty.body.procs, []);

  for (const q of ['limit=0', 'limit=1001', 'uid=x', `names=${Array.from({ length: 51 }, (_, i) => i).join(',')}`, 'from=5&to=4']) {
    assert.equal((await get(`/api/history/lifecycle?${q}`)).status, 400, q);
  }
});

test('history lifetimes: instances overlapping the range, latest start first, name/uid filters, cap', async () => {
  const now = settledNow();
  const from = now - 7 * 86_400_000;
  const range = `from=${from}&to=${now}`;
  const all = await get<LifetimesResponse>(`/api/history/lifetimes?${range}`);
  assert.equal(all.status, 200);
  assert.equal(all.body.from, from);
  assert.equal(typeof all.body.truncated, 'boolean');
  assert.ok(all.body.bars.length <= 500);
  const ids = new Set<string>();
  for (const b of all.body.bars) {
    assert.match(b.id, /^\d+:\d+$/);
    assert.equal(b.id.split(':')[0], String(b.pid));
    assert.ok(!ids.has(b.id), `one row per instance: ${b.id}`);
    ids.add(b.id);
    assert.ok(b.cmdline.length <= 120);
    assert.ok(Number.isFinite(b.tx) && Number.isFinite(b.rx) && b.tx >= 0 && b.rx >= 0);
    // Overlaps the range; first I/O never before the start.
    assert.ok(b.startMs < now, b.id);
    assert.ok(b.endedMs === null || b.endedMs >= from, b.id);
    assert.ok(b.firstSeenMs >= b.startMs, b.id);
  }
  for (let i = 1; i < all.body.bars.length; i++) assert.ok(all.body.bars[i - 1]!.startMs >= all.body.bars[i]!.startMs, 'latest start first');

  const first = all.body.bars[0];
  if (first) {
    // The id opens the process page, which agrees on the times.
    const [pid, start] = first.id.split(':');
    const proc = await get<ProcessInfo>(`/api/process/${pid}/${start}`);
    assert.equal(proc.status, 200);
    assert.equal(proc.body.start_ms, first.startMs);
    assert.equal(proc.body.ended_ms, first.endedMs);
    const named = await get<LifetimesResponse>(`/api/history/lifetimes?${range}&name=${encodeURIComponent(first.name)}`);
    assert.ok(named.body.bars.some((b) => b.id === first.id));
    for (const b of named.body.bars) assert.equal(b.name, first.name);
    const byUid = await get<LifetimesResponse>(`/api/history/lifetimes?${range}&uid=${first.uid}`);
    assert.ok(byUid.body.bars.length > 0);
    for (const b of byUid.body.bars) assert.equal(b.uid, first.uid);
    const one = await get<LifetimesResponse>(`/api/history/lifetimes?${range}&limit=1`);
    assert.deepEqual(
      one.body.bars.map((b) => b.id),
      [first.id],
    );
    assert.equal(one.body.truncated, all.body.bars.length > 1);
    // A range that ends before the instance started leaves it out.
    const before = await get<LifetimesResponse>(`/api/history/lifetimes?from=${first.startMs - 60_000}&to=${first.startMs}&name=${encodeURIComponent(first.name)}`);
    assert.ok(!before.body.bars.some((b) => b.id === first.id));
  }
  const none = await get<LifetimesResponse>(`/api/history/lifetimes?${range}&name=no-such-proc`);
  assert.deepEqual(none.body.bars, []);
  const empty = await get<LifetimesResponse>(`/api/history/lifetimes?from=1000&to=2000`);
  assert.deepEqual(empty.body.bars, []);

  for (const q of ['limit=0', 'limit=2001', 'uid=x', `name=${'x'.repeat(300)}`, 'from=5&to=4']) {
    assert.equal((await get(`/api/history/lifetimes?${q}`)).status, 400, q);
  }
});

test('history scatter: per instance or name, lifetime or range, largest first, filters', async () => {
  const now = settledNow();
  const range = `from=${now - 7 * 86_400_000}&to=${now}`;
  const check = (b: ScatterResponse, group: string, basis: string) => {
    assert.equal(b.group, group);
    assert.equal(b.basis, basis);
    assert.equal(typeof b.truncated, 'boolean');
    for (const p of b.points) {
      assert.match(p.id, /^\d+:\d+$/);
      assert.equal(p.id.split(':')[0], String(p.pid));
      assert.ok(Number.isFinite(p.tx) && Number.isFinite(p.rx) && p.tx + p.rx > 0, p.id);
      assert.ok(p.cmdline.length <= 300);
      assert.ok(p.instances >= 1);
      if (group === 'instance') assert.equal(p.instances, 1);
      if (basis === 'lifetime') {
        // Lifetime overlaps the range.
        assert.ok(p.startMs !== null && p.startMs < b.to, p.id);
        assert.ok(p.endedMs === null || p.endedMs >= b.from, p.id);
      }
    }
    for (let i = 1; i < b.points.length; i++) assert.ok(b.points[i - 1]!.tx + b.points[i - 1]!.rx >= b.points[i]!.tx + b.points[i]!.rx, 'largest first');
  };
  const res: Record<string, ScatterResponse> = {};
  for (const group of ['instance', 'name']) {
    for (const basis of ['lifetime', 'range']) {
      const r = await get<ScatterResponse>(`/api/history/scatter?${range}&group=${group}&basis=${basis}`);
      assert.equal(r.status, 200, `${group}/${basis}`);
      check(r.body, group, basis);
      res[`${group}/${basis}`] = r.body;
    }
  }
  // Per name: one point per name, instances add up to the instance points.
  const byName = res['name/lifetime']!;
  assert.equal(new Set(byName.points.map((p) => p.name)).size, byName.points.length);
  if (!res['instance/lifetime']!.truncated && !byName.truncated) {
    assert.equal(
      byName.points.reduce((n, p) => n + p.instances, 0),
      res['instance/lifetime']!.points.length,
    );
  }
  const top = res['instance/range']!.points[0];
  if (top) {
    // The id opens the process page; the name filter keeps only that name.
    const [pid, start] = top.id.split(':');
    assert.equal((await get(`/api/process/${pid}/${start}`)).status, 200);
    const named = await get<ScatterResponse>(`/api/history/scatter?${range}&name=${encodeURIComponent(top.name)}`);
    assert.equal(named.status, 200);
    assert.ok(named.body.points.length > 0);
    for (const p of named.body.points) assert.equal(p.name, top.name);
    const one = await get<ScatterResponse>(`/api/history/scatter?${range}&basis=range&limit=1`);
    assert.equal(one.body.points.length, 1);
    assert.equal(one.body.truncated, res['instance/range']!.points.length > 1);
  }
  const uid = await get<ScatterResponse>(`/api/history/scatter?${range}&basis=range&uid=0`);
  assert.equal(uid.status, 200);
  const none = await get<ScatterResponse>(`/api/history/scatter?${range}&name=no-such-proc`);
  assert.deepEqual(none.body.points, []);
  const empty = await get<ScatterResponse>(`/api/history/scatter?from=1000&to=2000&basis=range`);
  assert.deepEqual(empty.body.points, []);
  for (const q of ['group=uid', 'basis=total', 'limit=0', 'limit=5001', 'uid=x', 'from=5&to=4']) {
    assert.equal((await get(`/api/history/scatter?${q}`)).status, 400, q);
  }
});

test('history heatmap: 168 cells per grid, bytes match the summary, metrics, split, tz, filters', async () => {
  // Minute-aligned, so the heatmap's and the summary's rollup edges agree.
  const to = Math.floor(Date.now() / 60_000) * 60_000;
  const from = to - 28 * 86_400_000;
  const range = `from=${from}&to=${to}`;
  const check = (b: HeatmapResponse) => {
    assert.equal(b.samples.length, 168);
    for (const g of b.grids) {
      assert.equal(g.kbps.length, 168);
      assert.equal(g.active.length, 168);
      g.kbps.forEach((v, i) => {
        if (b.samples[i] === 0) assert.equal(v, null);
        else assert.ok(v !== null && v >= 0, `cell ${i}`);
        assert.ok(g.active[i]! <= b.samples[i]!, `active ≤ samples, cell ${i}`);
      });
      // The cells' rates give back the grid's bytes.
      const back = g.kbps.reduce<number>((s, v, i) => s + ((v ?? 0) * b.samples[i]! * 3600 * 1000) / 8, 0);
      assert.ok(Math.abs(back - g.bytes) <= Math.max(1, g.bytes * 1e-9), `${back} vs ${g.bytes}`);
    }
    for (let i = 1; i < b.grids.length; i++) assert.ok(b.grids[i - 1]!.bytes >= b.grids[i]!.bytes, 'largest first');
  };
  const all = await get<HeatmapResponse>(`/api/history/heatmap?${range}&tz=UTC`);
  assert.equal(all.status, 200);
  check(all.body);
  assert.equal(all.body.tz, 'UTC');
  assert.equal(all.body.split, 'none');
  assert.ok(all.body.grids.length <= 1);
  assert.equal(all.body.grids[0]?.key ?? null, null);
  const sum = await get<HistorySummary>(`/api/history/summary?${range}`);
  assert.equal(all.body.grids[0]?.bytes ?? 0, sum.body.txBytes + sum.body.rxBytes);
  if (all.body.coveredFrom !== null) {
    assert.ok(all.body.coveredFrom >= from);
    // Four whole weeks of samples at most, fewer where the data starts later.
    assert.ok(all.body.samples.every((n) => n <= 5));
  }

  const tx = await get<HeatmapResponse>(`/api/history/heatmap?${range}&tz=UTC&metric=tx`);
  const rx = await get<HeatmapResponse>(`/api/history/heatmap?${range}&tz=UTC&metric=rx`);
  assert.equal((tx.body.grids[0]?.bytes ?? 0) + (rx.body.grids[0]?.bytes ?? 0), all.body.grids[0]?.bytes ?? 0);

  // Another zone moves bytes between cells, not in total.
  const ny = await get<HeatmapResponse>(`/api/history/heatmap?${range}&tz=${encodeURIComponent('America/New_York')}`);
  assert.equal(ny.status, 200);
  check(ny.body);
  assert.equal(ny.body.grids[0]?.bytes ?? 0, all.body.grids[0]?.bytes ?? 0);

  const split = await get<HeatmapResponse>(`/api/history/heatmap?${range}&tz=UTC&split=app`);
  assert.equal(split.status, 200);
  check(split.body);
  assert.ok(split.body.grids.length <= 4);
  assert.ok(split.body.grids.every((g) => typeof g.key === 'string'));
  assert.ok(split.body.grids.reduce((s, g) => s + g.bytes, 0) <= (all.body.grids[0]?.bytes ?? 0));
  const top = split.body.grids[0];
  if (top) {
    const one = await get<HeatmapResponse>(`/api/history/heatmap?${range}&tz=UTC&app=${encodeURIComponent(top.key!)}`);
    assert.equal(one.body.grids[0]!.bytes, top.bytes);
  }
  // The default window is four weeks.
  const def = await get<HeatmapResponse>('/api/history/heatmap');
  assert.equal(def.status, 200);
  assert.equal(def.body.to - def.body.from, 28 * 86_400_000);
  const uid = await get<HeatmapResponse>(`/api/history/heatmap?${range}&uid=0`);
  assert.equal(uid.status, 200);
  const none = await get<HeatmapResponse>(`/api/history/heatmap?${range}&name=no-such-proc`);
  assert.deepEqual(none.body.grids, []);
  for (const q of ['metric=bytes', 'split=name', 'tz=Mars/Base', 'from=5&to=4', `from=0&to=${400 * 86_400_000}`, 'uid=x']) {
    assert.equal((await get(`/api/history/heatmap?${q}`)).status, 400, q);
  }
});

test('history treemap: users → processes → apps, sums match the summary, dir, both tables, filters', async () => {
  const to = Math.floor(Date.now() / 60_000) * 60_000;
  const check = (b: TreemapResponse) => {
    assert.equal(b.top, 30);
    assert.equal(b.total, b.users.reduce((s, u) => s + u.value, 0));
    for (let i = 1; i < b.users.length; i++) assert.ok(b.users[i - 1]!.value >= b.users[i]!.value, 'users largest first');
    for (const u of b.users) {
      assert.equal(typeof u.uid, 'number');
      assert.ok(u.name.length > 0);
      assert.ok(u.children.length <= 31, `${u.name}: at most 30 processes + other`);
      assert.equal(u.value, u.children.reduce((s, p) => s + p.value, 0));
      u.children.forEach((p, i) => {
        if (p.folded !== undefined) {
          assert.equal(i, u.children.length - 1, 'other last');
          assert.ok(p.folded >= 2);
          assert.match(p.name, /^other \(\d+ processes\)$/);
        }
        assert.ok(p.value > 0);
        assert.equal(p.value, p.children.reduce((s, a) => s + a.value, 0));
      });
    }
  };
  for (const span of [3600_000, 24 * 3600_000]) {
    const range = `from=${to - span}&to=${to}`;
    const all = await get<TreemapResponse>(`/api/history/treemap?${range}`);
    assert.equal(all.status, 200);
    check(all.body);
    assert.equal(all.body.table, span <= 2 * 3600_000 ? 'flows' : 'flows_1m');
    assert.equal(all.body.dir, 'total');
    assert.equal(all.body.truncated, false);
    const sum = await get<HistorySummary>(`/api/history/summary?${range}`);
    assert.equal(all.body.total, sum.body.txBytes + sum.body.rxBytes);
    const tx = await get<TreemapResponse>(`/api/history/treemap?${range}&dir=tx`);
    const rx = await get<TreemapResponse>(`/api/history/treemap?${range}&dir=rx`);
    check(tx.body);
    assert.equal(tx.body.total, sum.body.txBytes);
    assert.equal(rx.body.total, sum.body.rxBytes);
    const u = all.body.users[0];
    if (u) {
      const one = await get<TreemapResponse>(`/api/history/treemap?${range}&uid=${u.uid}`);
      assert.deepEqual(one.body.users.map((x) => x.uid), [u.uid]);
      assert.equal(one.body.total, u.value);
      const p = u.children.find((c) => c.folded === undefined)!;
      const byName = await get<TreemapResponse>(`/api/history/treemap?${range}&name=${encodeURIComponent(p.name)}`);
      assert.ok(byName.body.users.every((x) => x.children.every((c) => c.name === p.name)));
    }
  }
  const none = await get<TreemapResponse>(`/api/history/treemap?from=${to - 3600_000}&to=${to}&name=no-such-proc`);
  assert.deepEqual(none.body.users, []);
  assert.equal(none.body.total, 0);
  for (const q of ['dir=both', 'from=5&to=4', 'uid=x', 'dest=nope']) {
    assert.equal((await get(`/api/history/treemap?${q}`)).status, 400, q);
  }
});

test('history throughput: the rollup query uses the minute key', async () => {
  const now = settledNow();
  const r = alignRange(parseRange({ from: String(now - 30 * 86_400_000), to: String(now) }, now));
  assert.equal(r.table, 'flows_1m');
  const ch = createClickHouse(config.clickhouse);
  try {
    const queries = [
      ['app', throughputQuery(r, 'app', 'both', 8, {})],
      ['uid', throughputQuery(r, 'uid', 'both', 8, {})],
      ['compare', compareQuery(r, 7 * 86_400_000, {})],
      ['compare uid', compareQuery(r, 7 * 86_400_000, { uid: 0 })],
    ] as const;
    for (const [what, { sql, params }] of queries) {
      const rs = await ch.query({ query: `EXPLAIN indexes = 1 ${sql}`, query_params: params, format: 'TabSeparatedRaw' });
      const plan = await rs.text();
      assert.match(plan, /ReadFromMergeTree \(netwatch\.flows_1m\)/, what);
      assert.match(plan, /PrimaryKey\s+Keys:\s+minute\s+Condition: [^\n]*\(minute in \(-Inf, \d+\]\)/, `${what}: primary key on minute`);
    }
  } finally {
    await ch.close();
  }
});

test('history filters apply to summary and flows', async () => {
  const now = settledNow();
  const from = now - 86_400_000;
  const { body } = await get<HistoryFlowsResponse>(`/api/history/flows?from=${from}&to=${now}&limit=20`);
  const top = body.flows[0];
  if (!top) return;
  const flows = await get<HistoryFlowsResponse>(`/api/history/flows?from=${from}&to=${now}&name=${encodeURIComponent(top.name)}&app=${encodeURIComponent(top.app)}`);
  assert.equal(flows.status, 200);
  for (const f of flows.body.flows) assert.deepEqual([f.name, f.app], [top.name, top.app]);
  const all = await get<HistorySummary>(`/api/history/summary?from=${from}&to=${now}`);
  const some = await get<HistorySummary>(`/api/history/summary?from=${from}&to=${now}&name=${encodeURIComponent(top.name)}`);
  assert.equal(some.status, 200);
  assert.ok(some.body.txBytes + some.body.rxBytes <= all.body.txBytes + all.body.rxBytes);
  assert.ok(some.body.processes >= 1);
  const uid = await get<HistorySummary>(`/api/history/summary?from=${from}&to=${now}&uid=0`);
  assert.equal(uid.status, 200);
});

test('live meta: numbers or null', async () => {
  const { status, body } = await get<LiveMeta>('/api/live/meta');
  assert.equal(status, 200);
  assert.equal(typeof body.serverTimeMs, 'number');
  for (const k of ['alive', 'ended'] as const) assert.equal(typeof body[k], 'number', k);
  for (const k of ['lastTickMs', 'intervalMs', 'drops'] as const) assert.ok(body[k] === null || typeof body[k] === 'number', k);
});

test('live events: hello first', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/live/events`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  ctrl.abort();
  assert.match(new TextDecoder().decode(value), /^event: hello\ndata: \{"latestTs":(\d+|null)\}\n\n/);
});

test('history summary: shape, resolution and validation', async () => {
  const now = settledNow();
  const { status, body } = await get<HistorySummary>(`/api/history/summary?from=${now - 7 * 86_400_000}&to=${now}`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body.range).sort(), ['from', 'step', 'table', 'to']);
  assert.equal(body.range.table, 'flows_1m');
  for (const k of ['txBytes', 'rxBytes', 'processes'] as const) assert.equal(typeof body[k], 'number', k);

  const raw = await get<HistorySummary>(`/api/history/summary?from=${now - 3_600_000}&to=${now}`);
  assert.equal(raw.body.range.table, 'flows');

  const bad = await get<{ error: string }>(`/api/history/summary?from=${now}&to=${now - 1}`);
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, 'string');
});

test('history ingest: latest ts in ms, rows in the last minute', async () => {
  const { status, body } = await get<HistoryIngest>('/api/history/ingest');
  assert.equal(status, 200);
  assert.equal(typeof body.rows1m, 'number');
  if (body.lastTsMs !== null) {
    assert.equal(typeof body.lastTsMs, 'number');
    assert.ok(Math.abs(body.serverTimeMs - body.lastTsMs) < 11 * 60_000, 'within the 10 min window');
  }
});

test('process: found by pid:start_ns, 404 otherwise', async () => {
  const ch = createClickHouse(config.clickhouse);
  try {
    const rs = await ch.query({ query: 'SELECT pid, toString(proc_start) AS start FROM processes LIMIT 1', format: 'JSONEachRow' });
    const [row] = await rs.json<{ pid: number; start: string }>();
    if (row) {
      const { status, body } = await get<ProcessInfo>(`/api/process/${row.pid}/${row.start}`);
      assert.equal(status, 200);
      assert.equal(body.start_ns, row.start);
      for (const k of ['start_ms', 'first_seen_ms', 'last_seen_ms', 'tx_total', 'rx_total'] as const) assert.equal(typeof body[k], 'number', k);
    }
  } finally {
    await ch.close();
  }
  assert.equal((await get('/api/process/1/18446744073709551615')).status, 404);
  assert.equal((await get('/api/process/x/1')).status, 400);
});

test('ClickHouse: DISPLAY_IP and toIPv6 round-trip', async () => {
  const ch = createClickHouse(config.clickhouse);
  try {
    const rs = await ch.query({
      query: `SELECT ${DISPLAY_IP} AS shown FROM (SELECT arrayJoin([toIPv6({v4:String}), toIPv6({v6:String})]) AS raddr)`,
      query_params: { v4: '1.2.3.4', v6: '2001:db8::1' },
      format: 'JSONEachRow',
    });
    assert.deepEqual(
      (await rs.json<{ shown: string }>()).map((r) => r.shown),
      ['1.2.3.4', '2001:db8::1'],
    );
    const mapped = await ch.query({ query: 'SELECT toIPv6({ip:String}) = toIPv6({m:String}) AS same', query_params: { ip: '1.2.3.4', m: '::ffff:1.2.3.4' }, format: 'JSONEachRow' });
    assert.deepEqual(await mapped.json(), [{ same: 1 }]);
  } finally {
    await ch.close();
  }
});

test('beacons: ticks per destination match the table, periodic first, ranges capped', async () => {
  const now = settledNow();
  const ch = createClickHouse(config.clickhouse);
  const sorted = (b: BeaconsResponse) =>
    b.dests.forEach((d, i) => {
      assert.ok(d.t.every((t, j) => j === 0 || t > d.t[j - 1]!), `${d.dest} times ascending`);
      assert.equal(d.t.length, d.b.length);
      assert.equal(d.t.length, d.gap.length);
      assert.ok(d.t.every((t) => t >= b.from && t < b.to));
      assert.equal(d.score > 0, d.bursts >= 6 && d.cv !== null && d.cv < 0.15, d.dest);
      const prev = b.dests[i - 1];
      if (prev) assert.ok(prev.score > d.score || (prev.score === d.score && prev.ticks >= d.ticks), 'score, then ticks');
    });
  try {
    // The instance with the most active ticks in the last 6 h.
    const rs = await ch.query({
      query: `SELECT pid, toString(proc_start) AS start, any(name) AS name FROM flows WHERE ts > now() - INTERVAL 6 HOUR
              GROUP BY pid, proc_start ORDER BY uniqExact(ts) DESC LIMIT 1`,
      format: 'JSONEachRow',
    });
    const [row] = await rs.json<{ pid: number; start: string; name: string }>();
    if (row) {
      const from = now - 6 * 3_600_000;
      const res = await get<BeaconsResponse>(`/api/process/${row.pid}/${row.start}/beacons?from=${from}&to=${now}`);
      assert.equal(res.status, 200);
      const b = res.body;
      assert.deepEqual([b.from, b.to, b.scope, b.capped], [from, now, 'instance', false]);
      assert.ok(b.dests.length > 0 && b.dests.length <= 100);
      sorted(b);
      // The busiest destination's ticks are its distinct tick times in the table.
      const top = [...b.dests].sort((x, y) => y.ticks - x.ticks)[0]!;
      const q = await ch.query({
        query: `SELECT uniqExact(ts) AS n, sum(tx_bytes + rx_bytes) AS bytes FROM flows
                WHERE pid = {pid:UInt32} AND proc_start = {start:UInt64} AND raddr = toIPv6({ip:String}) AND rport = {port:UInt16}
                  AND proto = {proto:String} AND app = {app:String}
                  AND ts >= fromUnixTimestamp64Milli({from:Int64}) AND ts < fromUnixTimestamp64Milli({to:Int64})`,
        query_params: { pid: row.pid, start: row.start, ip: top.ip, port: top.rport, proto: top.proto, app: top.app, from, to: now },
        format: 'JSONEachRow',
      });
      const [want] = await q.json<{ n: string; bytes: string }>();
      assert.equal(top.ticks, Number(want!.n));
      assert.equal(top.bytes, Number(want!.bytes));

      // Default range: the instance's networked lifetime, cut to 24 h.
      const def = (await get<BeaconsResponse>(`/api/process/${row.pid}/${row.start}/beacons`)).body;
      assert.ok(def.to - def.from <= 24 * 3_600_000 && def.to <= Date.now());
      assert.equal(def.capped, def.to - def.from === 24 * 3_600_000);
      // An explicit range over 24 h keeps its last 24 h.
      const long = (await get<BeaconsResponse>(`/api/process/${row.pid}/${row.start}/beacons?from=${now - 48 * 3_600_000}&to=${now}`)).body;
      assert.deepEqual([long.from, long.to, long.capped], [now - 24 * 3_600_000, now, true]);

      // Name scope: every instance of the name, one row per (ip, port), capped at 6 h.
      const byName = await get<BeaconsResponse>(`/api/history/beacons?name=${encodeURIComponent(row.name)}&from=${now - 12 * 3_600_000}&to=${now}`);
      assert.equal(byName.status, 200);
      assert.deepEqual([byName.body.scope, byName.body.from, byName.body.capped], ['name', now - 6 * 3_600_000, true]);
      sorted(byName.body);
      assert.equal(new Set(byName.body.dests.map((d) => d.dest)).size, byName.body.dests.length, 'one row per destination');
      // Merging instances never loses a tick: each destination has at least this instance's ticks.
      for (const d of b.dests) {
        const merged = byName.body.dests.find((x) => x.dest === d.dest);
        if (merged) assert.ok(merged.ticks >= d.ticks, d.dest);
      }
    }
  } finally {
    await ch.close();
  }
  const none = await get<BeaconsResponse>('/api/process/1/18446744073709551615/beacons');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.dests, []);
  assert.equal((await get('/api/history/beacons')).status, 400);
  assert.equal((await get('/api/history/beacons?name=x&from=5&to=1')).status, 400);
  assert.equal((await get('/api/process/x/1/beacons')).status, 400);
});

test('new destinations: first contacts match the rollup, exclusions counted, options and bad params', async () => {
  const now = settledNow();
  const range = `from=${now - 7 * 86_400_000}&to=${now}`;
  // Warm-up shown: on a young table everything is in it.
  const all = await get<NewDestsResponse>(`/api/history/new-dests?${range}&warmup=1`);
  assert.equal(all.status, 200);
  assert.equal(all.body.ports, false);
  const ds = all.body.dests;
  assert.ok(ds.length <= 500);
  for (let i = 1; i < ds.length; i++) assert.ok(ds[i - 1]!.firstMs <= ds[i]!.firstMs, 'oldest first');
  for (const d of ds) {
    assert.ok(d.firstMs >= all.body.from - 60_000 && d.firstMs < all.body.to, d.dest);
    assert.ok(d.ip !== '0.0.0.0' && d.ip !== '::', 'no-peer receivers never count');
    assert.equal(d.loopback, false, 'loopback hidden by default');
    assert.match(d.id, /^\d+:\d+$/);
    assert.ok(d.firstHourBytes >= 0);
  }
  const plain = await get<NewDestsResponse>(`/api/history/new-dests?${range}`);
  assert.equal(plain.status, 200);
  for (const d of plain.body.dests) assert.equal(d.warmup, false);
  if (all.body.warmupUntil !== null) {
    // Without warm-up, exactly the warm-up rows are left out and counted.
    const warm = ds.filter((d) => d.warmup).length;
    if (!all.body.truncated && !plain.body.truncated) {
      assert.equal(plain.body.dests.length, ds.length - warm);
      assert.equal(plain.body.hidden.warmup, warm);
    }
  }

  // A sample checked against flows_1m: nothing of (name, ip) before the first contact.
  const ch = createClickHouse(config.clickhouse);
  try {
    for (const d of ds.slice(0, 5)) {
      const rs = await ch.query({
        query: `SELECT toUnixTimestamp(min(minute)) AS m FROM flows_1m WHERE name = {name:String} AND raddr = toIPv6({ip:String})`,
        query_params: { name: d.name, ip: d.ip },
        format: 'JSONEachRow',
      });
      const [row] = await rs.json<{ m: number }>();
      assert.equal(Number(row!.m) * 1000, d.firstMs, `${d.name} ${d.dest}`);
    }
  } finally {
    await ch.close();
  }

  const lo = await get<NewDestsResponse>(`/api/history/new-dests?${range}&warmup=1&loopback=1`);
  assert.equal(lo.body.hidden.loopback, 0);
  if (!lo.body.truncated && !all.body.truncated) assert.equal(lo.body.dests.length, ds.length + all.body.hidden.loopback);
  for (const d of lo.body.dests) if (d.loopback) assert.ok(d.ip.startsWith('127.') || d.ip === '::1', d.ip);

  const first = ds[0];
  if (first) {
    const named = await get<NewDestsResponse>(`/api/history/new-dests?${range}&warmup=1&name=${encodeURIComponent(first.name)}`);
    assert.ok(named.body.dests.length > 0);
    for (const d of named.body.dests) assert.equal(d.name, first.name);
    const ports = await get<NewDestsResponse>(`/api/history/new-dests?${range}&warmup=1&ports=1&names=${encodeURIComponent(first.name)}`);
    assert.equal(ports.body.ports, true);
    // Per port, an address can only gain keys.
    assert.ok(ports.body.dests.length >= named.body.dests.length);
    const one = await get<NewDestsResponse>(`/api/history/new-dests?${range}&warmup=1&limit=1`);
    assert.equal(one.body.dests.length, 1);
    assert.equal(one.body.truncated, ds.length > 1);
  }
  const none = await get<NewDestsResponse>(`/api/history/new-dests?${range}&warmup=1&name=no-such-proc`);
  assert.deepEqual(none.body.dests, []);
  for (const q of ['limit=0', 'limit=2001', 'ports=2', 'warmup=yes', 'from=5&to=4']) {
    assert.equal((await get(`/api/history/new-dests?${q}`)).status, 400, q);
  }
});

// 18: a fixed past range of whole minutes, so the collector's writes do not move the sums between queries.
const geoRange = () => {
  const to = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
  return `from=${to - 7 * 86_400_000}&to=${to}`;
};

test('geo: health reports the fixture table, rdns off', async () => {
  const { body } = await get<HealthResponse>('/api/health');
  assert.equal(body.geo.loaded, true);
  assert.equal(body.geo.entries, 20);
  assert.equal(body.geo.error, null);
  assert.equal(typeof body.geo.fileDate, 'number');
  assert.equal(body.rdns, false);
});

test('geo asn / countries: grouped per-IP sums add up to the summary, largest first, dir, filters, bad params', async () => {
  const range = geoRange();
  const [asn, countries, summary] = await Promise.all([
    get<AsnResponse>(`/api/history/asn?${range}`),
    get<CountriesResponse>(`/api/history/countries?${range}`),
    get<HistorySummary>(`/api/history/summary?${range}`),
  ]);
  assert.equal(asn.status, 200);
  const a = asn.body;
  assert.equal(a.geo, true);
  assert.equal(a.table, 'flows_1m');
  assert.equal(a.dir, 'total');
  const sum = (rows: { bytes: number }[]) => rows.reduce((s, r) => s + r.bytes, 0);
  assert.equal(sum(a.rows) + a.local.bytes + a.unmatched.bytes, a.coverage.bytes, 'every examined byte lands in one group');
  assert.ok(a.coverage.ips <= 5000 && a.coverage.ips <= a.coverage.totalIps);
  if (a.coverage.ips < a.coverage.totalIps) assert.ok(a.coverage.bytes <= a.coverage.totalBytes);
  else assert.equal(a.coverage.bytes, a.coverage.totalBytes);
  assert.equal(a.coverage.totalBytes, summary.body.txBytes + summary.body.rxBytes, 'totals match the summary');
  for (let i = 1; i < a.rows.length; i++) assert.ok(a.rows[i - 1]!.bytes >= a.rows[i]!.bytes, 'largest first');
  for (const r of a.rows) {
    assert.equal(r.bytes, r.tx + r.rx);
    assert.ok(r.asn > 0 && r.ips > 0 && typeof r.org === 'string');
  }
  // The data has plenty of Google (IPv6) and loopback traffic; the fixture knows Google.
  assert.ok(a.rows.some((r) => r.asn === 15169 && r.org === 'Google LLC' && r.country === 'US'));
  assert.ok(a.local.ips > 0);

  assert.equal(countries.status, 200);
  const c = countries.body;
  assert.deepEqual(c.local, a.local);
  assert.equal(sum(c.rows), sum(a.rows), 'every fixture range has a country');
  assert.ok(c.rows.some((r) => r.country === 'US'));

  const tx = await get<AsnResponse>(`/api/history/asn?${range}&dir=tx`);
  assert.equal(tx.body.dir, 'tx');
  for (const r of tx.body.rows) assert.equal(r.bytes, r.tx);
  assert.equal(tx.body.coverage.totalBytes, summary.body.txBytes);

  const none = await get<AsnResponse>(`/api/history/asn?${range}&app=no-such-app`);
  assert.deepEqual(none.body.rows, []);
  assert.equal(none.body.coverage.totalBytes, 0);

  for (const q of ['dir=both', 'from=5&to=4', 'uid=x']) {
    assert.equal((await get(`/api/history/asn?${q}`)).status, 400, q);
    assert.equal((await get(`/api/history/countries?${q}`)).status, 400, q);
  }
});

test('geo destinations: (ip, port) rows with geo, selections, limit, bad params', async () => {
  const range = geoRange();
  const all = await get<DestinationsResponse>(`/api/history/destinations?${range}&limit=2000`);
  assert.equal(all.status, 200);
  const d = all.body;
  assert.equal(d.geo, true);
  assert.equal(d.rdns, false);
  assert.ok(d.rows.length > 0);
  assert.ok(d.matched >= d.rows.length && d.matched <= 5000);
  if (d.matched <= 2000) assert.equal(d.matched, d.rows.length);
  for (let i = 1; i < d.rows.length; i++) assert.ok(d.rows[i - 1]!.tx + d.rows[i - 1]!.rx >= d.rows[i]!.tx + d.rows[i]!.rx, 'largest first');
  for (const r of d.rows) {
    assert.equal(r.dest, r.ip.includes(':') ? `[${r.ip}]:${r.port}` : `${r.ip}:${r.port}`);
    assert.ok(r.procs >= 1 && r.names.length >= 1 && r.names.length <= 5);
    if (r.local) assert.equal(r.geo, undefined);
  }
  assert.ok(d.rows.some((r) => r.ip === '127.0.0.1' && r.local));
  assert.ok(d.rows.some((r) => r.geo?.asn === 15169));

  const asn = await get<AsnResponse>(`/api/history/asn?${range}`);
  const google = asn.body.rows.find((r) => r.asn === 15169)!;
  const g = await get<DestinationsResponse>(`/api/history/destinations?${range}&asn=15169&limit=2000`);
  assert.ok(g.body.rows.length > 0);
  for (const r of g.body.rows) assert.equal(r.geo?.asn, 15169);
  // Per (ip, port) sums of one ASN add up to its per-IP sums, when no pair was cut.
  if (!g.body.truncated && g.body.rows.length === g.body.matched) assert.equal(g.body.rows.reduce((s, r) => s + r.tx + r.rx, 0), google.bytes);

  const us = await get<DestinationsResponse>(`/api/history/destinations?${range}&cc=US&limit=5`);
  assert.ok(us.body.rows.length <= 5);
  assert.ok(us.body.matched >= us.body.rows.length);
  for (const r of us.body.rows) assert.equal(r.geo?.cc, 'US');
  const local = await get<DestinationsResponse>(`/api/history/destinations?${range}&scope=local`);
  for (const r of local.body.rows) assert.equal(r.local, true);
  const unmatched = await get<DestinationsResponse>(`/api/history/destinations?${range}&scope=unmatched`);
  for (const r of unmatched.body.rows) assert.ok(!r.local && !r.geo);

  for (const q of ['asn=0', 'asn=AS1', 'cc=us', 'scope=x', 'limit=0', 'limit=2001', 'dir=both']) {
    assert.equal((await get(`/api/history/destinations?${q}`)).status, 400, q);
  }
});

test('geo enrichment: flows, throughput by dest and new-dests carry geo for known IPs only', async () => {
  const range = geoRange();
  const flows = await get<HistoryFlowsResponse>(`/api/history/flows?${range}&limit=500`);
  assert.ok(flows.body.flows.some((f) => f.geo?.asn === 15169));
  for (const f of flows.body.flows) {
    if (f.ip === '127.0.0.1' || f.ip.startsWith('192.168.') || f.ip === '0.0.0.0') assert.equal(f.geo, undefined, f.ip);
  }
  const tp = await get<ThroughputResponse>(`/api/history/throughput?${range}&by=dest&top=20`);
  assert.equal(tp.status, 200);
  for (const [key, geo] of Object.entries(tp.body.geo ?? {})) {
    assert.ok(tp.body.keys.includes(key));
    assert.equal(tp.body.labels[key], orgDestLabel(geo, key));
  }
  const nd = await get<NewDestsResponse>(`/api/history/new-dests?${range}&warmup=1&loopback=1`);
  for (const d of nd.body.dests) if (d.loopback) assert.equal(d.geo, undefined);
  const live = await get<LiveFlowsResponse>('/api/live/flows?seconds=30');
  for (const f of live.body.flows) if (f.geo) assert.ok(f.geo.asn > 0);
});

test('rdns: off unless RDNS=1, addresses validated', async () => {
  const r = await get<RdnsResponse>('/api/rdns?ips=1.1.1.1,2606:4700::1111');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { enabled: false, names: {}, pending: [] });
  assert.equal((await get('/api/rdns?ips=example.com')).status, 400);
});
