import { useMemo, useState } from 'react';
import type { NewDest, NewDestsResponse, ProcessInfo } from '../../shared/api.ts';
import { urls, type TimeRange } from '../api.ts';
import { fmtBytes, fmtTime } from '../charts/format.ts';
import { Panel } from '../components/Panel.tsx';
import { hiddenText, parseNewDestOptions } from '../history/newDests.ts';
import { NewDestToggles } from '../history/NewDestTrack.tsx';
import { processPath } from '../history/clusterMarkers.ts';
import { asnLabel } from '../destinations/geoView.ts';
import { useQuery } from '../hooks/useQuery.ts';
import { Link, setSearchParams, useSearch } from '../router.ts';
import { BEACON_FOCUS_PARAM, BEACON_SCOPE_PARAM, BEACONS_PANEL_ID, historyHref } from './beaconStrip.ts';

/** The table shows this many rows until expanded. */
const TABLE_ROWS = 15;
const HOUR = 3_600_000;

/** Focus the beaconing strip (15) on this address, over every instance of the program, and scroll to it. */
function focusStrip(d: NewDest) {
  setSearchParams({ [BEACON_SCOPE_PARAM]: 'name', [BEACON_FOCUS_PARAM]: d.ip }, { replace: true });
  document.getElementById(BEACONS_PANEL_ID)?.scrollIntoView({ behavior: 'smooth' });
}

/**
 * 17: the addresses this program (by name, any instance) contacted for the
 * first time in the last 7 days, newest first: when, where, the app, and the
 * bytes of the first hour. A row focuses the beaconing strip on that address;
 * the address links to History for it around the first contact.
 */
export function NewDestList({ p, week }: { p: ProcessInfo; week: TimeRange }) {
  const opts = parseNewDestOptions(useSearch());
  const q = useQuery<NewDestsResponse>(urls.historyNewDests(week, { names: [p.name], ...opts }));
  const [all, setAll] = useState(false);
  const d = q.data;
  const id = `${p.pid}:${p.start_ns}`;
  const dests = useMemo(() => (d ? [...d.dests].sort((a, b) => b.firstMs - a.firstMs || a.dest.localeCompare(b.dest)) : []), [d]);
  const rows = all ? dests : dests.slice(0, TABLE_ROWS);
  const hidden = d ? hiddenText(d) : null;
  const foot = d
    ? [`${fmtTime(week.from)} – ${fmtTime(week.to)}`, d.truncated ? `the first ${d.dests.length}` : null, hidden, `${d.ports ? 'address and port' : 'address'}, minute resolution`]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <Panel
      title="New destinations"
      subtitle={`Addresses ${p.name} contacted for the first time in the last 7 days (no earlier traffic from any ${p.name} in the retained history), newest first. Click a row to find it on the beaconing strip`}
      actions={<NewDestToggles opts={opts} />}
      footnote={foot}
      wide
      loading={q.loading}
      error={q.error}
      empty={d && !q.stale && dests.length === 0 ? `No new destinations for ${p.name} in the last 7 days.${hidden ? ` ${hidden}.` : ''}` : undefined}
    >
      {dests.length > 0 && (
        <>
          <div className="table-scroll">
            <table className="tt newdest-table">
              <thead>
                <tr>
                  <th>First seen</th>
                  <th>Destination</th>
                  <th>App</th>
                  <th className="tt-num">First hour</th>
                  <th>First contact by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.dest}/${r.firstMs}`} onClick={() => focusStrip(r)} title="Find it on the beaconing strip">
                    <td>{fmtTime(r.firstMs)}</td>
                    <td>
                      <Link
                        href={historyHref(r.dest, { from: r.firstMs - HOUR, to: Math.min(Date.now(), r.firstMs + 2 * HOUR) })}
                        onClick={(e) => (e.stopPropagation(), scrollTo(0, 0))}
                        title={`History for ${r.dest} around its first contact`}
                      >
                        <code>{r.dest}</code>
                      </Link>
                      {r.geo && (
                        <span className="muted dest-org" title={`AS${r.geo.asn} ${r.geo.org}${r.geo.cc ? ` · ${r.geo.cc}` : ''}`}>
                          {asnLabel(r.geo)}
                        </span>
                      )}
                      {r.loopback && <span className="badge badge-muted">loopback</span>}
                      {r.warmup && <span className="badge badge-muted">first day</span>}
                    </td>
                    <td>
                      {r.app} <span className="muted">{r.proto}</span>
                    </td>
                    <td className="tt-num">{fmtBytes(r.firstHourBytes)}</td>
                    <td>
                      {r.id === id ? (
                        <span className="muted">this instance</span>
                      ) : (
                        <Link href={processPath(r.id)} onClick={(e) => (e.stopPropagation(), scrollTo(0, 0))}>
                          pid {r.pid}
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dests.length > TABLE_ROWS && (
            <button type="button" className="link-button" onClick={() => setAll(!all)}>
              {all ? `Show the first ${TABLE_ROWS}` : `Show all ${dests.length}`}
            </button>
          )}
        </>
      )}
    </Panel>
  );
}
