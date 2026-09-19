import { useState } from 'react';
import type { TimeRange } from '../api.ts';
import { setSearchParams } from '../router.ts';

const MIN = 60_000;
const PRESETS = [
  { label: '15m', ms: 15 * MIN },
  { label: '1h', ms: 60 * MIN },
  { label: '6h', ms: 6 * 60 * MIN },
  { label: '24h', ms: 24 * 60 * MIN },
  { label: '7d', ms: 7 * 24 * 60 * MIN },
  { label: '30d', ms: 30 * 24 * 60 * MIN },
] as const;

/** ms → the value format of <input type="datetime-local"> in local time. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Preset ranges ending now, plus a custom from/to. Writes `?from&to` (ms), so
 * each choice is a history entry and the view can be bookmarked.
 */
export function RangePicker({ range }: { range: TimeRange }) {
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const span = range.to - range.from;
  // A preset is "active" when the span matches; the end time may have aged.
  const active = PRESETS.find((p) => p.ms === span)?.label;

  const openCustom = () => {
    setFrom(toLocalInput(range.from));
    setTo(toLocalInput(range.to));
    setCustom((c) => !c);
  };
  const f = new Date(from).getTime();
  const t = new Date(to).getTime();
  const valid = Number.isFinite(f) && Number.isFinite(t) && f < t;

  return (
    <div className="range-picker">
      <div className="segmented" role="group" aria-label="Time range">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={active === p.label}
            className={active === p.label ? 'active' : undefined}
            title={`Last ${p.label}, ending now`}
            onClick={() => {
              const now = Date.now();
              setSearchParams({ from: now - p.ms, to: now });
            }}
          >
            {p.label}
          </button>
        ))}
        <button type="button" aria-expanded={custom} className={custom || !active ? 'active' : undefined} onClick={openCustom}>
          Custom
        </button>
      </div>
      {custom && (
        <form
          className="range-custom"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            setSearchParams({ from: f, to: t });
            setCustom(false);
          }}
        >
          <label>
            From <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </label>
          <label>
            To <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} required />
          </label>
          <button type="submit" disabled={!valid}>
            Apply
          </button>
        </form>
      )}
    </div>
  );
}
