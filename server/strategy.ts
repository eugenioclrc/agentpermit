import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { formatUnits, type Address } from 'viem';
import type { Intent, StrategyProposal, StrategyState } from '../shared/strategy.ts';
import { errorText } from '../shared/ens.ts';
import { atomicWrite } from './engine.ts';
import { proposeStrategy } from './proposal.ts';
import { HyperliquidTestnet, KnownOrderError, cloidFor, type PerpOrderResult, type PerpSnapshot } from './hyperliquid.ts';
import { UNISWAP, UniswapFork, type LpOpenResult, type LpSnapshot } from './uniswap.ts';

export type StrategyDependencies = {
  propose: (name: string, goal: unknown, budget: unknown, now?: number) => Promise<StrategyProposal>;
  uniswap: {
    blockNumber: () => Promise<number>;
    preflight?: (proposal: StrategyProposal) => Promise<void>;
    open: (proposal: StrategyProposal) => Promise<LpOpenResult>;
    read: (tokenId: string) => Promise<LpSnapshot>;
    close: (tokenId: string) => Promise<{ hash: `0x${string}`; sellHash: `0x${string}` | null; usdcReceived: string; feesValueUsdc?: string }>;
  };
  hyperliquid: {
    user: Address;
    preflight: () => Promise<{ account: Address; asset: number; szDecimals: number; accountValueUsd: string }>;
    read: (since?: number) => Promise<PerpSnapshot>;
    place: (intentId: string, deltaEth: number, reduceOnly: boolean, since?: number) => Promise<PerpOrderResult>;
    find: (cloid: `0x${string}`, since?: number) => Promise<PerpOrderResult | null>;
  };
};

function defaults(name: string): StrategyState {
  const account = /^0x[0-9a-fA-F]{40}$/.test(process.env.HYPERLIQUID_ACCOUNT_ADDRESS ?? '') ? process.env.HYPERLIQUID_ACCOUNT_ADDRESS as Address : null;
  return {
    schema: 1, mode: 'delta-neutral', name, phase: 'idle', generatedAt: Date.now(), proposal: null,
    fork: { chainId: 31337, blockNumber: null, positionManager: UNISWAP.positionManager, poolEnvironment: 'Ethereum mainnet fork' },
    perpEnvironment: { network: 'Hyperliquid testnet', account, market: 'ETH', replay: replayLabel() },
    lp: { status: 'empty', pool: null, fee: null, tokenId: null, tickLower: null, tickUpper: null, liquidity: '0', usdc: '0', weth: '0', feesUsdc: '0', feesWeth: '0', freeWeth: '0', proceedsUsdc: '0', openTx: null, closeTx: null },
    perp: { status: 'flat', asset: null, szDecimals: null, sizeEth: '0', entryPrice: '0', markPrice: '0', liquidationPrice: null, marginUsd: '0', fundingUsd: '0', unrealizedPnlUsd: '0', lastOrderId: null },
    exposure: { eth: '0', usd: '0', updatedAt: null, fresh: false },
    costs: { lpFeesUsdc: '0', perpFeesUsdc: '0', fundingUsdc: '0', forkValueChangeUsdc: '0', perpUnrealizedUsdc: '0', valueChangeUsdc: '0' },
    outOfRangeSince: null, intents: [], actions: [], lastError: null,
  };
}

function validate(state: StrategyState, name: string) {
  const decimal = (x: unknown) => typeof x === 'string' && /^-?\d{1,40}(\.\d{1,18})?$/.test(x);
  if (!state || state.schema !== 1 || state.mode !== 'delta-neutral' || state.name !== name ||
      !['idle', 'proposed', 'opening', 'recovering', 'active', 'paused', 'closing', 'closed', 'intervention_required'].includes(state.phase) ||
      !state.lp || !state.perp || !state.exposure || !state.costs || !state.fork || !state.perpEnvironment || !Array.isArray(state.intents) || state.intents.length > 10_000 ||
      !Array.isArray(state.actions) || state.actions.length > 10_000 ||
      ![state.lp.liquidity, state.lp.usdc, state.lp.weth, state.lp.feesUsdc, state.lp.feesWeth, state.lp.freeWeth, state.lp.proceedsUsdc,
        state.perp.sizeEth, state.perp.entryPrice, state.perp.markPrice, state.perp.marginUsd, state.perp.fundingUsd, state.perp.unrealizedPnlUsd,
        state.exposure.eth, state.exposure.usd, state.costs.lpFeesUsdc, state.costs.perpFeesUsdc, state.costs.fundingUsdc,
        state.costs.forkValueChangeUsdc, state.costs.perpUnrealizedUsdc, state.costs.valueChangeUsdc].every(decimal) || new Set(state.intents.map(i => i.id)).size !== state.intents.length ||
      new Set(state.actions.map(a => a.id)).size !== state.actions.length) {
    throw new Error('Invalid strategy state. Preserve data/strategy-state.json for inspection; no live state was reset.');
  }
}

