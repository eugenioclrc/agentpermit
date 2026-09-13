import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Address } from 'viem';
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import type { StrategyProposal } from '../shared/strategy.ts';
import { Engine } from '../server/engine.ts';
import { cloidFor, HyperliquidTestnet, KnownOrderError, type PerpSnapshot } from '../server/hyperliquid.ts';
import { apiServer } from '../server/http.ts';
import { StrategyService, type StrategyDependencies } from '../server/strategy.ts';
import type { LpSnapshot } from '../server/uniswap.ts';

const name = 'delta.agentpermit.eth';
const user = '0x0000000000000000000000000000000000000001' as Address;
const tx = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const pool = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' as const;

function proposal(): StrategyProposal {
  const now = Date.now();
  return {
    id: 'proposal-1', createdAt: now, goal: 'Create a covered WETH USDC position', budgetUsdc: '500', recommendation: 'open', poolFee: 500,
    reasons: ['The selected pool has deeper liquidity.', 'Funding is acceptable for this technical trial.'], evidenceIds: ['pool_500_tvl_usd', 'hl_funding_rate'],
    risks: ['Range exits can crystallize inventory changes.', 'Funding and execution costs can exceed fees.'], allocation: { lpUsdc: '300', perpReserveUsdc: '200' },
    rangePercent: 20, leverage: 1, model: 'gpt-5-nano', graph: { block: 23_000_000, queriedAt: now, pools: [{
      pool, fee: 500, liquidity: '1', tvlUsd: '1000000', sevenDayVolumeUsd: '2000000', sevenDayFeesUsd: '1000',
      days: Array.from({ length: 7 }, (_, i) => ({ date: i, tvlUsd: '1', volumeUsd: '1', feesUsd: '1', token0Price: '0.0003', token1Price: '3000' })),
    }, { pool: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', fee: 3000, liquidity: '1', tvlUsd: '500000', sevenDayVolumeUsd: '1000000', sevenDayFeesUsd: '3000', days: Array.from({ length: 7 }, (_, i) => ({ date: i, tvlUsd: '1', volumeUsd: '1', feesUsd: '1', token0Price: '0.0003', token1Price: '3000' })) }] },
    hyperliquid: { markPrice: '3000', fundingRate: '0.00001', openInterestEth: '1000', bidDepthUsd: '100000', askDepthUsd: '100000', timestamp: now },
  };
}

function fixture(t: { after: (fn: () => void) => void }, place?: (delta: number, id: string, reduceOnly: boolean) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'agentpermit-strategy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'strategy.json');
  let placeCalls = 0, closeCalls = 0;
  const lp: LpSnapshot = { pool, tokenId: '42', fee: 500, tickLower: -100, tickUpper: 100, tick: 0, liquidity: '100', usdc: '150', weth: '0.05', feesUsdc: '0', feesWeth: '0', freeWeth: '0', inRange: true, priceUsd: '3000', timestamp: Date.now() };
  const perp: PerpSnapshot = { asset: 1, szDecimals: 5, sizeEth: '0', entryPrice: '0', markPrice: '3000', liquidationPrice: null, marginUsd: '0', fundingUsd: '0', unrealizedPnlUsd: '0', accountValueUsd: '250', feesUsd: '0', timestamp: Date.now() };
  const deps: StrategyDependencies = {
    propose: async () => proposal(),
    uniswap: {
      blockNumber: async () => 23_000_000,
      open: async () => ({ ...lp, hash: tx }),
      read: async () => ({ ...lp, timestamp: Date.now() }),
      close: async () => { closeCalls++; lp.liquidity = '0'; lp.weth = '0'; lp.usdc = '0'; return { hash: tx, sellHash: tx, usdcReceived: '300' }; },
    },
    hyperliquid: {
      user, preflight: async () => ({ account: user, asset: 1, szDecimals: 5, accountValueUsd: '250' }),
      read: async () => ({ ...perp, timestamp: Date.now() }),
      place: async (id, delta, reduceOnly) => {
        placeCalls++; place?.(delta, id, reduceOnly);
        if (!place) perp.sizeEth = String(Number(perp.sizeEth) + delta);
        perp.entryPrice = Number(perp.sizeEth) ? '3000' : '0'; perp.marginUsd = String(Math.abs(Number(perp.sizeEth)) * 3000);
        return { cloid: cloidFor(id), orderId: String(placeCalls), filledEth: String(Math.abs(delta)), position: { ...perp, timestamp: Date.now() } };
      },
      find: async cloid => ({ cloid, orderId: 'recovered', filledEth: '0.05', position: { ...perp, timestamp: Date.now() } }),
    },
  };
  return { statePath, deps, lp, perp, calls: () => ({ placeCalls, closeCalls }) };
}

test('live lifecycle recalculates partial fills, LP fees/free WETH and closes after 60 seconds out of range', async t => {
  let call = 0;
  const f = fixture(t, delta => {
    call++;
    f.perp.sizeEth = call === 1 ? '-0.04' : String(Number(f.perp.sizeEth) + delta);
  });
  const service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('approve-001', 'approve');
  assert.equal(service.state.phase, 'active');
  assert.equal(service.state.exposure.usd, '0');
  assert.equal(f.calls().placeCalls, 2); // -0.04 partial, then only the -0.01 residual.
  await service.action('approve-001', 'approve');
  assert.equal(f.calls().placeCalls, 2); // idempotent action ID.

  f.lp.weth = '0.04'; f.lp.feesWeth = '0.002'; f.lp.freeWeth = '0.003';
  await service.monitor();
  assert.equal(f.calls().placeCalls, 3);
  assert.equal(service.state.exposure.usd, '0');
  assert.equal(service.state.costs.lpFeesUsdc, '6');
  assert.equal(service.state.costs.forkValueChangeUsdc, '-15');

  f.lp.inRange = false;
  service.update(s => { s.outOfRangeSince = Date.now() - 61_000; });
  await service.monitor();
  assert.equal(service.state.phase, 'closed');
  assert.equal(f.calls().closeCalls, 1);
  assert.equal(service.state.costs.valueChangeUsdc, '0');
  assert.ok(service.state.intents.every(intent => intent.status === 'confirmed'));
});

test('timeout after a submitted perp order is reconciled after restart without a duplicate', async t => {
  let first = true;
  const f = fixture(t, () => {
    if (first) { first = false; f.perp.sizeEth = '-0.05'; throw new Error('transport timed out after send'); }
  });
  const service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await assert.rejects(() => service.action('approve-timeout', 'approve'), /reconciliation/);
  assert.equal(service.state.phase, 'recovering');
  assert.equal(service.state.intents.filter(intent => intent.status === 'unknown').length, 1);
  assert.equal(f.calls().placeCalls, 1);

  const restarted = new StrategyService(f.statePath, name, f.deps);
  await restarted.recover();
  assert.equal(restarted.state.phase, 'active');
  assert.equal(restarted.state.exposure.usd, '0');
  assert.equal(f.calls().placeCalls, 1);
  assert.equal(restarted.state.intents.find(intent => intent.kind === 'perp-order')?.externalId, 'recovered');
});

test('three definitive initial hedge failures unwind the LP', async t => {
  const f = fixture(t, () => { throw new KnownOrderError('known rejection'); });
  const service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await assert.rejects(() => service.action('approve-rejected', 'approve'), /both legs were closed/);
  assert.equal(f.calls().placeCalls, 3);
  assert.equal(f.calls().closeCalls, 1);
  assert.equal(service.state.phase, 'closed');
  assert.equal(service.state.intents.filter(intent => intent.kind === 'perp-order' && intent.status === 'failed').length, 3);
});

test('failed preflight leaves the proposal retryable without opening either leg', async t => {
  const f = fixture(t);
  f.deps.hyperliquid.preflight = async () => { throw new Error('insufficient collateral'); };
  const service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await assert.rejects(() => service.action('approve-preflight', 'approve'), /insufficient collateral/);
  assert.equal(service.state.phase, 'proposed');
  assert.equal(service.state.intents.length, 0);
});

test('the third confirmed hedge is checked before deciding to unwind', async t => {
  let attempts = 0;
  const f = fixture(t, () => { f.perp.sizeEth = ['-0.02', '-0.03', '-0.05'][attempts++]!; });
  const service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('third-attempt', 'approve');
  assert.equal(service.state.phase, 'active');
  assert.equal(f.calls().closeCalls, 0);
  assert.equal(service.state.exposure.eth, '0');
});

test('failed initial partial hedge closes both the LP and the confirmed short', async t => {
  let attempts = 0;
  const f = fixture(t, (delta, _id, reduceOnly) => {
    if (reduceOnly) { f.perp.sizeEth = String(Number(f.perp.sizeEth) + delta); return; }
    if (++attempts === 1) f.perp.sizeEth = '-0.02';
    else throw new KnownOrderError('known rejection');
  });
  const service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await assert.rejects(() => service.action('partial-failed', 'approve'), /both legs were closed/);
  assert.equal(service.state.phase, 'closed');
  assert.equal(f.perp.sizeEth, '0');
  assert.equal(service.state.exposure.eth, '0');
});

test('restart reconciles a submitted intent even if the process never recorded its timeout', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('before-crash', 'approve');
  service.update(s => {
    s.phase = 'opening'; s.intents.at(-1)!.status = 'submitted';
  });
  const calls = f.calls().placeCalls;
  const restarted = new StrategyService(f.statePath, name, f.deps);
  await restarted.recover();
  assert.equal(restarted.state.phase, 'active');
  assert.equal(f.calls().placeCalls, calls);
  assert.ok(restarted.state.intents.every(i => i.status === 'confirmed'));
});

test('uncertain reduce-only close recovers to closed without reopening a hedge', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('before-close', 'approve');
  const place = f.deps.hyperliquid.place;
  f.deps.hyperliquid.place = async (...args) => { await place(...args); throw new Error('response lost'); };
  await assert.rejects(() => service.action('close-timeout', 'close'), /response lost/);
  assert.equal(service.state.phase, 'recovering');
  const calls = f.calls().placeCalls;
  const restarted = new StrategyService(f.statePath, name, f.deps);
  await restarted.recover();
  assert.equal(restarted.state.phase, 'closed');
  assert.equal(f.calls().placeCalls, calls);
  assert.equal(restarted.state.exposure.eth, '0');
});

test('stale or failed execution reads block orders and cannot leave a fresh badge', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('before-stale', 'approve');
  f.lp.weth = '0.1';
  f.deps.hyperliquid.read = async () => ({ ...f.perp, timestamp: Date.now() - 31_000 });
  const calls = f.calls().placeCalls;
  await service.monitor();
  assert.equal(service.status().exposure.fresh, false);
  assert.equal(f.calls().placeCalls, calls);
  f.deps.hyperliquid.read = async () => { throw new Error('disconnected'); };
  await assert.rejects(() => service.monitor(), /disconnected/);
  assert.equal(service.status().exposure.fresh, false);
  f.deps.hyperliquid.read = async () => ({ ...f.perp, feesUsd: 'invalid', timestamp: Date.now() });
  await assert.rejects(() => service.monitor(), /Invalid strategy state/);
  assert.equal(service.status().exposure.fresh, false);
});

