import { useState, type ReactNode } from 'react';
import type { StorageBreakdownResponse, StorageRow } from '../../shared/api.ts';
import { getJson } from '../api.ts';
import { fmtBytes } from '../charts/format.ts';
import { TableLayout } from '../components/TableLayout.tsx';

type Props = {
  rows: StorageRow[];
  /** Header of the count column ("rows", "processes"). */
  countLabel: string;
  /** Header of the label column. */
  labelHeader: string;
  selected: ReadonlySet<string>;
  onSelect: (key: string, on: boolean) => void;
  onSelectAll: (on: boolean) => void;
  onDelete: (keys: string[]) => void;
  /** Deleting is off (no password configured on the server). */
  disabled: boolean;
  /** Where an `expandable` row's finer rows come from. */
  breakdownUrl?: (key: string) => string;
  /** Actions for the side panel (delete selected). */
  side?: ReactNode;
};

interface RowProps extends Pick<Props, 'selected' | 'onSelect' | 'onDelete' | 'disabled' | 'breakdownUrl'> {
  row: StorageRow;
  max: number;
  depth: number;
}

/** One row, and while open its finer rows: `children` as sent, or loaded from the breakdown endpoint. */
function Row({ row, max, depth, selected, onSelect, onDelete, disabled, breakdownUrl }: RowProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<StorageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const canOpen = !!row.children?.length || (row.expandable && !!breakdownUrl);
  const kids = row.children ?? loaded;

  const toggle = async () => {
    setOpen(!open);
    if (open || kids || !row.expandable || !breakdownUrl) return;
    setLoading(true);
    setError(null);
    try {
      setLoaded((await getJson<StorageBreakdownResponse>(breakdownUrl(row.key))).rows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const kidMax = Math.max(1, ...(kids ?? []).map((k) => k.bytes));
  return (
    <>
      <tr className={depth ? 'storage-child' : undefined}>
        <td className="storage-check">
          {depth === 0 && row.deletable && (
            <input type="checkbox" aria-label={`Select ${row.label}`} checked={selected.has(row.key)} onChange={(e) => onSelect(row.key, e.target.checked)} />
          )}
        </td>
        <td style={{ paddingLeft: depth * 20 }}>
          {canOpen ? (
            <button type="button" className="link-button storage-expand" aria-expanded={open} onClick={toggle}>
              <span aria-hidden="true">{open ? '▾' : '▸'}</span> {row.label}
            </button>
          ) : (
            row.label
          )}
        </td>
        <td className="num" title={row.estimated ? 'estimated: the parent partition’s size shared out by row count' : undefined}>
          {row.estimated ? '≈ ' : ''}
          {fmtBytes(row.bytes)}
        </td>
        <td className="storage-bar-cell" aria-hidden="true">
          <span className="storage-bar" style={{ width: `${(row.bytes / max) * 100}%` }} />
        </td>
        <td className="num muted">{row.count > 0 ? row.count.toLocaleString() : ''}</td>
        <td>
          {depth === 0 && row.deletable && (
            <button type="button" className="link-button storage-del" disabled={disabled} onClick={() => onDelete([row.key])}>
              Delete
            </button>
          )}
        </td>
      </tr>
      {open && loading && (
        <tr className="storage-child">
          <td />
          <td colSpan={5} className="muted" style={{ paddingLeft: (depth + 1) * 20 }}>
            loading…
          </td>
        </tr>
      )}
      {open && error && (
        <tr className="storage-child">
          <td />
          <td colSpan={5} className="delete-error" style={{ paddingLeft: (depth + 1) * 20 }}>
            {error}
          </td>
        </tr>
      )}
      {open &&
        kids?.map((k) => (
          <Row key={k.key} row={k} max={kidMax} depth={depth + 1} selected={selected} onSelect={onSelect} onDelete={onDelete} disabled={disabled} breakdownUrl={breakdownUrl} />
        ))}
    </>
  );
}

/** Sizes per row with a bar, checkboxes for several-at-once deletes, a delete button per row, and hourly (or daily) detail under a ▸. */
export function StorageTable({ rows, countLabel, labelHeader, selected, onSelect, onSelectAll, onDelete, disabled, breakdownUrl, side }: Props) {
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  const deletable = rows.filter((r) => r.deletable);
  const allOn = deletable.length > 0 && deletable.every((r) => selected.has(r.key));

  return (
    <TableLayout side={side}>
      <div className="table-scroll">
      <table className="tt storage-table">
        <thead>
          <tr>
            <th className="storage-check">
              {deletable.length > 0 && (
                <input type="checkbox" aria-label="Select all" checked={allOn} onChange={(e) => onSelectAll(e.target.checked)} />
              )}
            </th>
            <th>{labelHeader}</th>
            <th className="num">Size</th>
            <th aria-hidden="true" />
            <th className="num">{countLabel}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.key} row={r} max={max} depth={0} selected={selected} onSelect={onSelect} onDelete={onDelete} disabled={disabled} breakdownUrl={breakdownUrl} />
          ))}
        </tbody>
      </table>
      </div>
    </TableLayout>
  );
}