const actionId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(value)) throw new Error('Action id must be 8–128 safe characters.');
  return value;
};

export class StrategyService {
  state: StrategyState;
  private queue = Promise.resolve();
  readonly path: string;
  readonly name: string;
  readonly deps: StrategyDependencies;
  constructor(path: string, name: string, deps?: StrategyDependencies) {
    this.path = path; this.name = name;
    this.deps = deps ?? liveDependencies((hash, operation, status) => this.update(s => {
      s.chainTransactions ??= [];
      const existing = s.chainTransactions.find(tx => tx.hash === hash);
      if (existing) existing.status = status;
      else s.chainTransactions.push({ hash, operation, status });
    }));
    this.state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as StrategyState : defaults(name);
    validate(this.state, name);
  }

  private serial<T>(task: () => Promise<T>) {
    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  update(change: (next: StrategyState) => void) {
    const next = structuredClone(this.state);
    change(next); next.generatedAt = Date.now(); validate(next, this.name); atomicWrite(this.path, next); this.state = next;
  }
  status() {
    const status = structuredClone(this.state); status.generatedAt = Date.now();
    if (!status.exposure.updatedAt || Date.now() - status.exposure.updatedAt > 30_000) status.exposure.fresh = false;
    return status;
  }

  private assertExecutionAccount() {
    const account = this.state.perpEnvironment.account;
    if (account === null && ['idle', 'proposed'].includes(this.state.phase) && this.state.lp.status === 'empty' && this.state.perp.status === 'flat' && Number(this.state.perp.sizeEth) === 0 && !this.state.accounting && !this.state.intents.some(unresolved)) return;
    if (account?.toLowerCase() === this.deps.hyperliquid.user.toLowerCase()) return;
    const message = account
      ? `Configured Hyperliquid account differs from this trial's persisted account ${account}. Restore the original account before execution.`
      : 'This live trial has no persisted Hyperliquid account. Inspect its original account before execution.';
    this.update(s => { s.phase = 'intervention_required'; s.exposure.fresh = false; s.lastError = message; });
    throw new Error(message);
  }

  propose(goal: unknown, budget: unknown) {
    return this.serial(async () => {
      if (!['idle', 'proposed', 'closed'].includes(this.state.phase) || this.state.intents.some(i => ['unknown', 'submitted', 'prepared'].includes(i.status))) throw new Error('Close or reconcile the active strategy before requesting another proposal.');
      const proposal = await this.deps.propose(this.name, goal, budget);
      this.update(s => {
        const empty = defaults(this.name);
        s.lp = empty.lp; s.perp = empty.perp; s.exposure = empty.exposure; s.costs = empty.costs;
        delete s.accounting; delete s.recoveryTarget; delete s.initialHedgePending; s.outOfRangeSince = null;
        s.proposal = proposal; s.phase = 'proposed'; s.lastError = null;
      });
      return this.status();
    });
  }

  action(idValue: unknown, action: unknown, technicalTrial = false) {
    return this.serial(async () => {
      const id = actionId(idValue);
      if (action !== 'approve' && action !== 'pause' && action !== 'resume' && action !== 'close') throw new Error('Unknown strategy action.');
      const existing = this.state.actions.find(item => item.id === id);
      if (existing) {
        if (existing.action !== action) throw new Error('Action ID was already used for a different command.');
        if (existing.status === 'failed') throw new Error(existing.error || 'The original action failed. Use a new ID after resolving the cause.');
        return this.status();
      }
      this.update(s => { s.actions.push({ id, action, status: 'pending', timestamp: Date.now() }); });
      try {
        if (action === 'approve') await this.open(id, technicalTrial);
        else if (action === 'pause') {
          if (this.state.phase !== 'active') throw new Error('Only an active strategy can be paused.');
          this.update(s => { s.phase = 'paused'; });
        } else if (action === 'resume') {
          if (this.state.phase !== 'paused') throw new Error('Only a paused strategy can be resumed.');
          this.update(s => { s.phase = 'active'; });
        } else await this.close(id);
        this.update(s => { const item = s.actions.find(a => a.id === id)!; item.status = 'done'; s.lastError = null; });
      } catch (error) {
        this.update(s => { const item = s.actions.find(a => a.id === id)!; item.status = 'failed'; item.error = errorText(error); s.lastError = errorText(error); });
        throw error;
      }
      return this.status();
    });
  }

  private intent(id: string, kind: Intent['kind'], requestedEth?: string) {
    const existing = this.state.intents.find(item => item.id === id);
    if (existing) return existing;
    this.update(s => { s.intents.push({ id, kind, status: 'prepared', createdAt: Date.now(), updatedAt: Date.now(), attempts: 0, requestedEth }); });
    return this.state.intents.at(-1)!;
  }
  private setIntent(id: string, status: Intent['status'], values: Partial<Intent> = {}) {
    this.update(s => { const item = s.intents.find(i => i.id === id)!; Object.assign(item, values, { status, updatedAt: Date.now() }); });
  }

  private async open(id: string, technicalTrial: boolean) {
    const proposal = this.state.proposal;
    if (this.state.phase !== 'proposed' || !proposal) throw new Error('Generate a proposal before approval.');
    if (!freshTimestamp(proposal.createdAt, Date.now(), 300_000)) throw new Error('Proposal is older than five minutes or has an invalid timestamp. Generate a fresh proposal after setup.');
    if (proposal.recommendation === 'wait' && !technicalTrial) throw new Error('The recommendation is wait. Explicitly approve a technical trial to continue.');
    this.assertExecutionAccount();
    const block = await this.deps.uniswap.blockNumber();
    await this.deps.uniswap.preflight?.(proposal);
    const preflight = await this.deps.hyperliquid.preflight();
    this.update(s => {
      s.phase = 'opening'; s.initialHedgePending = true; s.fork.blockNumber = block; s.perpEnvironment.account = preflight.account;
      s.perp.asset = preflight.asset; s.perp.szDecimals = preflight.szDecimals;
      s.accounting = { forkInitialUsdc: '300', perpInitialUsdc: preflight.accountValueUsd, perpValueChangeUsdc: '0' };
    });
    const lpIntent = `${id}:lp-open`;
    this.intent(lpIntent, 'lp-open');
    try {
      const lp = await this.deps.uniswap.open(proposal);
      this.setLp(lp, lpIntent);
    } catch (error) {
      this.setIntent(lpIntent, 'unknown', { attempts: 1, error: errorText(error) });
      this.update(s => { s.lp.status = 'unknown'; s.phase = 'intervention_required'; });
      throw error;
    }
    try {
      const covered = await this.hedge(`${id}:initial`);
      if (!covered) {
        await this.close(`${id}:failed-hedge`);
        throw new Error('Initial hedge failed after three attempts; both legs were closed.');
      }
      this.update(s => { s.phase = 'active'; delete s.initialHedgePending; });
    } catch (error) {
      if (['opening'].includes(this.state.phase)) this.update(s => { s.phase = 'intervention_required'; s.exposure.fresh = false; });
      throw error;
    }
  }

  private setLp(lp: LpSnapshot & { hash?: `0x${string}`; initialValueUsdc?: string }, intentId?: string) {
    this.update(s => {
      Object.assign(s.lp, { status: 'open', pool: lp.pool, fee: lp.fee, tokenId: lp.tokenId, tickLower: lp.tickLower,
        tickUpper: lp.tickUpper, liquidity: lp.liquidity, usdc: lp.usdc, weth: lp.weth, feesUsdc: lp.feesUsdc,
        feesWeth: lp.feesWeth, freeWeth: lp.freeWeth });
      if (lp.hash) s.lp.openTx = lp.hash;
      if (lp.initialValueUsdc && s.accounting) s.accounting.forkInitialUsdc = lp.initialValueUsdc;
      if (intentId) Object.assign(s.intents.find(i => i.id === intentId)!, { status: 'confirmed', externalId: lp.hash, attempts: 1, updatedAt: Date.now() });
      const price = decimalUnits(lp.priceUsd, 6);
      s.costs.lpFeesUsdc = formatUnits(decimalUnits(lp.feesUsdc, 6) + decimalUnits(lp.feesWeth, 18) * price / 10n ** 18n, 6);
      s.outOfRangeSince = lp.inRange ? null : s.outOfRangeSince ?? Date.now();
    });
  }
  private setPerp(perp: PerpSnapshot, orderId?: string) {
    if (perp.timestamp < (this.state.perp.updatedAt ?? 0)) return;
    this.update(s => {
      Object.assign(s.perp, { status: Number(perp.sizeEth) === 0 ? 'flat' : 'open', asset: perp.asset, szDecimals: perp.szDecimals,
        sizeEth: perp.sizeEth, entryPrice: perp.entryPrice, markPrice: perp.markPrice, liquidationPrice: perp.liquidationPrice,
        marginUsd: perp.marginUsd, fundingUsd: perp.fundingUsd, unrealizedPnlUsd: perp.unrealizedPnlUsd, updatedAt: perp.timestamp });
      if (orderId) s.perp.lastOrderId = orderId;
      s.costs.perpFeesUsdc = perp.feesUsd; s.costs.fundingUsdc = perp.fundingUsd; s.costs.perpUnrealizedUsdc = perp.unrealizedPnlUsd;
    });
  }

  async refresh(now?: number) {
    this.assertExecutionAccount();
    this.update(s => { s.exposure.fresh = false; });
    let snapshots;
    try { snapshots = await Promise.all([
      this.state.lp.status === 'open' && this.state.lp.tokenId ? this.deps.uniswap.read(this.state.lp.tokenId) : null,
      this.deps.hyperliquid.read(this.state.proposal?.createdAt ?? Date.now()),
    ]); } catch (error) {
      this.update(s => { s.exposure.fresh = false; s.lastError = errorText(error); });
      throw error;
    }
    const [lp, perp] = snapshots;
    const observedAt = now ?? Date.now();
    const fresh = (!lp || freshTimestamp(lp.timestamp, observedAt)) && freshTimestamp(perp.timestamp, observedAt) &&
      perp.timestamp >= (this.state.perp.updatedAt ?? 0) && Number(perp.markPrice) > 0 &&
      this.state.lp.status !== 'unknown' && !this.state.intents.some(unresolved);
    if (lp) this.setLp(lp);
    this.setPerp(perp);
    const eth = decimalUnits(lp?.weth ?? '0', 18) + decimalUnits(lp?.feesWeth ?? '0', 18) + decimalUnits(lp?.freeWeth ?? '0', 18) + decimalUnits(perp.sizeEth, 18);
    const mark = decimalUnits(perp.markPrice, 6);
    const initialFork = decimalUnits(this.state.accounting?.forkInitialUsdc ?? '300', 6);
    const forkValue = lp
      ? decimalUnits(lp.usdc, 6) + decimalUnits(lp.freeUsdc ?? '0', 6) + decimalUnits(lp.feesUsdc, 6) + (decimalUnits(lp.weth, 18) + decimalUnits(lp.feesWeth, 18) + decimalUnits(lp.freeWeth, 18)) * decimalUnits(lp.priceUsd, 6) / 10n ** 18n - initialFork
      : decimalUnits(this.state.lp.proceedsUsdc, 6) - (this.state.lp.status === 'closed' ? initialFork : 0n);
    const perpPnl = decimalUnits(perp.unrealizedPnlUsd, 6);
    this.update(s => {
      s.exposure = { eth: formatUnits(eth, 18), usd: formatUnits(eth * mark / 10n ** 18n, 6), updatedAt: Math.min(lp?.timestamp ?? perp.timestamp, perp.timestamp), fresh };
      s.costs.forkValueChangeUsdc = formatUnits(forkValue, 6); s.costs.perpUnrealizedUsdc = formatUnits(perpPnl, 6);
      const perpChange = s.accounting ? decimalUnits(perp.accountValueUsd, 6) - decimalUnits(s.accounting.perpInitialUsdc, 6) : perpPnl;
      if (s.accounting) s.accounting.perpValueChangeUsdc = formatUnits(perpChange, 6);
      s.costs.valueChangeUsdc = formatUnits(forkValue + perpChange, 6);
    });
    return { lp, perp, fresh };
  }

  private async hedge(prefix: string) {
    if (this.state.intents.some(unresolved)) throw new Error('Resolve unknown operations before hedging.');
    const previousAttempts = this.state.initialHedgePending ? this.state.intents.filter(i => i.kind === 'perp-order' && i.createdAt >= (this.state.proposal?.createdAt ?? 0)).length : 0;
    for (let attempt = 1; attempt <= 3 - previousAttempts; attempt++) {
      const { fresh } = await this.refresh();
      if (!fresh) throw new Error('Execution data is older than 30 seconds; new orders are blocked.');
      if (abs(decimalUnits(this.state.exposure.usd, 6)) <= 12n * 10n ** 6n) return true;
      const delta = -Number(this.state.exposure.eth), id = `${prefix}:perp-${attempt}`;
      const intent = this.intent(id, 'perp-order', clean(delta));
      try {
        this.setIntent(id, 'submitted', { attempts: intent.attempts + 1, cloid: cloidFor(id) });
        const result = await this.deps.hyperliquid.place(id, delta, false, this.state.proposal?.createdAt);
        this.setIntent(id, 'confirmed', { externalId: result.orderId, cloid: result.cloid });
        this.setPerp(result.position, result.orderId);
      } catch (error) {
        if (error instanceof KnownOrderError) this.setIntent(id, 'failed', { error: error.message });
        else {
          this.setIntent(id, 'unknown', { cloid: cloidFor(id), error: errorText(error) });
          this.update(s => { s.recoveryTarget = s.phase === 'paused' ? 'paused' : 'active'; s.phase = 'recovering'; s.perp.status = 'unknown'; s.exposure.fresh = false; });
          throw new Error('Hyperliquid order outcome is unknown; reconciliation is required before compensation.');
        }
      }
    }
    const final = await this.refresh();
    if (final.fresh && abs(decimalUnits(this.state.exposure.usd, 6)) <= 12n * 10n ** 6n) return true;
    this.update(s => { s.phase = 'intervention_required'; });
    return false;
  }

  private async unwindLp(prefix: string) {
    if (this.state.lp.status !== 'open' || !this.state.lp.tokenId) return;
    const id = `${prefix}:lp-close`, sell = `${prefix}:weth-sell`;
    this.intent(id, 'lp-close'); this.intent(sell, 'weth-sell');
    try {
      const result = await this.deps.uniswap.close(this.state.lp.tokenId);
      this.update(s => {
        Object.assign(s.intents.find(i => i.id === id)!, { status: 'confirmed', externalId: result.hash, attempts: 1, updatedAt: Date.now() });
        Object.assign(s.intents.find(i => i.id === sell)!, { status: 'confirmed', externalId: result.sellHash ?? 'no-weth', attempts: 1, updatedAt: Date.now() });
        Object.assign(s.lp, { status: 'closed', liquidity: '0', usdc: '0', weth: '0', feesUsdc: '0', feesWeth: '0', freeWeth: '0', proceedsUsdc: result.usdcReceived, closeTx: result.hash });
        if (result.feesValueUsdc !== undefined) s.costs.lpFeesUsdc = result.feesValueUsdc;
        s.outOfRangeSince = null;
      });
    } catch (error) {
      this.setIntent(id, 'unknown', { attempts: 1, error: errorText(error) });
      this.setIntent(sell, 'unknown', { attempts: 1, error: 'Resolve the LP close before determining whether the WETH sale was sent.' });
      this.update(s => { s.lp.status = 'unknown'; s.phase = 'intervention_required'; });
      throw error;
    }
  }

  private async close(id: string) {
    if (!['active', 'paused', 'intervention_required'].includes(this.state.phase)) throw new Error('There is no live strategy to close.');
    if (this.state.lp.status === 'unknown' || this.state.intents.some(unresolved)) throw new Error('Resolve unknown operations before closing or compensating.');
    const before = await this.refresh();
    if (!before.fresh) throw new Error('Execution data is older than 30 seconds; close is blocked before either leg changes.');
    this.update(s => { s.phase = 'closing'; s.recoveryTarget = 'closed'; });
    try {
    await this.unwindLp(id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { perp, fresh } = await this.refresh();
      if (!fresh) throw new Error('Execution data is stale after the LP close; the perp close must wait for fresh data.');
      if (Number(perp.sizeEth) === 0) break;
      const orderId = `${id}:perp-close${attempt === 1 ? '' : `-${attempt}`}`; this.intent(orderId, 'perp-order', clean(-Number(perp.sizeEth)));
      try {
        this.setIntent(orderId, 'submitted', { attempts: 1, cloid: cloidFor(orderId) });
        const result = await this.deps.hyperliquid.place(orderId, -Number(perp.sizeEth), true, this.state.proposal?.createdAt);
        this.setIntent(orderId, 'confirmed', { externalId: result.orderId, cloid: result.cloid, attempts: 1 }); this.setPerp(result.position, result.orderId);
      } catch (error) {
        this.setIntent(orderId, error instanceof KnownOrderError ? 'failed' : 'unknown', { error: errorText(error), cloid: cloidFor(orderId), attempts: 1 });
        this.update(s => { s.phase = error instanceof KnownOrderError ? 'intervention_required' : 'recovering'; s.exposure.fresh = false; }); throw error;
      }
    }
    const final = await this.refresh();
    if (!final.fresh) throw new Error('Execution data is stale; cannot confirm the strategy is closed.');
    if (Number(this.state.perp.sizeEth) !== 0) {
      this.update(s => { s.phase = 'intervention_required'; }); throw new Error('Close left a Hyperliquid residual; reconcile it before declaring the trial closed.');
    }
    this.update(s => { s.phase = 'closed'; delete s.recoveryTarget; delete s.initialHedgePending; });
    } catch (error) {
      if (this.state.phase === 'closing') this.update(s => { s.phase = 'intervention_required'; s.exposure.fresh = false; });
      throw error;
    }
  }

  recover() {
    return this.serial(() => this.reconcile());
  }

  private async reconcile() {
    const pending = this.state.intents.filter(unresolved);
    if (this.state.phase === 'closed' && !pending.length) return this.status();
    if (pending.length) this.update(s => {
      s.recoveryTarget ??= s.phase === 'closing' ? 'closed' : s.phase === 'paused' ? 'paused' : 'active';
      if (s.phase === 'opening') s.initialHedgePending = true;
      s.phase = 'recovering'; s.exposure.fresh = false;
      for (const intent of s.intents.filter(unresolved)) {
        intent.status = 'unknown';
        if (intent.kind === 'perp-order') intent.cloid ??= cloidFor(intent.id);
      }
    });
    for (const intent of this.state.intents.filter(i => i.kind === 'perp-order' && i.status === 'unknown')) {
      this.assertExecutionAccount();
      let result;
      try { result = await this.deps.hyperliquid.find(intent.cloid!, this.state.proposal?.createdAt); }
      catch (error) {
        this.update(s => { s.lastError = errorText(error); s.exposure.fresh = false; });
        return this.status();
      }
      if (result) { this.setIntent(intent.id, 'confirmed', { externalId: result.orderId }); this.setPerp(result.position, result.orderId); }
      else {
        this.update(s => {
          s.phase = Date.now() - intent.updatedAt > 30_000 ? 'intervention_required' : 'recovering';
          s.lastError = 'Order ID is not visible yet. Inspect the testnet order before resolving it; replacement orders remain blocked.';
        });
        return this.status();
      }
    }
    if (this.state.intents.some(unresolved)) {
      this.update(s => { s.phase = 'intervention_required'; s.exposure.fresh = false; s.lastError = 'Uniswap operation requires receipt inspection; automatic compensation is blocked.'; });
    } else if (this.state.recoveryTarget === 'closed' || this.state.phase === 'closing') {
      this.update(s => { s.phase = 'intervention_required'; });
      await this.close(`recovery-${randomUUID()}`);
    } else if (['recovering', 'opening'].includes(this.state.phase) && this.state.lp.status === 'open') {
      const target = this.state.recoveryTarget === 'paused' ? 'paused' : 'active';
      const covered = await this.hedge(`recovery-${randomUUID()}`);
      if (!covered && this.state.initialHedgePending) await this.close(`recovery-unwind-${randomUUID()}`);
      else this.update(s => {
        s.phase = covered ? target : 'intervention_required';
        if (covered) { delete s.initialHedgePending; delete s.recoveryTarget; s.lastError = null; }
      });
    } else if (this.state.phase === 'opening' && this.state.lp.status === 'empty') {
      this.update(s => {
        const confirmedMint = s.intents.some(i => i.kind === 'lp-open' && i.status === 'confirmed' && i.createdAt >= (s.proposal?.createdAt ?? 0));
        s.phase = confirmedMint ? 'intervention_required' : 'proposed';
        if (confirmedMint) {
          s.lp.status = 'unknown'; s.exposure.fresh = false;
          s.lastError = 'Confirmed mint has no persisted LP snapshot. Inspect its receipt before another approval.';
        }
        else delete s.initialHedgePending;
      });
    }
    this.update(s => {
      for (const action of s.actions.filter(a => a.status === 'pending')) {
        const completed = (action.action === 'approve' && ['active', 'paused'].includes(s.phase)) ||
          (action.action === 'close' && s.phase === 'closed') || (action.action === 'pause' && s.phase === 'paused') ||
          (action.action === 'resume' && s.phase === 'active');
        action.status = completed ? 'done' : 'failed';
        if (!completed) action.error = 'Process restarted before this action completed. Inspect the recovered strategy before retrying.';
      }
    });
    return this.status();
  }

  monitor() {
    return this.serial(async () => {
      if (['opening', 'closing', 'recovering'].includes(this.state.phase) || this.state.intents.some(unresolved)) return this.reconcile();
      if (!['active', 'paused'].includes(this.state.phase)) return this.status();
      const { lp, perp, fresh } = await this.refresh();
      if (!fresh) return this.status();
      const liquidationDistance = perp.liquidationPrice === null ? Infinity : Math.abs(Number(perp.liquidationPrice) - Number(perp.markPrice)) / Number(perp.markPrice);
      if ((lp && !lp.inRange && this.state.outOfRangeSince && Date.now() - this.state.outOfRangeSince >= 60_000) || liquidationDistance < .1) {
        await this.close(`auto-${randomUUID()}`); return this.status();
      }
      if (Math.abs(Number(this.state.exposure.usd)) > 12) await this.hedge(`monitor-${randomUUID()}`);
      return this.status();
    });
  }
}

function liveDependencies(record: ConstructorParameters<typeof UniswapFork>[0]): StrategyDependencies {
  let uniswap: UniswapFork | undefined, hyperliquid: HyperliquidTestnet | undefined;
  const uni = () => uniswap ??= new UniswapFork(record);
  const hl = () => hyperliquid ??= new HyperliquidTestnet();
  return {
    propose: proposeStrategy,
    uniswap: { blockNumber: () => uni().blockNumber(), preflight: proposal => uni().preflight(proposal), open: proposal => uni().open(proposal), read: tokenId => uni().read(tokenId), close: tokenId => uni().close(tokenId) },
    hyperliquid: {
      get user() { return hl().user; }, preflight: () => hl().preflight(), read: since => hl().read(since),
      place: (id, delta, reduceOnly, since) => hl().place(id, delta, reduceOnly, since), find: (cloid, since) => hl().find(cloid, since),
    },
  };
}

function clean(value: number) {
  if (!Number.isFinite(value)) throw new Error('Exposure calculation produced a non-finite value.');
  return value.toFixed(12).replace(/\.?0+$/, '') || '0';
}

function decimalUnits(value: string, decimals: number) {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid decimal value: ${value}`);
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace('-', '').split('.');
  const units = BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return negative ? -units : units;
}

const abs = (value: bigint) => value < 0n ? -value : value;
const unresolved = (intent: Intent) => ['prepared', 'submitted', 'unknown'].includes(intent.status);
const freshTimestamp = (timestamp: number, now: number, maxAge = 30_000) => Number.isSafeInteger(timestamp) && timestamp > 0 && now - timestamp <= maxAge && timestamp <= now + 5_000;

function replayLabel() {
  const parts = [];
  if (process.env.REPLAY_INITIAL_HEDGE_RATIO) parts.push(`initial hedge ratio ${process.env.REPLAY_INITIAL_HEDGE_RATIO}`);
  if (process.env.REPLAY_TIMEOUT_AFTER_SEND === '1') parts.push('timeout after first confirmed send');
  return parts.length ? `Controlled replay: ${parts.join(', ')}` : null;
}
