import { useState } from 'react';
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
  const rows = all ? data.rows : data.rows.slice(0, TABLE_ROWS);
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
              <th>Destination</th>
              {data.rdns && <th>Name</th>}
              {geoCols && <th>Network</th>}
              {geoCols && <th>Country</th>}
              <th>App</th>
              <th className="tt-num">↑ Sent</th>
              <th className="tt-num">↓ Received</th>
              <th className="tt-num">Processes</th>
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
