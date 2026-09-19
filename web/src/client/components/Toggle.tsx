type Props = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
};

/** A labelled on/off switch (overlay toggles). */
export function Toggle({ label, checked, onChange, title }: Props) {
  return (
    <label className="toggle" title={title}>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      {label}
    </label>
  );
}
