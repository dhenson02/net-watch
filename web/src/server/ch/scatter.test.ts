import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRange } from './range.ts';
import { parseBasis, parseGroup, scatterQuery, toScatterPoint } from './scatter.ts';
import { UNKNOWN_UID } from './sql.ts';

const now = 1_789_800_000_000;
const short = parseRange({ from: String(now - 3600_000), to: String(now) }, now);
const long = parseRange({ from: String(now - 7 * 86_400_000), to: String(now) }, now);

test('parseGroup / parseBasis: defaults and whitelist', () => {
  assert.equal(parseGroup(undefined), 'instance');
  assert.equal(parseGroup(''), 'instance');
  assert.equal(parseGroup('name'), 'name');
  assert.throws(() => parseGroup('uid'), /group/);
  assert.throws(() => parseGroup(['name']), /group/);
  assert.equal(parseBasis(undefined), 'lifetime');
  assert.equal(parseBasis('range'), 'range');
  assert.throws(() => parseBasis('total'), /basis/);
});

test('scatterQuery lifetime: processes with argMax, overlap on the lifetime, no flow table without filters', () => {
  const { sql, params } = scatterQuery({ range: long, group: 'instance', basis: 'lifetime', filters: {}, limit: 2001 });
  assert.match(sql, /FROM processes/);
  assert.match(sql, /argMax\(tx_total, version\)/);
  assert.match(sql, /p_start < fromUnixTimestamp64Milli\(\{to:Int64\}\)/);
  assert.match(sql, /p_ended IS NULL OR p_ended >= fromUnixTimestamp64Milli\(\{from:Int64\}\)/);
  assert.doesNotMatch(sql, /flows/);
  assert.match(sql, /LIMIT \{limit:UInt32\}/);
  assert.deepEqual(params, { from: long.from, to: long.to, limit: 2001 });
});

test('scatterQuery: filters keep instances with matching traffic, as params only', () => {
  const { sql, params } = scatterQuery({
    range: long,
    group: 'instance',
    basis: 'lifetime',
    filters: { app: "o'app", uid: 1000 },
    limit: 10,
  });
  assert.match(sql, /\(pid, proc_start\) IN \(SELECT pid, proc_start FROM \(SELECT minute/);
  assert.match(sql, /app = \{f_app:String\}/);
  assert.match(sql, /uid = \{f_uid:UInt32\}/);
  assert.doesNotMatch(sql, /o'app/);
  assert.deepEqual(params, { from: long.from, to: long.to, limit: 10, f_app: "o'app", f_uid: 1000 });
});

test('scatterQuery range: raw flows up to 2 h, the rollup beyond, processes joined', () => {
  const raw = scatterQuery({ range: short, group: 'instance', basis: 'range', filters: {}, limit: 5 }).sql;
  assert.match(raw, /FROM flows\s/);
  assert.match(raw, /ts >= fromUnixTimestamp64Milli/);
  assert.match(raw, /LEFT JOIN/);
  assert.match(raw, new RegExp(`p_uid, ${UNKNOWN_UID}`));
  const rollup = scatterQuery({ range: long, group: 'instance', basis: 'range', filters: {}, limit: 5 }).sql;
  assert.match(rollup, /FROM flows_1m\s/);
  assert.match(rollup, /minute >= toStartOfMinute/);
});

test('scatterQuery name: sums per name, busiest instance id', () => {
  const { sql } = scatterQuery({ range: long, group: 'name', basis: 'lifetime', filters: {}, limit: 5 });
  assert.match(sql, /GROUP BY pname/);
  assert.match(sql, /count\(\) AS n/);
  assert.match(sql, /argMax\(iid, itx \+ irx\) AS id/);
});

test('toScatterPoint: id stays a string, 64-bit values become numbers, nulls kept', () => {
  const row = {
    id: '42:18446744073709551615',
    pid: 42,
    name: 'curl',
    cmd: 'curl x',
    uid: 1000,
    tx: '123',
    rx: '4567',
    n: '1',
    start_ms: '1789785354733',
    ended_ms: null,
    last_ms: '1789785359134',
  };
  assert.deepEqual(toScatterPoint(row, (u) => (u === 1000 ? 'jay' : null)), {
    id: '42:18446744073709551615',
    pid: 42,
    name: 'curl',
    cmdline: 'curl x',
    uid: 1000,
    user: 'jay',
    tx: 123,
    rx: 4567,
    instances: 1,
    startMs: 1789785354733,
    endedMs: null,
    lastSeenMs: 1789785359134,
  });
  const unknown = toScatterPoint({ ...row, uid: UNKNOWN_UID, start_ms: null, last_ms: null }, () => 'root');
  assert.equal(unknown.user, null);
  assert.equal(unknown.startMs, null);
});
