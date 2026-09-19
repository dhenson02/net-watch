import type { BackendStatus } from '../../shared/api.ts';

type Props = { label: string } & (
  | { state: 'loading' }
  | { state: 'down'; error: string }
  | { state: 'backend'; status: BackendStatus }
);

export function StatusPill(props: Props) {
  let tone: 'ok' | 'down' | 'idle';
  let detail: string;
  let title: string;

  if (props.state === 'loading') {
    tone = 'idle';
    detail = 'checking…';
    title = `${props.label}: checking`;
  } else if (props.state === 'down') {
    tone = 'down';
    detail = 'unreachable';
    title = `${props.label}: ${props.error}`;
  } else {
    const s = props.status;
    tone = s.ok ? 'ok' : 'down';
    detail = s.ok ? `${s.latencyMs} ms` : 'down';
    title = s.ok ? `${props.label} ${s.version ?? ''} at ${s.target}` : `${props.label} at ${s.target}: ${s.error}`;
  }

  return (
    <span className={`pill pill-${tone}`} title={title}>
      <span className="pill-dot" aria-hidden="true" />
      <span className="pill-label">{props.label}</span>
      <span className="pill-detail">{detail}</span>
    </span>
  );
}
