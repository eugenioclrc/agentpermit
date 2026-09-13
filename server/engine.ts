import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatUnits, parseUnits } from 'viem';
import { FRESH_MS, type AgentStatus, type Version } from '../shared/status.ts';

const Q = 10n ** 18n;
const abs = (n: bigint) => n < 0n ? -n : n;
type Leg = 'spot' | 'short';
type Position = { quantity: string; entry: string };
type Fill = { id: number; timestamp: number; leg: Leg; quantity: string; price: string; fee: string; reason: string };
export type State = {
  schema: 1;
  name: string;
  feeBps: number;
  slippageBps: number;
  quote: { price: string; timestamp: number } | null;
  positions: Record<Leg, Position>;
  realized: string;
  fees: string;
  history: Fill[];
  active: Version;
  pending: { from: Version; to: Version; hash?: `0x${string}` } | null;
  migrations: { version: Version; hash: `0x${string}` | null; timestamp: number }[];
};

export function atomicWrite(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function validState(s: State) {
  const integer = (x: unknown) => typeof x === 'string' && /^-?\d{1,60}$/.test(x);
  if (!s || s.schema !== 1 || typeof s.name !== 'string' || !['v1', 'v2'].includes(s.active) ||
      ![s.feeBps, s.slippageBps].every(n => Number.isInteger(n) && n >= 0 && n <= 100) ||
      !integer(s.realized) || !integer(s.fees) || BigInt(s.fees) < 0n ||
      !s.positions || !['spot', 'short'].every(k => {
        const p = s.positions[k as Leg]; return p && integer(p.quantity) && integer(p.entry) && BigInt(p.entry) >= 0n;
      }) || !Array.isArray(s.history) || s.history.length > 10_000 ||
      !s.history.every((t, i) => t && t.id === i + 1 && ['spot', 'short'].includes(t.leg) &&
        [t.quantity, t.price, t.fee].every(integer) && BigInt(t.price) > 0n && BigInt(t.fee) >= 0n &&
        Number.isSafeInteger(t.timestamp) && typeof t.reason === 'string') ||
      !(s.quote === null || (integer(s.quote.price) && BigInt(s.quote.price) > 0n && Number.isSafeInteger(s.quote.timestamp))) ||
      !(s.pending === null || (s.pending.from === s.active && ['v1', 'v2'].includes(s.pending.to) && s.pending.to !== s.active &&
        (s.pending.hash === undefined || /^0x[0-9a-fA-F]{64}$/.test(s.pending.hash)))) || !Array.isArray(s.migrations)) {
    throw new Error('Invalid state file. Preserve it for inspection; no balances have been reset.');
  }
  for (const leg of ['spot', 'short'] as const) {
    const total = s.history.filter(t => t.leg === leg).reduce((q, t) => q + BigInt(t.quantity), 0n);
    if (total !== BigInt(s.positions[leg].quantity)) throw new Error('State ledger does not match positions.');
  }
  if (s.history.reduce((sum, t) => sum + BigInt(t.fee), 0n) !== BigInt(s.fees)) throw new Error('State fees do not match ledger.');
}

export class Engine {
  state: State;
  path: string;
  feedError: string | null = null;
  constructor(path: string, name: string, feeBps = 5, slippageBps = 10) {
    this.path = path;
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {
      schema: 1, name, feeBps, slippageBps, quote: null,
      positions: { spot: { quantity: '0', entry: '0' }, short: { quantity: '0', entry: '0' } },
      realized: '0', fees: '0', history: [], active: 'v1', pending: null, migrations: [],
    };
    validState(this.state);
    if (this.state.name !== name || this.state.feeBps !== feeBps || this.state.slippageBps !== slippageBps) {
      throw new Error('Name or cost assumptions differ from persisted state. Use the original settings or archive data/state.json before a new demo.');
    }
  }
  update(change: (next: State) => void) {
    const next = structuredClone(this.state);
    change(next);
    validState(next);
    atomicWrite(this.path, next);
    this.state = next;
  }
  fresh(now = Date.now()) {
    return !!this.state.quote && now - this.state.quote.timestamp <= FRESH_MS && this.state.quote.timestamp <= now + 5_000;
  }
  quote(price: unknown, timestamp: unknown, now = Date.now()) {
    if (typeof price !== 'string' || !/^\d{1,8}(\.\d{1,6})?$/.test(price) || parseUnits(price, 6) <= 0n ||
        typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp > now + 5_000 || now - timestamp > FRESH_MS) {
      throw new Error('Invalid or stale Coinbase quote; new orders paused.');
    }
    if (this.state.quote && timestamp < this.state.quote.timestamp) throw new Error('Out-of-order quote ignored.');
    this.update(s => { s.quote = { price: parseUnits(price, 6).toString(), timestamp }; });
    this.feedError = null;
  }
  delta() { return BigInt(this.state.positions.spot.quantity) + BigInt(this.state.positions.short.quantity); }
  private trade(s: State, leg: Leg, quantity: bigint, reason: string, now: number) {
    if (!quantity) return;
    // ponytail: retain at most 10,000 fills for one hackathon demo; archive before a new run.
    if (s.history.length >= 10_000) throw new Error('Demo ledger is full. Archive the state before starting a new run.');
    const reference = BigInt(s.quote!.price);
    const price = reference * (10_000n + (quantity > 0n ? 1n : -1n) * BigInt(s.slippageBps)) / 10_000n;
    const fee = abs(quantity) * price * BigInt(s.feeBps) / Q / 10_000n;
    const p = s.positions[leg];
    const old = BigInt(p.quantity), entry = BigInt(p.entry), next = old + quantity;
    if (old === 0n || (old > 0n) === (quantity > 0n)) {
      p.entry = ((abs(old) * entry + abs(quantity) * price) / abs(next)).toString();
    } else {
      const closed = abs(quantity) < abs(old) ? abs(quantity) : abs(old);
      s.realized = (BigInt(s.realized) + closed * (price - entry) * (old > 0n ? 1n : -1n) / Q).toString();
      if (next === 0n) p.entry = '0';
      else if ((next > 0n) !== (old > 0n)) p.entry = price.toString();
    }
    p.quantity = next.toString();
    s.fees = (BigInt(s.fees) + fee).toString();
    s.history.push({ id: s.history.length + 1, timestamp: now, leg, quantity: quantity.toString(), price: price.toString(), fee: fee.toString(), reason });
  }
  action(command: 'open' | 'partial' | 'hedge' | 'close', now = Date.now()) {
    if (!this.fresh(now)) throw new Error('No fresh quote (maximum age 30s). Orders paused.');
    const flat = Object.values(this.state.positions).every(p => p.quantity === '0');
    if ((command === 'open' || command === 'partial') && !flat) throw new Error('Close the existing position before opening another.');
    if (command === 'hedge' && abs(this.delta()) <= Q / 1000n) return;
    if (command === 'close' && flat) return;
    this.update(s => {
      if (command === 'open' || command === 'partial') {
        this.trade(s, 'spot', Q / 10n, 'Open paper hedge', now);
        this.trade(s, 'short', command === 'partial' ? -Q * 8n / 100n : -Q / 10n,
          command === 'partial' ? 'Demonstration: partial short fill' : 'Open paper hedge', now);
      } else if (command === 'hedge') {
        this.trade(s, 'short', -this.delta(), 'Rule: |delta| > 0.001 ETH', now);
      } else {
        for (const leg of ['spot', 'short'] as const) this.trade(s, leg, -BigInt(s.positions[leg].quantity), 'Close paper hedge', now);
      }
    });
  }
  status(version = this.state.active, now = Date.now()): AgentStatus {
    const s = this.state;
    const mark = s.quote ? BigInt(s.quote.price) : null;
    const unrealized = mark === null ? null : Object.values(s.positions).reduce((sum, p) => sum + BigInt(p.quantity) * (mark - BigInt(p.entry)) / Q, 0n);
    const usd = (n: bigint) => formatUnits(n, 6);
    return {
      schema: 1, mode: 'paper', name: s.name, version, generatedAt: now,
      quote: s.quote ? { price: usd(BigInt(s.quote.price)), timestamp: s.quote.timestamp, source: 'Coinbase ETH-USD' } : null,
      quoteFresh: this.fresh(now), feedError: this.feedError, feeBps: s.feeBps, slippageBps: s.slippageBps,
      positions: (['spot', 'short'] as const).map(leg => ({ leg, quantity: formatUnits(BigInt(s.positions[leg].quantity), 18), entryPrice: usd(BigInt(s.positions[leg].entry)) })),
      deltaEth: formatUnits(this.delta(), 18), deltaUsd: mark === null ? null : usd(this.delta() * mark / Q),
      realizedPnl: usd(BigInt(s.realized)), unrealizedPnl: unrealized === null ? null : usd(unrealized),
      fees: usd(BigInt(s.fees)), netPnl: unrealized === null ? null : usd(BigInt(s.realized) + unrealized - BigInt(s.fees)),
      history: s.history.map(t => ({ ...t, quantity: formatUnits(BigInt(t.quantity), 18), price: usd(BigInt(t.price)), fee: usd(BigInt(t.fee)) })),
    };
  }
}
