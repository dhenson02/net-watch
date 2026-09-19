import { useEffect, type ReactNode } from 'react';
import { StatusPill } from './components/StatusPill.tsx';
import { DestinationsPage } from './pages/DestinationsPage.tsx';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { LivePage } from './pages/LivePage.tsx';
import { ProcessPage } from './pages/ProcessPage.tsx';
import { Link, matchPath, navigate, usePath } from './router.ts';
import { useHealth } from './useHealth.ts';

const NAV = [
  { href: '/live', label: 'Live' },
  { href: '/history', label: 'History' },
  { href: '/destinations', label: 'Destinations' },
] as const;

function Route({ path }: { path: string }): ReactNode {
  if (matchPath('/live', path)) return <LivePage />;
  if (matchPath('/history', path)) return <HistoryPage />;
  if (matchPath('/destinations', path)) return <DestinationsPage />;
  const proc = matchPath('/process/:pid/:start', path);
  // `key` resets page state when moving between processes.
  if (proc) return <ProcessPage key={`${proc.pid}:${proc.start}`} pid={proc.pid!} start={proc.start!} />;
  return <NotFound />;
}

function NotFound() {
  return (
    <div className="empty">
      <p className="empty-title">Page not found</p>
      <p>
        <Link href="/live">Go to the live view</Link>
      </p>
    </div>
  );
}

export function App() {
  const health = useHealth();
  const path = usePath();

  useEffect(() => {
    if (path === '/') navigate('/live', { replace: true });
  }, [path]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
              <path d="M1 9h3l2-6 4 10 2-4h3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            net-watch
          </div>
          <nav className="tabs" aria-label="Pages">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? 'page' : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="status" aria-label="Backend status">
          {health.kind === 'loading' && (
            <>
              <StatusPill label="Redis" state="loading" />
              <StatusPill label="ClickHouse" state="loading" />
            </>
          )}
          {health.kind === 'error' && <StatusPill label="API" state="down" error={health.error} />}
          {health.kind === 'ok' && (
            <>
              <StatusPill label="Redis" state="backend" status={health.health.redis} />
              <StatusPill label="ClickHouse" state="backend" status={health.health.clickhouse} />
            </>
          )}
        </div>
      </header>

      <main className="content">{path === '/' ? null : <Route path={path} />}</main>
    </div>
  );
}
