import { createHash } from 'node:crypto';
import { ExchangeClient, HttpTransport, InfoClient, ValidationError } from '@nktkas/hyperliquid';
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import { privateKeyToAccount } from 'viem/accounts';
import { formatUnits, parseUnits, type Address, type Hash } from 'viem';

export type PerpSnapshot = {
  asset: number; szDecimals: number; sizeEth: string; entryPrice: string; markPrice: string;
  liquidationPrice: string | null; marginUsd: string; fundingUsd: string; accountValueUsd: string;
  unrealizedPnlUsd: string; feesUsd: string; timestamp: number;
};
export type PerpOrderResult = { cloid: `0x${string}`; orderId: string; filledEth: string; position: PerpSnapshot };
export class KnownOrderError extends Error {}

const roundSize = (value: number, decimals: number) => (Math.floor((value + Number.EPSILON) * 10 ** decimals) / 10 ** decimals)
  .toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const price = (value: number, decimals: number, buy: boolean) => {
  const significant = Number(value.toPrecision(5)), scale = 10 ** Math.max(0, 6 - decimals);
  return ((buy ? Math.ceil(significant * scale) : Math.floor(significant * scale)) / scale).toFixed(Math.max(0, 6 - decimals)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};
export const cloidFor = (id: string) => `0x${createHash('sha256').update(id).digest('hex').slice(0, 32)}` as `0x${string}`;

export class HyperliquidTestnet {
  readonly user: Address;
  readonly info: InfoClient;
  readonly exchange: ExchangeClient;
  constructor() {
    const key = process.env.HYPERLIQUID_API_PRIVATE_KEY;
    const user = process.env.HYPERLIQUID_ACCOUNT_ADDRESS;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('HYPERLIQUID_API_PRIVATE_KEY is required.');
    if (!user || !/^0x[0-9a-fA-F]{40}$/.test(user)) throw new Error('HYPERLIQUID_ACCOUNT_ADDRESS must be the master testnet account, not the API wallet.');
    this.user = user as Address;
    if (privateKeyToAccount(key as Hash).address.toLowerCase() === user.toLowerCase()) throw new Error('HYPERLIQUID_API_PRIVATE_KEY must be a separate authorized testnet API wallet. Keep the master wallet key out of the executor.');
    const transport = new HttpTransport({ isTestnet: true, timeout: 10_000 });
    this.info = new InfoClient({ transport });
    this.exchange = new ExchangeClient({
      transport, wallet: privateKeyToAccount(key as Hash), isTestnet: true,
      defaultExpiresAfter: () => Date.now() + 15_000,
    });
  }

  private async metadata() {
    const [meta, contexts] = await this.info.metaAndAssetCtxs();
    const asset = meta.universe.findIndex(item => item.name === 'ETH');
    if (asset < 0) throw new Error('ETH was not found in Hyperliquid testnet metadata.');
    return { asset, universe: meta.universe[asset]!, context: contexts[asset]! };
  }

  async preflight() {
    const [state, orders, market] = await Promise.all([
      this.info.clearinghouseState({ user: this.user }), this.info.openOrders({ user: this.user }), this.metadata(),
    ]);
    if (orders.length) throw new Error('Hyperliquid testnet account has open orders outside this trial.');
    if (state.assetPositions.some(item => Number(item.position.szi) !== 0)) throw new Error('Hyperliquid testnet account has an existing position outside this trial.');
    const collateral = Number(state.marginSummary.accountValue);
    if (!Number.isFinite(collateral) || collateral < 200) throw new Error(`Hyperliquid testnet account ${this.user} has ${state.marginSummary.accountValue} USDC; at least 200 USDC of trial collateral in Perps is required.`);
    if (Date.now() - state.time > 30_000 || state.time > Date.now() + 5_000) throw new Error('Hyperliquid testnet account data is stale.');
    await this.exchange.updateLeverage({ asset: market.asset, isCross: false, leverage: 1 });
    return { account: this.user, asset: market.asset, szDecimals: market.universe.szDecimals, accountValueUsd: state.marginSummary.accountValue };
  }

  async read(since = 0): Promise<PerpSnapshot> {
    const [state, market, fills, funding] = await Promise.all([
      this.info.clearinghouseState({ user: this.user }), this.metadata(),
      this.info.userFillsByTime({ user: this.user, startTime: since, aggregateByTime: false }),
      this.info.userFunding({ user: this.user, startTime: since }),
    ]);
    // ponytail: one page per short trial; add persisted pagination before running longer campaigns.
    if (fills.length >= 2000 || funding.length >= 500) throw new Error('Trial accounting exceeds one history page; reconcile the full ledger before continuing.');
    const position = state.assetPositions.find(item => item.position.coin === 'ETH')?.position;
    return {
      asset: market.asset, szDecimals: market.universe.szDecimals, sizeEth: position?.szi ?? '0', entryPrice: position?.entryPx ?? '0',
      markPrice: market.context.markPx, liquidationPrice: position?.liquidationPx ?? null, marginUsd: position?.marginUsed ?? '0',
      fundingUsd: formatUnits(funding.filter(item => item.delta.coin === 'ETH' && item.time >= since).reduce((sum, item) => sum + parseUnits(item.delta.usdc, 18), 0n), 18), accountValueUsd: state.marginSummary.accountValue,
      unrealizedPnlUsd: position?.unrealizedPnl ?? '0',
      feesUsd: formatUnits(fills.filter(fill => fill.coin === 'ETH' && fill.time >= since && fill.feeToken === 'USDC').reduce((sum, fill) => sum + parseUnits(fill.fee, 18), 0n), 18),
      timestamp: state.time,
    };
  }

  async place(intentId: string, deltaEth: number, reduceOnly: boolean, since = 0): Promise<PerpOrderResult> {
    if (!Number.isFinite(deltaEth) || deltaEth === 0) throw new KnownOrderError('Order size must be finite and nonzero.');
    const [market, book] = await Promise.all([this.metadata(), this.info.l2Book({ coin: 'ETH' })]).catch(error => {
      throw new KnownOrderError(`Order was not submitted: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!book || !Number.isSafeInteger(book.time) || Date.now() - book.time > 30_000 || book.time > Date.now() + 5_000) throw new KnownOrderError('Hyperliquid testnet order book is stale; order was not submitted.');
    if (!Number.isFinite(Number(market.context.markPx)) || Number(market.context.markPx) <= 0) throw new KnownOrderError('Hyperliquid mark price is invalid; order was not submitted.');
    const replayFirst = intentId.includes(':initial:perp-1');
    const ratio = replayFirst && process.env.REPLAY_INITIAL_HEDGE_RATIO ? Number(process.env.REPLAY_INITIAL_HEDGE_RATIO) : 1;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new KnownOrderError('REPLAY_INITIAL_HEDGE_RATIO must be greater than 0 and at most 1.');
    const buy = deltaEth > 0, size = roundSize(Math.abs(deltaEth) * ratio, market.universe.szDecimals);
    if (!(Number(size) > 0) || Number(size) * Number(market.context.markPx) < Number(process.env.HYPERLIQUID_MIN_NOTIONAL_USD || 10)) {
      throw new KnownOrderError('Residual is below the configured Hyperliquid minimum order notional.');
    }
    const top = Number(book.levels[buy ? 1 : 0][0]?.px);
    if (!Number.isFinite(top) || top <= 0) throw new KnownOrderError('Hyperliquid testnet ETH book has no executable level.');
    const cloid = cloidFor(intentId);
    const result = await this.exchange.order({ orders: [{
      a: market.asset, b: buy, p: price(top * (buy ? 1.01 : .99), market.universe.szDecimals, buy), s: size,
      r: reduceOnly, t: { limit: { tif: 'Ioc' } }, c: cloid,
    }], grouping: 'na' }).catch(error => {
      if (error instanceof ApiRequestError || error instanceof ValidationError) throw new KnownOrderError(error.message);
      throw error;
    });
    const confirmedAt = Date.now();
    const status = result.response.data.statuses[0];
    if (!status || typeof status === 'string' || !('filled' in status)) throw new Error('Hyperliquid order has no terminal fill confirmation; reconcile its client order ID.');
    const position = await this.read(since);
    if (position.timestamp < confirmedAt) throw new Error('Hyperliquid account snapshot predates the order confirmation; reconcile before continuing.');
    if (replayFirst && process.env.REPLAY_TIMEOUT_AFTER_SEND === '1') throw new Error('Controlled replay: response discarded after the testnet order was confirmed. Restart to reconcile its cloid.');
    return { cloid, orderId: String(status.filled.oid), filledEth: status.filled.totalSz, position };
  }

  async find(cloid: `0x${string}`, since = 0): Promise<PerpOrderResult | null> {
    const status = await this.info.orderStatus({ user: this.user, oid: cloid });
    if (status.status === 'unknownOid') return null;
    if (!/^(filled|canceled|rejected|scheduledCancel|internalCancel|[a-zA-Z]+Canceled|[a-zA-Z]+Rejected)$/.test(status.order.status)) throw new Error('Hyperliquid order is still live or has an unrecognized status; reconciliation must wait for a terminal status.');
    const position = await this.read(since);
    if (position.timestamp < status.order.statusTimestamp) throw new Error('Hyperliquid account snapshot predates the terminal order status.');
    const order = status.order.order;
    return { cloid, orderId: String(order.oid), filledEth: status.order.status === 'filled' ? order.origSz : formatUnits(parseUnits(order.origSz, 18) - parseUnits(order.sz, 18), 18), position };
  }
}
