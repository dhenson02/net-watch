import { useCallback } from 'react';
import type { AsnResponse, CountriesResponse, DestinationsResponse, DestScope, GeoDir } from '../../shared/api.ts';
import { urls } from '../api.ts';
import { fmtBytes, fmtDuration, fmtTime } from '../charts/format.ts';
import { Panel } from '../components/Panel.tsx';
import { RangePicker } from '../components/RangePicker.tsx';
import { SegmentedControl } from '../components/SegmentedControl.tsx';
import { AsnBars } from '../destinations/AsnBars.tsx';
import { DestTable } from '../destinations/DestTable.tsx';
import { asnLabel, countryName, coverageText, GEO_STALE_DAYS, geoAgeDays, parseDestPageParams, pctText } from '../destinations/geoView.ts';
import { WorldMap } from '../destinations/WorldMap.tsx';
import { useGeoEpoch, useGeoStatus } from '../geoStatus.ts';
import { useQuery } from '../hooks/useQuery.ts';
import { useTimeRange } from '../hooks/useTimeRange.ts';
import { setSearchParams, useSearch } from '../router.ts';

const DIR_OPTIONS = [
  { value: 'total', label: 'both', title: 'Rank and size by sent plus received bytes' },
  { value: 'tx', label: '↑ sent' },
  { value: 'rx', label: '↓ received' },
] as const;

const SCOPE_OPTIONS = [
  { value: 'all', label: 'all' },
  { value: 'public', label: 'public', title: 'Internet addresses only' },
  { value: 'local', label: 'local', title: 'Private, loopback, link-local and multicast addresses' },
  { value: 'unmatched', label: 'no ASN', title: 'Public addresses the IP table does not know' },
] as const;

const DIR_NOUN: Record<GeoDir, string> = { total: 'bytes', tx: 'sent bytes', rx: 'received bytes' };

/**
 * 18: where the traffic goes: bytes per network (ASN) and country from a
 * local IP table, and every destination address. Without a table the page
 * still lists destinations and says how to add one.
 */