test('isolated accounting includes idle USDC and realized perp costs once, including after close', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  f.lp.freeUsdc = '350';
  const open = f.deps.uniswap.open;
  f.deps.uniswap.open = async p => ({ ...await open(p), initialValueUsdc: '650' });
  const close = f.deps.uniswap.close;
  f.deps.uniswap.close = async id => ({ ...await close(id), usdcReceived: '649.5' });
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('accounting-open', 'approve');
  f.perp.accountValueUsd = '248'; f.perp.feesUsd = '0.5'; f.perp.fundingUsd = '0.2';
  await service.refresh();
  assert.equal(service.state.costs.forkValueChangeUsdc, '0');
  assert.equal(service.state.accounting?.perpValueChangeUsdc, '-2');
  assert.equal(service.state.costs.valueChangeUsdc, '-2');
  await service.action('accounting-close', 'close');
  assert.equal(service.state.costs.valueChangeUsdc, '-2.5');
});

test('intervention cannot be erased by a proposal or a reused action ID', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('same-action-id', 'approve');
  await assert.rejects(() => service.action('same-action-id', 'close'), /different command/);
  service.update(s => { s.phase = 'intervention_required'; });
  await assert.rejects(() => service.propose('Create another covered WETH USDC position', 500), /reconcile/);
  assert.equal(service.state.lp.status, 'open');
});

