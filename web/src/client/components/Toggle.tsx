type Props = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  disabled?: boolean;
};

/** A labelled on/off switch (overlay toggles). */
export function Toggle({ label, checked, onChange, title, disabled }: Props) {
  return (
    <label className={disabled ? 'toggle toggle-disabled' : 'toggle'} title={title}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      {label}
    </label>
  );
}
