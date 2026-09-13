export type StrategyPhase = 'idle' | 'proposed' | 'opening' | 'recovering' | 'active' | 'paused' | 'closing' | 'closed' | 'intervention_required';

export type PoolDay = { date: number; tvlUsd: string; volumeUsd: string; feesUsd: string; token0Price: string; token1Price: string };
export type PoolMetrics = {
  pool: `0x${string}`;
  fee: 500 | 3000;
  liquidity: string;
  tvlUsd: string;
  sevenDayVolumeUsd: string;
  sevenDayFeesUsd: string;
  days: PoolDay[];
};
export type HyperliquidMetrics = {
  markPrice: string;
  fundingRate: string;
  openInterestEth: string;
  bidDepthUsd: string;
  askDepthUsd: string;
  timestamp: number;
};
export type StrategyProposal = {
  id: string;
  createdAt: number;
  goal: string;
  budgetUsdc: string;
  recommendation: 'open' | 'wait';
  poolFee: 500 | 3000;
  reasons: string[];
  evidenceIds: string[];
  risks: string[];
  allocation: { lpUsdc: '300'; perpReserveUsdc: '200' };
  rangePercent: 20;
  leverage: 1;
  graph: { block: number; queriedAt: number; pools: PoolMetrics[] };
  hyperliquid: HyperliquidMetrics;
  model: 'gpt-5-nano';
};

export type Intent = {
  id: string;
  kind: 'lp-open' | 'perp-order' | 'lp-close' | 'weth-sell';
  status: 'prepared' | 'submitted' | 'confirmed' | 'unknown' | 'failed';
  createdAt: number;
  updatedAt: number;
  attempts: number;
  requestedEth?: string;
  cloid?: `0x${string}`;
  externalId?: string;
  error?: string;
};

export type StrategyState = {
  schema: 1;
  mode: 'delta-neutral';
  name: string;
  phase: StrategyPhase;
  generatedAt: number;
  proposal: StrategyProposal | null;
  fork: { chainId: 31337; blockNumber: number | null; positionManager: `0x${string}`; poolEnvironment: 'Ethereum mainnet fork' };
  perpEnvironment: { network: 'Hyperliquid testnet'; account: `0x${string}` | null; market: 'ETH'; replay: string | null };
  lp: {
    status: 'empty' | 'open' | 'closed' | 'unknown';
    pool: `0x${string}` | null;
    fee: 500 | 3000 | null;
    tokenId: string | null;
    tickLower: number | null;
    tickUpper: number | null;
    liquidity: string;
    usdc: string;
    weth: string;
    feesUsdc: string;
    feesWeth: string;
    freeWeth: string;
    proceedsUsdc: string;
    openTx: `0x${string}` | null;
    closeTx: `0x${string}` | null;
  };
  perp: {
    status: 'flat' | 'open' | 'unknown';
    asset: number | null;
    szDecimals: number | null;
    sizeEth: string;
    entryPrice: string;
    markPrice: string;
    liquidationPrice: string | null;
    marginUsd: string;
    fundingUsd: string;
    unrealizedPnlUsd: string;
    lastOrderId: string | null;
    updatedAt?: number;
  };
  exposure: { eth: string; usd: string; updatedAt: number | null; fresh: boolean };
  costs: { lpFeesUsdc: string; perpFeesUsdc: string; fundingUsdc: string; forkValueChangeUsdc: string; perpUnrealizedUsdc: string; valueChangeUsdc: string };
  outOfRangeSince: number | null;
  intents: Intent[];
  actions: { id: string; action: 'approve' | 'pause' | 'resume' | 'close'; status: 'pending' | 'done' | 'failed'; timestamp: number; error?: string }[];
  lastError: string | null;
  recoveryTarget?: 'active' | 'paused' | 'closed';
  initialHedgePending?: boolean;
  accounting?: { forkInitialUsdc: string; perpInitialUsdc: string; perpValueChangeUsdc: string };
  chainTransactions?: { hash: `0x${string}`; operation: string; status: 'prepared' | 'confirmed' | 'reverted' }[];
};

export function parseStrategyStatus(value: unknown): StrategyState {
  const s = value as StrategyState;
  const decimal = (x: unknown) => typeof x === 'string' && /^-?\d{1,30}(\.\d{1,18})?$/.test(x);
  if (!s || s.schema !== 1 || s.mode !== 'delta-neutral' || typeof s.name !== 'string' ||
      !['idle', 'proposed', 'opening', 'recovering', 'active', 'paused', 'closing', 'closed', 'intervention_required'].includes(s.phase) ||
      !Number.isSafeInteger(s.generatedAt) || !s.lp || !s.perp || !s.exposure ||
      !s.costs || !s.fork || !s.perpEnvironment || !(s.perpEnvironment.replay === null || typeof s.perpEnvironment.replay === 'string') ||
      ![s.lp.liquidity, s.lp.usdc, s.lp.weth, s.lp.feesUsdc, s.lp.feesWeth, s.lp.freeWeth, s.lp.proceedsUsdc,
        s.perp.sizeEth, s.perp.entryPrice, s.perp.markPrice, s.perp.marginUsd, s.perp.fundingUsd, s.perp.unrealizedPnlUsd,
        s.exposure.eth, s.exposure.usd, s.costs.lpFeesUsdc, s.costs.perpFeesUsdc, s.costs.fundingUsdc,
        s.costs.forkValueChangeUsdc, s.costs.perpUnrealizedUsdc, s.costs.valueChangeUsdc].every(decimal) ||
      !Array.isArray(s.intents) || !Array.isArray(s.actions) ||
      !(s.proposal === null || (s.proposal && [500, 3000].includes(s.proposal.poolFee) && ['open', 'wait'].includes(s.proposal.recommendation) && Array.isArray(s.proposal.reasons) && Array.isArray(s.proposal.risks)))) {
    throw new Error('Agent returned an invalid live strategy status.');
  }
  return s;
}