export function DestinationsPage() {
  const range = useTimeRange();
  const { dir, asn, cc, scope } = parseDestPageParams(useSearch());
  const geo = useGeoStatus();
  const epoch = useGeoEpoch();
  const asns = useQuery<AsnResponse>(urls.historyAsn(range, { dir }), epoch);
  const countries = useQuery<CountriesResponse>(urls.historyCountries(range, { dir }), epoch);
  const dests = useQuery<DestinationsResponse>(urls.historyDestinations(range, { dir, asn, cc, scope, limit: 1000 }), epoch);
  const a = asns.data;
  const geoOn = geo ? geo.loaded : !!a?.geo;

  const selectAsn = useCallback((n: number) => setSearchParams({ asn: n, cc: null, scope: null }), []);
  const selectCc = useCallback((c: string) => setSearchParams({ cc: c, asn: null, scope: null }), []);

  const asnRow = asn !== null ? a?.rows.find((r) => r.asn === asn) : undefined;
  const age = geoAgeDays(geo?.fileDate ?? null, Date.now());
  const coverage = a ? coverageText(a) : null;
  const publicBytes = a ? a.rows.reduce((s, r) => s + r.bytes, 0) : 0;

  return (
    <>
      <div className="page-head">
        <h1>Destinations</h1>
        <RangePicker range={range} />
      </div>
      <p className="muted range-label">
        {fmtTime(range.from)} – {fmtTime(range.to)} ({fmtDuration(range.to - range.from)})
      </p>
      {(asn !== null || cc !== null || scope !== 'all') && (
        <p className="filter-bar">
          {asn !== null && (
            <Chip label="network" value={asnRow ? asnLabel(asnRow) : `AS${asn}`} onClear={() => setSearchParams({ asn: null })} />
          )}
          {cc !== null && <Chip label="country" value={`${countryName(cc)} (${cc})`} onClear={() => setSearchParams({ cc: null })} />}
          {scope !== 'all' && <Chip label="addresses" value={SCOPE_OPTIONS.find((o) => o.value === scope)!.label} onClear={() => setSearchParams({ scope: null })} />}
          <span className="muted">applies to the destination table</span>
        </p>
      )}
      <div className="panels">
        {geo && !geo.loaded && (
          <section className="panel panel-wide geo-notice" role="note">
            <p>
              <b>No IP → ASN table loaded</b>, so destinations are shown without network or country.{' '}
              {geo?.error ? <span className="muted">({geo.error})</span> : null}
            </p>
            <p className="muted">
              Run <code>npm run geo:update</code> in <code>web/</code> to download the public-domain iptoasn.com table (about 10 MB) to{' '}
              <code>data/</code>, or point <code>GEOIP_FILE</code> at a copy. The server picks it up within 10 minutes; lookups stay on this host.
            </p>
          </section>
        )}

        <Panel
          title="Where the bytes go"
          subtitle={a && `${a.table === 'flows' ? 'raw flows' : 'per-minute rollup'} · ${DIR_NOUN[a.dir]}`}
          loading={asns.loading}
          error={asns.error}
          wide
          actions={<SegmentedControl<GeoDir> label="Direction" options={DIR_OPTIONS} value={dir} onChange={(v) => setSearchParams({ dir: v === 'total' ? null : v })} />}
          footnote={
            <>
              {coverage ? `${coverage} · ` : ''}
              {geo?.loaded
                ? `IP table: ${geo.entries.toLocaleString()} ranges, file dated ${fmtTime(geo.fileDate!, 'date')}${age !== null && age > GEO_STALE_DAYS ? ` (${age} days old: run npm run geo:update)` : ''}`
                : 'no IP table'}
            </>
          }
        >
          {a && (
            <div className="stats">
              <Stat label="Public, by network" value={geoOn ? fmtBytes(publicBytes) : '—'} sub={geoOn ? `${pctText(publicBytes, a.coverage.totalBytes)} · ${a.rows.length} networks` : 'needs the IP table'} />
              <Stat
                label="Local (LAN, loopback, multicast)"
                value={fmtBytes(a.local.bytes)}
                sub={`${pctText(a.local.bytes, a.coverage.totalBytes)} · ${a.local.ips} IPs`}
                onClick={() => setSearchParams({ scope: 'local', asn: null, cc: null })}
              />
              <Stat
                label={geoOn ? 'Public, no ASN in the table' : 'Public'}
                value={fmtBytes(a.unmatched.bytes)}
                sub={`${pctText(a.unmatched.bytes, a.coverage.totalBytes)} · ${a.unmatched.ips} IPs`}
                onClick={() => setSearchParams({ scope: 'unmatched', asn: null, cc: null })}
              />
              <Stat label="Destination IPs" value={a.coverage.totalIps.toLocaleString()} sub={`${fmtBytes(a.coverage.totalBytes)} in all`} />
            </div>
          )}
        </Panel>

        {geoOn && (
          <Panel
            title="Top networks"
            subtitle={`The ${Math.min(20, a?.rows.length ?? 20)} ASNs with the most ${DIR_NOUN[dir]}; sent to the right, received to the left · click a bar to list its destinations`}
            loading={asns.loading}
            error={asns.error}
            empty={a && !a.rows.length ? 'No public traffic with a known network in this range.' : undefined}
          >
            {a && a.rows.length > 0 && <AsnBars data={a} selected={asn} onSelect={selectAsn} />}
          </Panel>
        )}

        {geoOn && (
          <Panel
            title="Countries"
            subtitle={`${DIR_NOUN[dir][0]!.toUpperCase()}${DIR_NOUN[dir].slice(1)} by the registered country of the address range (not where the server stands), log scale · local traffic is not on the map · click a country to list its destinations`}
            loading={countries.loading}
            error={countries.error}
            empty={countries.data && !countries.data.rows.length ? 'No public traffic with a known country in this range.' : undefined}
          >
            {countries.data && countries.data.rows.length > 0 && <WorldMap data={countries.data} selected={cc} onSelect={selectCc} />}
          </Panel>
        )}

        <Panel
          title="Destinations"
          subtitle={
            dests.data && (
              <>
                {dests.data.matched.toLocaleString()} address:port pair{dests.data.matched === 1 ? '' : 's'}
                {asn !== null || cc !== null || scope !== 'all' ? ' matching' : ''}, most {DIR_NOUN[dir]} first
                {dests.data.rows.length < dests.data.matched ? ` (the first ${dests.data.rows.length})` : ''}
                {dests.data.truncated ? ' · only the largest 5000 pairs were examined' : ''} · click an address for its history
              </>
            )
          }
          loading={dests.loading}
          error={dests.error}
          wide
          actions={
            <p className="proto-legend muted">
              Protocol: <span className="proto-tcp">■ TCP</span> <span className="proto-udp">■ UDP</span>
            </p>
          }
          empty={dests.data && !dests.data.rows.length ? 'No destinations match in this range.' : undefined}
        >
          {dests.data && dests.data.rows.length > 0 && (
            <DestTable
              data={dests.data}
              range={range}
              onAsn={selectAsn}
              onCountry={selectCc}
              side={<SegmentedControl<DestScope> label="Addresses" options={SCOPE_OPTIONS} value={scope} onChange={(v) => setSearchParams({ scope: v === 'all' ? null : v })} />}
            />
          )}
        </Panel>
      </div>
    </>
  );
}

function Chip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="chip">
      {label} <code>{value}</code>
      <button type="button" className="chip-x" aria-label={`Clear the ${label} filter`} onClick={onClear}>
        ×
      </button>
    </span>
  );
}

function Stat({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick?: () => void }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && (
        <div className="stat-sub">
          {onClick ? (
            <button type="button" className="link-button" onClick={onClick} title="List these destinations">
              {sub}
            </button>
          ) : (
            sub
          )}
        </div>
      )}
    </div>
  );
}
