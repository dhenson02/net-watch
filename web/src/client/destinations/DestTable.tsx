import { useMemo, useState } from 'react';
import type { DestinationsResponse, DestRow, RdnsResponse } from '../../shared/api.ts';
import { getJson, urls, type TimeRange } from '../api.ts';
import { fmtBytes } from '../charts/format.ts';
import { historyHref } from '../process/beaconStrip.ts';
import { Link } from '../router.ts';
import { asnLabel, countryName } from './geoView.ts';

/** Rows shown until expanded. */
const TABLE_ROWS = 50;
/** Addresses per reverse-DNS request (the server's per-request budget). */
const RDNS_BATCH = 20;

type SortKey = 'dest' | 'name' | 'network' | 'country' | 'protocol' | 'tx' | 'rx' | 'procs';
type Sort = { key: SortKey; desc: boolean };
/** Text columns start ascending, numeric ones descending. */
const TEXT_KEYS: SortKey[] = ['dest', 'name', 'network', 'country', 'protocol'];

function SortHeader(props: { sort: Sort | null; k: SortKey; label: string; num?: boolean; onSort: (k: SortKey) => void }) {
  const { sort, k, label, num, onSort } = props;
  const active = sort?.key === k;
  return (
    <th className={num ? 'tt-num' : undefined} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" className={`th-sort${active ? ' active' : ''}`} onClick={() => onSort(k)}>
        {label}
        <span className="th-arrow" aria-hidden="true">
          {active ? (sort.desc ? '▾' : '▴') : ''}
        </span>
      </button>
    </th>
  );
}

type Props = {
  data: DestinationsResponse;
  range: TimeRange;
  onAsn: (asn: number) => void;
  onCountry: (cc: string) => void;
};

/**
 * 18: one row per (ip, port): reverse DNS (on demand, when the server allows
 * it), network, country, main app, bytes each way and the processes. The
 * address links to History filtered to it over the same range.
 */
export function DestTable({ data, range, onAsn, onCountry }: Props) {
  const [all, setAll] = useState(false);
  const [names, setNames] = useState<Record<string, string | null>>({});
  const [resolving, setResolving] = useState(false);
  const [rdnsError, setRdnsError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort | null>(null);
  const onSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, desc: !s.desc } : { key, desc: !TEXT_KEYS.includes(key) }));
  const sorted = useMemo(() => {
    if (!sort) return data.rows;
    const val = (r: DestRow): string | number | null => {
      switch (sort.key) {
        case 'dest': return r.dest;
        case 'name': return names[r.ip] ?? null;
        case 'network': return r.geo ? asnLabel(r.geo) : null;
        case 'country': return r.geo?.cc || null;
        case 'protocol': return `${r.app} ${r.proto}`;
        case 'tx': return r.tx;
        case 'rx': return r.rx;
        case 'procs': return r.procs;
      }
    };
    const dir = sort.desc ? -1 : 1;
    return [...data.rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === y) return 0;
      if (x === null) return 1; // missing values last either way
      if (y === null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [data.rows, sort, names]);
  const rows = all ? sorted : sorted.slice(0, TABLE_ROWS);
  const unresolved = [...new Set(rows.filter((r) => !r.local && !(r.ip in names)).map((r) => r.ip))];

  const resolve = async () => {
    setResolving(true);
    setRdnsError(null);
    try {
      const res = await getJson<RdnsResponse>(urls.rdns(unresolved.slice(0, RDNS_BATCH)));
      setNames((n) => ({ ...n, ...res.names }));
    } catch (err) {
      setRdnsError((err as Error).message);
    } finally {
      setResolving(false);
    }
  };

  const geoCols = data.geo;
  return (
    <>
      {data.rdns && (
        <p className="dest-rdns">
          <button type="button" className="link-button" disabled={resolving || unresolved.length === 0} onClick={resolve}>
            {resolving ? 'Looking up…' : unresolved.length ? `Look up names (${Math.min(RDNS_BATCH, unresolved.length)} of ${unresolved.length} shown)` : 'All shown names looked up'}
          </button>
          <span className="muted"> reverse DNS, sent from the monitored host</span>
          {rdnsError && <span className="panel-error"> {rdnsError}</span>}
        </p>
      )}
      <div className="table-scroll">
        <table className="tt dest-table">
          <thead>
            <tr>
              <SortHeader sort={sort} k="dest" label="Destination" onSort={onSort} />
              {data.rdns && <SortHeader sort={sort} k="name" label="Name" onSort={onSort} />}
              {geoCols && <SortHeader sort={sort} k="network" label="Network" onSort={onSort} />}
              {geoCols && <SortHeader sort={sort} k="country" label="Country" onSort={onSort} />}
              <SortHeader sort={sort} k="protocol" label="Protocol" onSort={onSort} />
              <SortHeader sort={sort} k="tx" label="↑ Sent" num onSort={onSort} />
              <SortHeader sort={sort} k="rx" label="↓ Received" num onSort={onSort} />
              <SortHeader sort={sort} k="procs" label="Processes" num onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.dest} r={r} range={range} rdns={data.rdns} name={names[r.ip]} geoCols={geoCols} onAsn={onAsn} onCountry={onCountry} />
            ))}
          </tbody>
        </table>
      </div>
      {data.rows.length > TABLE_ROWS && (
        <button type="button" className="link-button" onClick={() => setAll(!all)}>
          {all ? `Show the first ${TABLE_ROWS}` : `Show all ${data.rows.length}`}
        </button>
      )}
    </>
  );
}

function Row(props: {
  r: DestRow;
  range: TimeRange;
  rdns: boolean;
  name: string | null | undefined;
  geoCols: boolean;
  onAsn: (asn: number) => void;
  onCountry: (cc: string) => void;
}) {
  const { r, range, rdns, name, geoCols, onAsn, onCountry } = props;
  const href = historyHref(r.dest, range);
  return (
    <tr>
      <td>
        <Link href={href} onClick={() => scrollTo(0, 0)} title={`History for ${r.dest} over this range`}>
          <code>{r.dest}</code>
        </Link>
        {r.local && <span className="badge badge-muted">local</span>}
      </td>
      {rdns && <td className="dest-name">{name === undefined ? <span className="muted">—</span> : name === null ? <span className="muted">no name</span> : name}</td>}
      {geoCols && (
        <td>
          {r.geo ? (
            <button type="button" className="link-button" onClick={() => onAsn(r.geo!.asn)} title={`AS${r.geo.asn} ${r.geo.org}: list its destinations`}>
              {asnLabel(r.geo)}
            </button>
          ) : (
            <span className="muted">{r.local ? 'local' : 'unknown'}</span>
          )}
        </td>
      )}
      {geoCols && (
        <td>
          {r.geo?.cc ? (
            <button type="button" className="link-button" onClick={() => onCountry(r.geo!.cc)} title={countryName(r.geo.cc)}>
              {r.geo.cc}
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      )}
      <td>
        {r.app} <span className="muted">{r.proto}</span>
      </td>
      <td className="tt-num">{fmtBytes(r.tx)}</td>
      <td className="tt-num">{fmtBytes(r.rx)}</td>
      <td className="tt-num" title={r.names.join(', ')}>
        {r.procs} <span className="muted dest-procs">{r.names.slice(0, 2).join(', ')}{r.names.length > 2 ? ', …' : ''}</span>
      </td>
    </tr>
  );
}