test('missing and temporarily unreadable submitted orders block replacements and recover the paused target', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('pause-recovery-open', 'approve');
  await service.action('pause-recovery-pause', 'pause');
  service.update(s => { s.intents.at(-1)!.status = 'submitted'; s.intents.at(-1)!.updatedAt = Date.now() - 60_000; });
  f.lp.weth = '0.1';
  const find = f.deps.hyperliquid.find, calls = f.calls().placeCalls;
  f.deps.hyperliquid.find = async () => { throw new Error('status endpoint disconnected'); };
  const restarted = new StrategyService(f.statePath, name, f.deps);
  await restarted.recover();
  assert.equal(restarted.state.phase, 'recovering');
  assert.equal(restarted.state.recoveryTarget, 'paused');
  f.deps.hyperliquid.find = async () => null;
  await restarted.monitor();
  assert.equal(restarted.state.phase, 'intervention_required');
  assert.equal(restarted.state.intents.at(-1)!.status, 'unknown');
  assert.equal(restarted.status().exposure.fresh, false);
  await assert.rejects(() => restarted.action('blocked-unknown-close', 'close'), /unknown operations/);
  assert.equal(f.calls().placeCalls, calls);
  f.deps.hyperliquid.find = find;
  await restarted.monitor();
  assert.equal(restarted.state.phase, 'paused');
  assert.equal(f.calls().placeCalls, calls + 1);
  assert.equal(restarted.state.exposure.eth, '0');
});

