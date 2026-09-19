import type { FastifyInstance } from 'fastify';
import type { RdnsResponse } from '../../shared/api.ts';
import { parseIp } from '../geo/ip.ts';
import type { Rdns } from '../geo/rdns.ts';
import { badRequest } from '../http-error.ts';

/** More addresses than this in one request is a client bug, not a budget question. */
const MAX_IPS = 200;

export function rdnsRoutes(app: FastifyInstance, deps: { rdns: Rdns }) {
  /**
   * Reverse DNS (18), on demand and only with RDNS=1: PTR names of `ips`
   * (comma-separated). Cached names come back at once; at most 20 new
   * lookups run per request, for up to 500 ms, and the rest are `pending`.
   */
  app.get<{ Querystring: { ips?: string } }>('/api/rdns', async (req): Promise<RdnsResponse> => {
    const ips = (req.query.ips ?? '').split(',').filter(Boolean);
    if (ips.length > MAX_IPS) throw badRequest(`ips: at most ${MAX_IPS}`);
    for (const ip of ips) if (!parseIp(ip)) throw badRequest(`ips: not an IP address: ${ip.slice(0, 60)}`);
    if (!deps.rdns.enabled) return { enabled: false, names: {}, pending: [] };
    return { enabled: true, ...(await deps.rdns.lookup(ips)) };
  });
}
