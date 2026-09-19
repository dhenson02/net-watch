// Integration checks against the compose stack (`docker compose up -d --wait`
// in the repo root). Not part of `npm test`; run with `npm run test:int`.
// Starts the real server on a spare port and checks every endpoint's shape.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, test } from 'node:test';
import type {
  CompactTick,
  FlowAgg,
  HealthResponse,
  HistoryFlowsResponse,
  HistoryIngest,
  HistorySummary,
  LifecycleResponse,
  LiveFlowsResponse,
  LiveMeta,
  LiveSnapshotResponse,
  ProcessInfo,
  ScatterResponse,
  ThroughputResponse,
} from '../shared/api.ts';
import { THROUGHPUT_OTHER } from '../shared/api.ts';
import { parseRange } from './ch/range.ts';
import { DISPLAY_IP } from './ch/sql.ts';
import { alignRange, throughputQuery } from './ch/throughput.ts';
import { config } from './config.ts';
import { createClickHouse } from './db/clickhouse.ts';

const PORT = Number(process.env.INT_PORT ?? 8797);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: (await res.json()) as T };
}

before(async () => {
  server = spawn(process.execPath, ['src/server/index.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, WEB_PORT: String(PORT), LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const { body } = await get<HealthResponse>('/api/health');
      if (body.redis.ok) return;
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
  const now = Date.now();
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
  const now = Date.now();
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

test('history lifecycle: processes whose first I/O or end is in range, largest first, filters', async () => {
  const now = Date.now();
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

test('history scatter: per instance or name, lifetime or range, largest first, filters', async () => {
  const now = Date.now();
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

test('history throughput: the rollup query uses the minute key', async () => {
  const now = Date.now();
  const r = alignRange(parseRange({ from: String(now - 30 * 86_400_000), to: String(now) }, now));
  assert.equal(r.table, 'flows_1m');
  const ch = createClickHouse(config.clickhouse);
  try {
    for (const by of ['app', 'uid'] as const) {
      const { sql, params } = throughputQuery(r, by, 'both', 8, {});
      const rs = await ch.query({ query: `EXPLAIN indexes = 1 ${sql}`, query_params: params, format: 'TabSeparatedRaw' });
      const plan = await rs.text();
      assert.match(plan, /ReadFromMergeTree \(netwatch\.flows_1m\)/, by);
      assert.match(plan, /PrimaryKey\s+Keys:\s+minute\s+Condition: [^\n]*\(minute in \(-Inf, \d+\]\)/, `${by}: primary key on minute`);
    }
  } finally {
    await ch.close();
  }
});

test('history filters apply to summary and flows', async () => {
  const now = Date.now();
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
  const now = Date.now();
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
