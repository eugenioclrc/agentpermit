import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Address } from 'viem';
import type { Engine } from './engine.ts';
import type { StrategyService } from './strategy.ts';
import { errorText } from '../shared/ens.ts';

const origins = ['http://127.0.0.1:5173', 'http://localhost:5173'];

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > 64_000) throw new Error('Request body too large.');
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function authorized(req: IncomingMessage, token: string) {
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(supplied), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function apiServer(getEngine: () => Engine, operator: Address | null, strategy?: StrategyService, sessionToken = '') {
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');
    const send = (status: number, value: unknown) => { if (!res.headersSent) res.writeHead(status); res.end(JSON.stringify(value)); };
    const port = (res.socket?.address() as { port?: number })?.port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(403, { error: 'Local host required.' });
    if (origin && !origins.includes(origin)) return send(403, { error: 'Origin not allowed.' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      return send(204, null);
    }
    try {
      const engine = getEngine();
      if (req.method === 'GET' && req.url === '/config') return send(200, { name: engine.state.name, operator, active: engine.state.active, pending: engine.state.pending, migrations: engine.state.migrations });
      if (strategy && req.method === 'GET' && req.url === '/strategy/status') return send(200, strategy.status());
      if (strategy && req.method === 'GET' && req.url === '/strategy/session') {
        if (!origin) return send(403, { error: 'Browser Origin required.' });
        return send(200, { token: sessionToken });
      }
      if (strategy && req.method === 'POST' && (req.url === '/strategy/propose' || req.url === '/strategy/actions')) {
        if (!origin || !authorized(req, sessionToken)) return send(401, { error: 'Valid local session required.' });
        const value = await body(req);
        const result = req.url === '/strategy/propose'
          ? await strategy.propose(value.goal, value.budget)
          : await strategy.action(value.id, value.action, value.technicalTrial === true);
        return send(200, result);
      }
      if (req.method !== 'GET') { res.setHeader('Allow', strategy ? 'GET, POST' : 'GET'); return send(405, { error: strategy ? 'Method not allowed.' : 'Read-only API. Use the local console for actions.' }); }
      const version = req.url === '/agent/v1/status' ? 'v1' : req.url === '/agent/v2/status' ? 'v2' : null;
      if (!version) return send(404, { error: 'Not found.' });
      if (version !== engine.state.active && version !== engine.state.pending?.to) return send(410, { error: 'Endpoint inactive. Resolve the ENS name again.' });
      return send(200, { ...engine.status(version), ...(strategy ? { strategy: strategy.status() } : {}) });
    } catch (error) {
      return send(400, { error: errorText(error) });
    }
  });
}