test('recovery preserves the three-attempt initial hedge budget and unwinds a partial short', async t => {
  let calls = 0;
  const f = fixture(t, (delta, _id, reduceOnly) => {
    if (reduceOnly) { f.perp.sizeEth = String(Number(f.perp.sizeEth) + delta); return; }
    if (++calls === 1) { f.perp.sizeEth = '-0.02'; throw new Error('lost fill response'); }
    throw new KnownOrderError('known rejection');
  });
  const service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await assert.rejects(() => service.action('recovered-initial-open', 'approve'), /reconciliation/);
  const restarted = new StrategyService(f.statePath, name, f.deps);
  await restarted.monitor();
  assert.equal(calls, 3);
  assert.equal(f.perp.sizeEth, '0');
  assert.equal(restarted.state.phase, 'closed');
  assert.equal(restarted.state.initialHedgePending, undefined);
});

test('close checks both the post-unwind read and final confirmation for freshness', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('stale-close-open', 'approve');
  const close = f.deps.uniswap.close, read = f.deps.hyperliquid.read;
  f.deps.uniswap.close = async id => {
    const result = await close(id);
    f.deps.hyperliquid.read = async () => ({ ...f.perp, timestamp: Date.now() - 31_000 });
    return result;
  };
  const calls = f.calls().placeCalls;
  await assert.rejects(() => service.action('stale-after-lp-close', 'close'), /stale after the LP close/);
  assert.equal(service.state.lp.status, 'closed');
  assert.equal(service.state.phase, 'intervention_required');
  assert.equal(service.status().exposure.fresh, false);
  assert.equal(f.calls().placeCalls, calls);
  f.deps.hyperliquid.read = read;
  const place = f.deps.hyperliquid.place;
  f.deps.hyperliquid.place = async (...args) => {
    const result = await place(...args);
    f.deps.hyperliquid.read = async () => ({ ...f.perp, timestamp: Date.now() - 31_000 });
    return result;
  };
  await assert.rejects(() => service.action('stale-final-close', 'close'), /stale/);
  assert.notEqual(service.state.phase, 'closed');
  f.deps.hyperliquid.read = read;
  await service.recover();
  assert.equal(service.state.phase, 'closed');
  assert.equal(service.state.recoveryTarget, undefined);
});

test('close retries confirmed partial fills but does not label a nonzero residual closed', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('partial-close-open', 'approve');
  const place = f.deps.hyperliquid.place;
  f.deps.hyperliquid.place = (id, delta, reduceOnly, since) => place(id, delta / 2, reduceOnly, since);
  await assert.rejects(() => service.action('partial-close-action', 'close'), /residual/);
  assert.equal(service.state.phase, 'intervention_required');
  assert.equal(f.calls().placeCalls, 4);
  f.deps.hyperliquid.place = place;
  await service.action('partial-close-finish', 'close');
  assert.equal(service.state.phase, 'closed');
  const calls = f.calls().placeCalls;
  f.perp.sizeEth = '-1';
  await service.recover();
  assert.equal(f.calls().placeCalls, calls);
});

test('older in-window account snapshots cannot replace a confirmed position or trigger a hedge', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('monotonic-open', 'approve');
  const calls = f.calls().placeCalls;
  f.deps.hyperliquid.read = async () => ({ ...f.perp, sizeEth: '0', timestamp: service.state.perp.updatedAt! - 1 });
  await service.monitor();
  assert.equal(service.status().exposure.fresh, false);
  assert.equal(service.state.perp.sizeEth, '-0.05');
  assert.equal(f.calls().placeCalls, calls);
});

