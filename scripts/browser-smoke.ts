// Isolated UI fixtures. These checks are NOT evidence of a Sepolia deployment.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { decodeFunctionData, encodeFunctionResult, namehash, parseAbi, type Hex } from 'viem';
import { Engine } from '../server/engine.ts';
import { endpoints } from '../shared/status.ts';
import { resolverAbi } from '../shared/ens.ts';
import type { StrategyProposal, StrategyState } from '../shared/strategy.ts';

const name = 'delta.agentpermit.eth';
const resolver = '0x0000000000000000000000000000000000000011';
const payout = '0x0000000000000000000000000000000000000022';
const directory = mkdtempSync(join(tmpdir(), 'agentpermit-ui-'));
const engine = new Engine(join(directory, 'state.json'), name);
engine.quote('3000', Date.now()); engine.action('open');
const strategy: StrategyState = {
  schema: 1, mode: 'delta-neutral', name, phase: 'idle', generatedAt: Date.now(), proposal: null,
  fork: { chainId: 31337, blockNumber: null, positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', poolEnvironment: 'Ethereum mainnet fork' },
  perpEnvironment: { network: 'Hyperliquid testnet', account: null, market: 'ETH', replay: null },
  lp: { status: 'empty', pool: null, fee: null, tokenId: null, tickLower: null, tickUpper: null, liquidity: '0', usdc: '0', weth: '0', feesUsdc: '0', feesWeth: '0', freeWeth: '0', proceedsUsdc: '0', openTx: null, closeTx: null },
  perp: { status: 'flat', asset: null, szDecimals: null, sizeEth: '0', entryPrice: '0', markPrice: '0', liquidationPrice: null, marginUsd: '0', fundingUsd: '0', unrealizedPnlUsd: '0', lastOrderId: null },
  exposure: { eth: '0', usd: '0', updatedAt: null, fresh: false },
  costs: { lpFeesUsdc: '0', perpFeesUsdc: '0', fundingUsdc: '0', forkValueChangeUsdc: '0', perpUnrealizedUsdc: '0', valueChangeUsdc: '0' },
  outOfRangeSince: null, intents: [], actions: [], lastError: null,
};
const proposal: StrategyProposal = {
  id: '00000000-0000-4000-8000-000000000001', createdAt: Date.now(), goal: 'Isolated UI test, not trading evidence.', budgetUsdc: '500',
  recommendation: 'wait', poolFee: 500, reasons: ['Historical fees are not expected user yield. [pool_500_fees_7d_usd]', 'Compare the other pool. [pool_3000_fees_7d_usd]'],
  evidenceIds: ['pool_500_fees_7d_usd', 'pool_3000_fees_7d_usd'], risks: ['Funding can change sign.', 'A hedge does not guarantee profit.'],
  allocation: { lpUsdc: '300', perpReserveUsdc: '200' }, rangePercent: 20, leverage: 1, model: 'gpt-5-nano',
  graph: { block: 25965916, queriedAt: Date.now(), pools: [500, 3000].map(fee => ({ pool: fee === 500 ? '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640' : '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8', fee: fee as 500 | 3000,
    liquidity: '1000000000', tvlUsd: '1000000', sevenDayVolumeUsd: '10000000', sevenDayFeesUsd: '5000', days: [] })) },
  hyperliquid: { markPrice: '3000', fundingRate: '0.00001', openInterestEth: '10000', bidDepthUsd: '100000', askDepthUsd: '100000', timestamp: Date.now() },
};
let session = 'fixture-session', proposalFails = true, includeLive = false, statusReads = 0;
const authorizations: (string | undefined)[] = [];
let endpoint: string = endpoints.v1;
const universal = parseAbi([
  'function findResolver(bytes name) view returns (address, bytes32, uint256)',
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)',
]);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
try {
  // Only this test context receives synthetic RPC/API replies. App code has no mock mode.
  await context.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith('http://127.0.0.1:4318/')) {
      const reply = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' }, body: JSON.stringify(data) });
      if (request.method() === 'OPTIONS') return reply({});
      if (request.method() === 'POST') {
        authorizations.push(request.headers().authorization);
        if (url.endsWith('/strategy/propose')) {
          if (proposalFails) return reply({ error: 'OpenAI fixture failure: persistent until retry or dismissal.' }, 502);
          strategy.proposal = proposal; strategy.phase = 'proposed'; return reply(strategy);
        }
        if (url.endsWith('/strategy/actions')) {
          assert.equal(request.postDataJSON().action, 'approve'); assert.equal(request.postDataJSON().technicalTrial, true);
          strategy.phase = 'recovering'; strategy.lastError = 'Fixture: acknowledgement unavailable; original cloid remains unresolved.';
          strategy.lp = { ...strategy.lp, status: 'open', tokenId: '1234567', weth: '0.04', freeWeth: '0.01', feesWeth: '0.000001', liquidity: '1000000000' };
          strategy.perp.sizeEth = '-0.02'; strategy.perp.status = 'unknown';
          strategy.perp.markPrice = '3000'; strategy.perp.marginUsd = '60'; strategy.fork.blockNumber = 25965916;
          strategy.perpEnvironment.account = '0x0000000000000000000000000000000000000033';
          strategy.intents = [{ id: 'fixture-order-intent', kind: 'perp-order', status: 'unknown', createdAt: Date.now(), updatedAt: Date.now(), attempts: 1, requestedEth: '-0.05', cloid: `0x${'1'.repeat(32)}` }];
          strategy.exposure = { eth: '0.030001', usd: '90.003', updatedAt: Date.now(), fresh: false };
          return reply(strategy);
        }
        throw new Error('Unexpected UI action');
      }
      if (url.endsWith('/strategy/status')) statusReads++;
      const data = url.endsWith('/strategy/status') ? strategy : url.endsWith('/strategy/session') ? { token: session }
        : url.endsWith('/config') ? { name, operator: null, active: endpoint === endpoints.v1 ? 'v1' : 'v2', pending: null, migrations: [] }
        : { ...engine.status(url.includes('/v2/') ? 'v2' : 'v1'), ...(includeLive ? { strategy } : {}) };
      return reply(data);
    }
    if (request.method() === 'POST' && request.postData()?.includes('jsonrpc')) {
      const query = request.postDataJSON();
      let result: string;
      if (query.method === 'eth_chainId') result = '0xaa36a7';
      else if (query.method === 'eth_blockNumber') result = '0xabcdef';
      else if (query.method === 'eth_call') {
        const call = decodeFunctionData({ abi: universal, data: query.params[0].data as Hex });
        if (call.functionName === 'findResolver') result = encodeFunctionResult({ abi: universal, functionName: 'findResolver', result: [resolver, namehash(name), 0n] });
        else {
          const record = decodeFunctionData({ abi: resolverAbi, data: call.args[1] });
          const data = record.functionName === 'text' ? encodeFunctionResult({ abi: resolverAbi, functionName: 'text', result: record.args[1] === 'agentpermit.endpoint' ? endpoint : 'UI fixture — paper agent' }) : encodeFunctionResult({ abi: resolverAbi, functionName: 'addr', result: payout });
          result = encodeFunctionResult({ abi: universal, functionName: 'resolveWithGateways', result: [data, resolver] });
        }
      } else throw new Error(`Unexpected RPC in browser fixture: ${query.method}`);
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: query.id, result }) });
    }
    if (!url.startsWith('http://127.0.0.1:5173/')) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5173/strategy');
  await page.getByRole('heading', { name: 'Build the hedge, then prove it.' }).waitFor();
  assert.equal(await page.getByLabel('Test budget').inputValue(), '500 USDC');
  mkdirSync('data/screenshots', { recursive: true });
  await page.screenshot({ path: 'data/screenshots/strategy-fixture.png', fullPage: true });
  await page.getByRole('button', { name: 'Compare pools and propose' }).click();
  await page.getByRole('alert').filter({ hasText: 'OpenAI fixture failure' }).waitFor();
  const readsBefore = statusReads;
  session = 'fixture-after-restart';
  await page.waitForResponse(response => response.url().endsWith('/strategy/session'));
  assert.ok(statusReads > readsBefore, 'state polling must continue after action error');
  assert.ok(await page.getByRole('alert').filter({ hasText: 'OpenAI fixture failure' }).isVisible(), 'polling must not dismiss action errors');
  proposalFails = false;
  await page.getByRole('button', { name: 'Compare pools and propose' }).click();
  await page.getByRole('heading', { name: 'Wait on economic grounds' }).waitFor();
  assert.equal(authorizations.at(-1), 'Bearer fixture-after-restart');
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Approve and execute' }).isDisabled(), true);
  await page.getByLabel('Run an expressly approved technical trial with test funds').check();
  await page.getByRole('button', { name: 'Approve and execute' }).click();
  await page.getByRole('status').filter({ hasText: 'An order outcome is uncertain' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Close both legs' }).isDisabled(), true);
  await page.getByText('Unverified exposure · orders blocked', { exact: true }).waitFor();
  await page.getByText(/^Free WETH/).waitFor();
  await page.getByText(`0x${'1'.repeat(32)}`, { exact: true }).waitFor();
  assert.equal(await page.getByText('Combined value change', { exact: true }).count(), 0);
  const strategyDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export strategy evidence' }).click();
  assert.equal((await strategyDownload).suggestedFilename(), 'agentpermit-strategy-evidence.json');
  await page.screenshot({ path: 'data/screenshots/strategy-recovery-fixture.png', fullPage: true });
  await page.goto('http://127.0.0.1:5173/admin');
  await page.getByRole('heading', { name: 'Autonomy, with boundaries.' }).waitFor();
  await page.getByText('2 paper fills', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Set up ENS identity' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Connect admin wallet' }).click();
  await page.getByRole('alert').filter({ hasText: 'No injected wallet detected' }).waitFor();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export manifest' }).click();
  assert.equal((await download).suggestedFilename(), 'agentpermit-deployment.json');
  await page.screenshot({ path: 'data/screenshots/admin-fixture.png', fullPage: true });
  await page.getByRole('link', { name: 'Open independent client' }).click();
  await page.getByRole('heading', { name: 'A name that follows the agent.' }).waitFor();
  await page.getByLabel('Agent ENS name').fill('not-a-subname.eth');
  await page.getByRole('button', { name: 'Resolve agent' }).click();
  await page.getByRole('alert').filter({ hasText: 'Use a direct subname' }).waitFor();
  await page.getByLabel('Agent ENS name').fill(name);
  await page.getByRole('button', { name: 'Resolve agent' }).click();
  await page.getByText('Connected · v1', { exact: true }).waitFor();
  await page.getByText('2 paper fills', { exact: true }).waitFor();
  includeLive = true;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('heading', { name: 'ENS-discovered live strategy' }).waitFor();
  await page.getByText('1234567', { exact: true }).waitFor();
  endpoint = endpoints.v2;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByText('Connected · v2', { exact: true }).waitFor();
  await page.getByText('1234567', { exact: true }).waitFor();
  await page.getByText('Legacy paper simulation', { exact: true }).click();
  await page.getByText('2 paper fills', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /wallet/i }).count(), 0);
  await page.screenshot({ path: 'data/screenshots/client-fixture.png', fullPage: true });
  strategy.name = 'other.agentpermit.eth';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('alert').filter({ hasText: 'different ENS identity' }).waitFor();
  assert.equal(await page.getByText('1234567', { exact: true }).count(), 0);
  strategy.name = name;
  endpoint = 'https://untrusted.example/status';
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('alert').filter({ hasText: 'Endpoint outside this local demo' }).waitFor();
  await page.getByText('Not connected', { exact: true }).waitFor();
  for (const path of ['/strategy', '/admin', '/client']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:5173${path}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    assert.ok(dimensions.scroll <= dimensions.width, `${path} has horizontal overflow`);
    await page.screenshot({ path: `data/screenshots/${path.slice(1)}-mobile-fixture.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('PASS: desktop/mobile, persistent action errors, rotated session, wait/technical approval, uncertain exposure, separate results, evidence downloads, ENS live v1→v2 discovery, unchanged paper journal, identity mismatch and endpoint rejection. RPC/API responses were isolated test fixtures, not live execution evidence.');
} finally {
  await browser.close(); rmSync(directory, { recursive: true, force: true });
}
