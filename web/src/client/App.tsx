import { StatusPill } from './components/StatusPill.tsx';
import { useHealth } from './useHealth.ts';

export function App() {
  const health = useHealth();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
            <path d="M1 9h3l2-6 4 10 2-4h3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          net-watch
        </div>
        <nav className="status" aria-label="Backend status">
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
        </nav>
      </header>

      <main className="content">
        <h1>Overview</h1>
        <section className="panels">
          <div className="empty">
            <p className="empty-title">No panels yet</p>
            <p>Charts and queries over live (Redis) and historical (ClickHouse) traffic will go here.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