test('mint and burn confirmation persist together with their recoverable LP snapshots', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  const update = service.update.bind(service);
  service.update = change => update(s => {
    change(s);
    if (s.intents.some(i => i.kind === 'lp-open' && i.status === 'confirmed')) assert.equal(s.lp.tokenId, '42');
    if (s.intents.some(i => i.kind === 'lp-close' && i.status === 'confirmed')) assert.equal(s.lp.status, 'closed');
  });
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('atomic-open', 'approve');
  const close = f.deps.uniswap.close;
  f.deps.uniswap.close = async id => ({ ...await close(id), feesValueUsdc: '1.25' });
  await service.action('atomic-close', 'close');
  assert.equal(service.state.costs.lpFeesUsdc, '1.25');
});

test('a legacy confirmed mint without a snapshot cannot return to proposed after restart', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  service.update(s => {
    s.phase = 'opening';
    s.intents.push({ id: 'legacy-open', kind: 'lp-open', status: 'confirmed', attempts: 1, createdAt: Date.now(), updatedAt: Date.now(), externalId: tx });
  });
  await service.recover();
  assert.equal(service.state.phase, 'intervention_required');
  assert.equal(service.state.lp.status, 'unknown');
  await assert.rejects(() => service.action('legacy-mint-close', 'close'), /unknown operations/);
  await assert.rejects(() => service.propose('Create another covered WETH USDC position', 500), /reconcile/);
  assert.equal(service.state.lp.status, 'unknown');
  await assert.rejects(() => service.action('duplicate-mint-attempt', 'approve'), /Generate a proposal/);
});

test('restart blocks a changed or missing trial account before reads, reconciliation or orders', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  await service.action('bound-account-open', 'approve');
  const calls = f.calls();
  let reads = 0, finds = 0;
  f.deps.hyperliquid.user = '0x0000000000000000000000000000000000000002';
  f.deps.hyperliquid.read = async () => { reads++; return { ...f.perp, timestamp: Date.now() }; };
  f.deps.hyperliquid.find = async () => { finds++; return null; };
  const restarted = new StrategyService(f.statePath, name, f.deps);
  await assert.rejects(() => restarted.monitor(), /persisted account/);
  assert.equal(restarted.state.phase, 'intervention_required');
  assert.equal(restarted.state.perpEnvironment.account, user);
  assert.equal(restarted.status().exposure.fresh, false);
  await assert.rejects(() => restarted.action('changed-account-close', 'close'), /persisted account/);
  restarted.update(s => { s.intents.at(-1)!.status = 'submitted'; });
  await assert.rejects(() => restarted.recover(), /persisted account/);
  assert.equal(restarted.state.intents.at(-1)!.status, 'unknown');
  assert.equal(restarted.state.perpEnvironment.account, user);
  assert.equal(restarted.state.phase, 'intervention_required');
  restarted.update(s => { s.perpEnvironment.account = null; });
  await assert.rejects(() => restarted.refresh(), /no persisted Hyperliquid account/);
  assert.equal(restarted.state.perpEnvironment.account, null);
  assert.deepEqual(f.calls(), calls);
  assert.equal(reads, 0);
  assert.equal(finds, 0);
});

test('stale proposals and failed fork preflight cannot mint or create uncertain intents', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  await service.propose('Create a covered WETH USDC position', 500);
  for (const offset of [-300_001, 6_000]) {
    service.update(s => { s.proposal!.createdAt = Date.now() + offset; });
    await assert.rejects(() => service.action(`stale-proposal-${offset}`, 'approve'), /fresh proposal/);
  }
  service.update(s => { s.proposal!.createdAt = Date.now(); });
  f.deps.uniswap.preflight = async () => { throw new Error('Fresh fork funding is required.'); };
  await assert.rejects(() => service.action('fork-preflight-blocked', 'approve'), /Fresh fork funding/);
  assert.equal(service.state.phase, 'proposed');
  assert.equal(service.state.intents.length, 0);
});

