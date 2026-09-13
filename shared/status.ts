export const API_ORIGIN = 'http://127.0.0.1:4318';
export const endpoints = {
  v1: `${API_ORIGIN}/agent/v1/status`,
  v2: `${API_ORIGIN}/agent/v2/status`,
} as const;
export type Version = keyof typeof endpoints;
export const FRESH_MS = 30_000;

export type AgentStatus = {
  schema: 1;
  mode: 'paper';
  name: string;
  version: Version;
  generatedAt: number;
  quote: { price: string; timestamp: number; source: 'Coinbase ETH-USD' } | null;
  quoteFresh: boolean;
  feedError: string | null;
  feeBps: number;
  slippageBps: number;
  positions: { leg: 'spot' | 'short'; quantity: string; entryPrice: string }[];
  deltaEth: string;
  deltaUsd: string | null;
  realizedPnl: string;
  unrealizedPnl: string | null;
  fees: string;
  netPnl: string | null;
  history: { id: number; timestamp: number; leg: 'spot' | 'short'; quantity: string; price: string; fee: string; reason: string }[];
};

export function allowedEndpoint(value: string): string {
  if (!Object.values(endpoints).some(endpoint => endpoint === value)) {
    throw new Error('Endpoint outside this local demo. Only 127.0.0.1:4318 /agent/v1/status or /agent/v2/status is allowed.');
  }
  return value;
}

// Validate data received from the agent; ENS authenticates the pointer, not its metrics.
export function parseStatus(value: unknown, expectedName?: string): AgentStatus {
  const s = value as AgentStatus;
  const decimal = (x: unknown) => typeof x === 'string' && /^-?\d{1,30}(\.\d{1,18})?$/.test(x);
  const time = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
  const leg = (x: unknown) => x === 'spot' || x === 'short';
  if (!s || s.schema !== 1 || s.mode !== 'paper' || typeof s.name !== 'string' ||
      (expectedName && s.name !== expectedName) || !['v1', 'v2'].includes(s.version) ||
      !time(s.generatedAt) || typeof s.quoteFresh !== 'boolean' ||
      !(s.feedError === null || typeof s.feedError === 'string') ||
      ![s.feeBps, s.slippageBps].every(n => Number.isInteger(n) && n >= 0 && n <= 100) ||
      ![s.deltaEth, s.realizedPnl, s.fees].every(decimal) ||
      ![s.deltaUsd, s.unrealizedPnl, s.netPnl].every(x => x === null || decimal(x)) ||
      !(s.quote === null || (s.quote.source === 'Coinbase ETH-USD' && decimal(s.quote.price) && Number(s.quote.price) > 0 && time(s.quote.timestamp))) ||
      !Array.isArray(s.positions) || s.positions.length !== 2 ||
      !s.positions.every(p => p && leg(p.leg) && decimal(p.quantity) && decimal(p.entryPrice)) ||
      new Set(s.positions.map(p => p.leg)).size !== 2 ||
      !Array.isArray(s.history) || s.history.length > 10_000 ||
      !s.history.every(t => t && Number.isSafeInteger(t.id) && t.id > 0 && time(t.timestamp) && leg(t.leg) && decimal(t.quantity) && decimal(t.price) && decimal(t.fee) && typeof t.reason === 'string' && t.reason.length < 200)) {
    throw new Error('Agent returned an invalid paper-status response or a different ENS identity.');
  }
  return s;
}
