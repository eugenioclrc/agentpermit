import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import type { PoolMetrics, StrategyProposal } from '../shared/strategy.ts';
import { atomicWrite } from './engine.ts';

const SUBGRAPH_ID = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
const POOLS = [
  '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', // USDC/WETH 0.05%
  '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', // USDC/WETH 0.3%
] as const;
const QUERY = `query StrategyPools($ids: [ID!]!, $start: Int!, $end: Int!) {
  _meta { block { number timestamp } hasIndexingErrors }
  pools(where: { id_in: $ids }) {
    id feeTier liquidity totalValueLockedUSD
    token0 { id symbol decimals }
    token1 { id symbol decimals }
    poolDayData(first: 7, orderBy: date, orderDirection: asc, where: { date_gte: $start, date_lt: $end }) {
      date tvlUSD volumeUSD feesUSD token0Price token1Price
    }
  }
}`;

type GraphResponse = { data?: { _meta?: { block?: { number?: number; timestamp?: number }; hasIndexingErrors?: boolean }; pools?: {
  id: string; feeTier: string; liquidity: string; totalValueLockedUSD: string;
  token0: { id: string; symbol: string; decimals: string }; token1: { id: string; symbol: string; decimals: string };
  poolDayData: { date: number; tvlUSD: string; volumeUSD: string; feesUSD: string; token0Price: string; token1Price: string }[];
}[] }; errors?: { message?: string }[] };

const clean = (n: number, decimals = 2) => n.toFixed(decimals).replace(/\.?0+$/, '');
const finite = (value: string, label: string) => {
  const n = Number(value);
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(n)) throw new Error(`Market data returned invalid ${label}.`);
  return n;
};

export function validateGraphSnapshot(raw: GraphResponse, now: number) {
  if (raw.errors?.length) throw new Error('The Graph query failed; pool comparison is incomplete.');
  const meta = raw.data?._meta, block = meta?.block?.number, timestamp = meta?.block?.timestamp;
  if (!Number.isSafeInteger(block) || Number(block) <= 0 || !Number.isSafeInteger(timestamp) ||
      now - Number(timestamp) * 1000 > 900_000 || Number(timestamp) * 1000 > now + 30_000 || meta?.hasIndexingErrors !== false) {
    throw new Error('The Graph indexed block is missing, stale, or has indexing errors.');
  }
  const end = Math.floor(now / 86_400_000) * 86_400;
  const pools: PoolMetrics[] = (raw.data?.pools ?? []).map(pool => {
    const fee = Number(pool.feeTier);
    if ((fee !== 500 && fee !== 3000) || pool.id.toLowerCase() !== POOLS[fee === 500 ? 0 : 1] ||
        pool.token0.id.toLowerCase() !== '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' || pool.token0.decimals !== '6' ||
        pool.token1.id.toLowerCase() !== '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' || pool.token1.decimals !== '18' ||
        pool.token0.symbol !== 'USDC' || pool.token1.symbol !== 'WETH' || pool.poolDayData.length !== 7 ||
        !/^\d+$/.test(pool.liquidity) || BigInt(pool.liquidity) <= 0n || finite(pool.totalValueLockedUSD, 'TVL') <= 0) {
      throw new Error('The Graph did not return both expected USDC/WETH pools with valid liquidity and token identities.');
    }
    const days = pool.poolDayData.map((day, index) => {
      if (day.date !== end - (7 - index) * 86_400 || finite(day.tvlUSD, 'daily TVL') <= 0 ||
          finite(day.volumeUSD, 'daily volume') < 0 || finite(day.feesUSD, 'daily fees') < 0 ||
          finite(day.token0Price, 'daily token0 price') <= 0 || finite(day.token1Price, 'daily token1 price') <= 0) {
        throw new Error('The Graph must supply seven consecutive complete UTC days with valid metrics.');
      }
      return { date: day.date, tvlUsd: day.tvlUSD, volumeUsd: day.volumeUSD, feesUsd: day.feesUSD,
        token0Price: day.token0Price, token1Price: day.token1Price };
    });
    return { pool: pool.id.toLowerCase() as `0x${string}`, fee, liquidity: pool.liquidity,
      tvlUsd: pool.totalValueLockedUSD,
      sevenDayVolumeUsd: clean(days.reduce((sum, d) => sum + finite(d.volumeUsd, 'volume'), 0)),
      sevenDayFeesUsd: clean(days.reduce((sum, d) => sum + finite(d.feesUsd, 'fees'), 0)), days };
  });
  if (pools.length !== 2 || new Set(pools.map(p => p.fee)).size !== 2) throw new Error('The Graph pool comparison is incomplete.');
  return { block: block as number, queriedAt: now, pools };
}