test('adapter keeps pending responses unknown and distinguishes SDK rejection from a lost acknowledgement', async t => {
  const f = fixture(t), adapter = Object.create(HyperliquidTestnet.prototype) as HyperliquidTestnet;
  let response: unknown = 'waitingForFill';
  let failure: Error | undefined;
  Object.assign(adapter, {
    info: {
      metaAndAssetCtxs: async () => [{ universe: [{ name: 'ETH', szDecimals: 5 }] }, [{ markPx: '3000' }]],
      l2Book: async () => ({ time: Date.now(), levels: [[{ px: '3000' }], [{ px: '3001' }]] }),
    },
    exchange: { order: async () => { if (failure) throw failure; return { response: { data: { statuses: [response] } } }; } },
    read: async () => ({ ...f.perp, timestamp: Date.now() }),
  });
  for (response of ['waitingForFill', 'waitingForTrigger', { resting: { oid: 1 } }]) {
    await assert.rejects(() => adapter.place('pending-response', -.05, false), error => error instanceof Error && !(error instanceof KnownOrderError));
  }
  failure = new ApiRequestError({ status: 'err', response: 'rejected' }, 'rejected');
  await assert.rejects(() => adapter.place('sdk-rejection', -.05, false), KnownOrderError);
  failure = undefined;
  response = { filled: { oid: 1, totalSz: '0.05' } };
  adapter.read = async () => ({ ...f.perp, timestamp: Date.now() - 10_000 });
  await assert.rejects(() => adapter.place('stale-result', -.05, false), /predates the order/);
  Object.assign(adapter.info, { l2Book: async () => { throw new Error('book disconnected before send'); } });
  await assert.rejects(() => adapter.place('book-disconnected', -.05, false), KnownOrderError);
});

test('adapter reconciles only terminal statuses and reports the actual partial fill size', async t => {
  const f = fixture(t), adapter = Object.create(HyperliquidTestnet.prototype) as HyperliquidTestnet;
  let status = 'open';
  Object.assign(adapter, {
    user,
    info: { orderStatus: async () => ({ status: 'order', order: { status, statusTimestamp: Date.now() - 1_000, order: { oid: 1, origSz: '0.05', sz: '0.02' } } }) },
    read: async () => ({ ...f.perp, timestamp: Date.now() }),
  });
  for (status of ['open', 'triggered', 'unrecognized']) await assert.rejects(() => adapter.find(cloidFor('terminal-check')), /terminal status/);
  status = 'canceled';
  assert.equal((await adapter.find(cloidFor('terminal-check')))!.filledEth, '0.03');
  adapter.read = async () => ({ ...f.perp, timestamp: Date.now() - 5_000 });
  await assert.rejects(() => adapter.find(cloidFor('terminal-check')), /predates the terminal/);
});

test('adapter totals trial funding after flat and decimal fees without floating point drift', async () => {
  const adapter = Object.create(HyperliquidTestnet.prototype) as HyperliquidTestnet;
  const since = Date.now() - 10_000;
  Object.assign(adapter, { user, info: {
    clearinghouseState: async () => ({ assetPositions: [], marginSummary: { accountValue: '249.9' }, time: Date.now() }),
    metaAndAssetCtxs: async () => [{ universe: [{ name: 'ETH', szDecimals: 5 }] }, [{ markPx: '3000' }]],
    userFillsByTime: async ({ startTime }: { startTime: number }) => {
      assert.equal(startTime, since);
      return ['0.1', '0.2'].map(fee => ({ coin: 'ETH', time: since + 1, feeToken: 'USDC', fee }));
    },
    userFunding: async () => [
      { time: since - 1, delta: { coin: 'ETH', usdc: '100' } },
      { time: since + 1, delta: { coin: 'BTC', usdc: '100' } },
      { time: since + 1, delta: { coin: 'ETH', usdc: '0.2' } },
      { time: since + 2, delta: { coin: 'ETH', usdc: '-0.1' } },
    ],
  } });
  const snapshot = await adapter.read(since);
  assert.equal(snapshot.sizeEth, '0');
  assert.equal(snapshot.fundingUsd, '0.1');
  assert.equal(snapshot.feesUsd, '0.3');
});

test('strategy writes require browser origin and the ephemeral session token', async t => {
  const f = fixture(t), service = new StrategyService(f.statePath, name, f.deps);
  const engine = new Engine(join(f.statePath, 'paper.json'), name);
  const server = apiServer(() => engine, null, service, 'session-secret');
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/strategy/session`)).status, 403);
  assert.equal((await fetch(`${base}/strategy/propose`, { method: 'POST', headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const response = await fetch(`${base}/strategy/propose`, { method: 'POST', headers: { origin: 'http://127.0.0.1:5173', authorization: 'Bearer session-secret', 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'Create a covered WETH USDC position', budget: 500 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { phase: string }).phase, 'proposed');
  const discovered = await (await fetch(`${base}/agent/v1/status`)).json() as { strategy: { name: string; phase: string } };
  assert.equal(discovered.strategy.name, name);
  assert.equal(discovered.strategy.phase, 'proposed');
  assert.ok(!(await (await fetch(`${base}/config`)).text()).includes('session-secret'));
});
