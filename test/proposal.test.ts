import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvidenceIds, validateDecision, validateGraphSnapshot } from '../server/proposal.ts';

test('proposal evidence IDs must be supplied metrics and duplicates are harmless', () => {
  const allowed = new Set(['pool_500_tvl_usd', 'hl_funding_rate']);
  assert.deepEqual(normalizeEvidenceIds(['pool_500_tvl_usd', 'pool_500_tvl_usd', 'hl_funding_rate'], allowed), [...allowed]);
  assert.equal(normalizeEvidenceIds(['pool_500_tvl_usd', 'invented_metric'], allowed), null);
});

test('Graph boundary requires the exact seven UTC days, token identities and a recent healthy block', () => {
  const now = Date.UTC(2026, 8, 13, 4), end = Math.floor(now / 86_400_000) * 86_400;
  const raw = { data: { _meta: { block: { number: 25965916, timestamp: now / 1000 - 12 }, hasIndexingErrors: false },
    pools: [500, 3000].map(fee => ({ id: fee === 500 ? '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' : '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8',
      feeTier: String(fee), liquidity: '123456789', totalValueLockedUSD: '1000000',
      token0: { id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: '6' },
      token1: { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: '18' },
      poolDayData: Array.from({ length: 7 }, (_, i) => ({ date: end - (7 - i) * 86_400, tvlUSD: '1000000', volumeUSD: '10000', feesUSD: '5', token0Price: '3000', token1Price: '0.000333333333' })) })) } };
  assert.equal(validateGraphSnapshot(raw, now).pools[0].sevenDayFeesUsd, '35');
  const mutations: ((copy: typeof raw) => void)[] = [
    x => { x.data.pools[0].poolDayData[1].date = x.data.pools[0].poolDayData[0].date; },
    x => { x.data.pools[0].token0.id = x.data.pools[1].token1.id; },
    x => { x.data.pools[0].token0.decimals = '18'; },
    x => { x.data.pools[0].feeTier = '3000'; },
    x => { x.data.pools[0].poolDayData[0].feesUSD = '-1'; },
    x => { x.data.pools[0].totalValueLockedUSD = ''; },
    x => { x.data._meta.block.timestamp -= 901; },
    x => { x.data._meta.hasIndexingErrors = true; },
  ];
  for (const mutate of mutations) { const copy = structuredClone(raw); mutate(copy); assert.throws(() => validateGraphSnapshot(copy, now)); }
});

test('model reasons must cite both supplied pools and no invented or unreferenced metrics', () => {
  const ids = ['pool_500_fees_7d_usd', 'pool_3000_fees_7d_usd'];
  const value = { poolFee: 500, recommendation: 'wait', evidenceIds: ids,
    reasons: [{ text: 'Compare the historical pool fees.', evidenceIds: ids }, { text: 'Fees alone do not predict our yield.', evidenceIds: [ids[0]] }],
    risks: ['Funding can change sign.', 'Fees do not offset every loss.'] };
  assert.match(validateDecision(value, new Set(ids)).reasons[0], /pool_3000_fees_7d_usd/);
  assert.throws(() => validateDecision({ ...value, reasons: [{ text: 'Reason with an invented source.', evidenceIds: ['fake'] }, value.reasons[1]] }, new Set(ids)));
  assert.throws(() => validateDecision({ ...value, reasons: [value.reasons[1], value.reasons[1]] }, new Set(ids)));
  assert.throws(() => validateDecision({ ...value, risks: ['short'] }, new Set(ids)));
});