async function graphSnapshot(now: number) {
  const key = process.env.THE_GRAPH_API_KEY;
  if (!key) throw new Error('THE_GRAPH_API_KEY is required; no synthetic pool data will be used.');
  const end = Math.floor(now / 86_400_000) * 86_400;
  const variables = { ids: [...POOLS], start: end - 7 * 86_400, end };
  const endpoint = `https://gateway.thegraph.com/api/subgraphs/id/${process.env.THE_GRAPH_SUBGRAPH_ID || SUBGRAPH_ID}`;
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(12_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  if (!response.ok) throw new Error(`The Graph HTTP ${response.status}.`);
  const raw = await response.json() as GraphResponse;
  return { ...validateGraphSnapshot(raw, now), evidence: { endpoint, query: QUERY, variables, response: raw } };
}

async function hyperliquidSnapshot(now: number) {
  const info = new InfoClient({ transport: new HttpTransport({ timeout: 10_000 }) });
  const [metaAndCtx, book] = await Promise.all([info.metaAndAssetCtxs(), info.l2Book({ coin: 'ETH' })]);
  const [meta, contexts] = metaAndCtx;
  const asset = meta.universe.findIndex(item => item.name === 'ETH');
  const ctx = contexts[asset];
  if (asset < 0 || !ctx || !book || book.coin !== 'ETH' || Math.abs(now - book.time) > 30_000) throw new Error('Hyperliquid mainnet ETH data is missing or stale.');
  const mark = finite(ctx.markPx, 'Hyperliquid mark price');
  if (mark <= 0 || finite(ctx.openInterest, 'open interest') < 0) throw new Error('Invalid Hyperliquid mainnet context.');
  finite(ctx.funding, 'funding');
  const depth = (levels: typeof book.levels[number]) => clean(levels.filter(level => Math.abs(Number(level.px) / mark - 1) <= .005)
    .reduce((sum, level) => sum + finite(level.px, 'book price') * finite(level.sz, 'book size'), 0));
  return {
    value: { markPrice: ctx.markPx, fundingRate: ctx.funding, openInterestEth: ctx.openInterest,
      bidDepthUsd: depth(book.levels[0]), askDepthUsd: depth(book.levels[1]), timestamp: book.time },
    evidence: { meta: meta.universe[asset], context: ctx, book },
  };
}

const schema = (evidenceIds: string[]) => ({
  type: 'object', additionalProperties: false,
  properties: {
    poolFee: { type: 'integer', enum: [500, 3000] },
    recommendation: { type: 'string', enum: ['open', 'wait'] },
    reasons: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', minLength: 8, maxLength: 240 },
        evidenceIds: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: evidenceIds } } },
      required: ['text', 'evidenceIds'] } },
    risks: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', minLength: 8, maxLength: 240 } },
  }, required: ['poolFee', 'recommendation', 'reasons', 'risks'],
} as const);

export function normalizeEvidenceIds(value: unknown, allowed: Set<string>): string[] | null {
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) return null;
  const ids = [...new Set(value as string[])];
  return ids.length >= 2 && ids.length <= 10 && ids.every(id => allowed.has(id)) ? ids : null;
}

export function validateDecision(value: unknown, allowed: Set<string>): Pick<StrategyProposal, 'poolFee' | 'recommendation' | 'reasons' | 'evidenceIds' | 'risks'> {
  const model = value as { poolFee?: unknown; recommendation?: unknown; reasons?: unknown; evidenceIds?: unknown; risks?: unknown } | null;
  const shortText = (value: unknown): value is string => typeof value === 'string' && value.trim().length >= 8 && value.length <= 240;
  if (!model || (model.poolFee !== 500 && model.poolFee !== 3000) || (model.recommendation !== 'open' && model.recommendation !== 'wait') ||
      !Array.isArray(model.reasons) || model.reasons.length < 2 || model.reasons.length > 4 ||
      !Array.isArray(model.risks) || model.risks.length < 2 || model.risks.length > 4 || !model.risks.every(shortText)) {
    throw new Error('OpenAI structured output failed server validation.');
  }
  const cited = new Set<string>();
  const reasons = model.reasons.map((reason: { text?: unknown; evidenceIds?: unknown } | null) => {
    if (!reason || !shortText(reason.text) || !Array.isArray(reason.evidenceIds) || reason.evidenceIds.length < 1 || reason.evidenceIds.length > 4 ||
        !reason.evidenceIds.every(id => typeof id === 'string' && allowed.has(id))) throw new Error('OpenAI reason has missing or invalid metric citations.');
    for (const id of reason.evidenceIds as string[]) cited.add(id);
    return `${reason.text} [${[...new Set(reason.evidenceIds)].join(', ')}]`;
  });
  const evidenceIds = normalizeEvidenceIds([...cited], allowed);
  if (!evidenceIds || !evidenceIds.some(id => id.startsWith('pool_500_')) || !evidenceIds.some(id => id.startsWith('pool_3000_'))) {
    throw new Error('OpenAI must justify the comparison with cited metrics from both pools.');
  }
  return { poolFee: model.poolFee, recommendation: model.recommendation, reasons, evidenceIds, risks: model.risks };
}

