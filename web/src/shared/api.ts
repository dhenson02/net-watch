// Response shapes shared by the API server and the browser client.

export interface BackendStatus {
  ok: boolean;
  /** host:port the server talks to (never includes credentials). */
  target: string;
  /** Round trip of the probe query, when it succeeded. */
  latencyMs: number | null;
  version: string | null;
  error: string | null;
}

export interface HealthResponse {
  serverTimeMs: number;
  uptimeS: number;
  redis: BackendStatus;
  clickhouse: BackendStatus;
}
