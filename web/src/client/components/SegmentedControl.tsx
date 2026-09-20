type Option<T extends string> = { value: T; label: string; title?: string };

type Props<T extends string> = {
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
};

/** A row of mutually exclusive buttons (group-by, mode). */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: Props<T>) {
  return (
    <div className="seg-group">
      <span className="seg-caption" aria-hidden="true">
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-label={label} data-count={options.length}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            title={o.title}
            className={o.value === value ? 'active' : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