function outputText(response: { output?: { content?: { type?: string; text?: string }[] }[] }) {
  return response.output?.flatMap(item => item.content ?? []).find(item => item.type === 'output_text')?.text;
}

export async function proposeStrategy(name: string, goal: unknown, budget: unknown, now = Date.now()): Promise<StrategyProposal> {
  if (typeof goal !== 'string' || goal.trim().length < 10 || goal.length > 500) throw new Error('Goal must contain 10–500 characters.');
  if (budget !== 500) throw new Error('This MVP executes one fixed 500 USDC test budget (300 LP + 200 reserve).');
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required; no synthetic recommendation will be used.');
  const [graph, hyperliquid] = await Promise.all([graphSnapshot(now), hyperliquidSnapshot(now)]);
  const metrics: Record<string, string> = {};
  for (const pool of graph.pools) {
    metrics[`pool_${pool.fee}_tvl_usd`] = pool.tvlUsd;
    metrics[`pool_${pool.fee}_volume_7d_usd`] = pool.sevenDayVolumeUsd;
    metrics[`pool_${pool.fee}_fees_7d_usd`] = pool.sevenDayFeesUsd;
  }
  Object.assign(metrics, {
    hl_mark_usd: hyperliquid.value.markPrice, hl_funding_rate: hyperliquid.value.fundingRate,
    hl_bid_depth_0_5pct_usd: hyperliquid.value.bidDepthUsd, hl_ask_depth_0_5pct_usd: hyperliquid.value.askDepthUsd,
  });
  const request = {
    model: 'gpt-5-nano', store: false,
    instructions: 'Write each reason and risk as ONE complete short sentence, fewer than 180 characters; do not repeat metric IDs in the text. Compare only the supplied USDC/WETH 0.05% and 0.3% pools to choose where to provide LP liquidity, NOT where to send the hedge order. Every reason must cite its metric IDs; collectively cite both pools. Fees and TVL are historical pool references, never expected user yield; higher TVL/volume does not prove active-range depth or our LP fill opportunities. Recommend wait when evidence is insufficient. pool_* metrics belong to Uniswap mainnet pools. hl_* metrics belong to the separate ETH perpetual market on Hyperliquid mainnet and apply equally to either pool: NEVER describe hl_* depth as Uniswap pool depth, or imply that LP range improves perp execution. Positive funding is paid by longs to shorts; do not call funding favorable or cheap without a supplied comparison. Mainnet analysis does not predict testnet fills or funding. Do not claim guaranteed neutrality, profit, execution, or an APR from fees/TVL.',
    input: JSON.stringify({ goal: goal.trim(), budgetUsdc: budget, fixedExecution: { lpUsdc: 300, perpReserveUsdc: 200, rangePercent: 20, leverage: 1 }, metrics }),
    text: { format: { type: 'json_schema', name: 'agentpermit_strategy', strict: true, schema: schema(Object.keys(metrics)) } },
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', signal: AbortSignal.timeout(45_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(request),
  });
  const raw = await response.json() as { status?: string; error?: { message?: string }; output?: { content?: { type?: string; text?: string }[] }[] };
  if (!response.ok || raw.status !== 'completed') throw new Error(`OpenAI: ${raw.error?.message || `HTTP ${response.status}`}`);
  const text = outputText(raw);
  if (!text) throw new Error('OpenAI returned no structured proposal.');
  const model = validateDecision(JSON.parse(text), new Set(Object.keys(metrics)));
  const id = randomUUID();
  const proposal: StrategyProposal = {
    id, createdAt: now, goal: goal.trim(), budgetUsdc: String(budget), recommendation: model.recommendation,
    poolFee: model.poolFee, reasons: model.reasons, evidenceIds: model.evidenceIds, risks: model.risks,
    allocation: { lpUsdc: '300', perpReserveUsdc: '200' }, rangePercent: 20, leverage: 1,
    graph: { block: graph.block, queriedAt: graph.queriedAt, pools: graph.pools }, hyperliquid: hyperliquid.value, model: 'gpt-5-nano',
  };
  atomicWrite(resolve(`data/evidence/proposal-${id}.json`), {
    createdAt: now, name, proposal, theGraph: graph.evidence, hyperliquid: hyperliquid.evidence,
    openai: { request, response: raw },
  });
  return proposal;
}
