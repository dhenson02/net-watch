import { useEffect, useRef, useState, type ReactNode } from 'react';

type Props = {
  /** What is about to go, in a sentence. */
  title: string;
  /** Size and count summary, and any store-specific warning. */
  children: ReactNode;
  /** Runs the delete with the typed password; a rejection is shown in the dialog. */
  onConfirm: (password: string) => Promise<void>;
  onClose: () => void;
};

/**
 * A modal that blocks a delete until the admin password is typed. It stays
 * open (with the server's message) when the delete fails, e.g. a wrong password.
 */
export function DeleteDialog({ title, children, onConfirm, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      className="delete-dialog"
      aria-labelledby="delete-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password && !busy) void submit();
        }}
      >
        <h2 id="delete-title" className="delete-title">
          <span aria-hidden="true">⚠ </span>
          {title}
        </h2>
        <div className="delete-body">{children}</div>
        <p className="delete-warn">This cannot be undone.</p>
        <label className="delete-field">
          <span>Admin password</span>
          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error && (
          <p className="delete-error" role="alert">
            {error}
          </p>
        )}
        <div className="delete-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={!password || busy}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
