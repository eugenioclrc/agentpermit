// Actual Uniswap contract calls on a disposable fork. No Hyperliquid orders or ENS writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseAbi } from 'viem';
import { atomicWrite } from '../server/engine.ts';
import { UNISWAP, UniswapFork } from '../server/uniswap.ts';
import type { StrategyProposal } from '../shared/strategy.ts';

const block = process.argv[2] || process.env.FORK_BLOCK_NUMBER;
if (!block || !/^\d+$/.test(block) || !process.env.ETHEREUM_RPC_URL) throw new Error('Configure ETHEREUM_RPC_URL and pass a fixed Ethereum block: npm run check:fork -- <block>.');
const env: NodeJS.ProcessEnv = { ...process.env, FORK_BLOCK_NUMBER: block, ANVIL_RPC_URL: 'http://127.0.0.1:18545',
  ANVIL_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' };
Object.assign(process.env, env);
const child = spawn('anvil', ['--fork-url', env.ETHEREUM_RPC_URL!, '--fork-block-number', block, '--chain-id', '31337', '--host', '127.0.0.1', '--port', '18545', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
let failed = false;
child.on('error', () => { failed = true; });
child.stderr.on('data', () => {}); // RPC URLs may contain credentials; never echo Anvil stderr.
const transactions: { hash: string; operation: string; status: string }[] = [];
const uni = new UniswapFork((hash, operation, status) => transactions.push({ hash, operation, status }));
const results = [];
try {
  for (let i = 0; ; i++) {
    if (failed || child.exitCode !== null) throw new Error('Isolated Anvil failed to start. Check archive RPC and availability of port 18545.');
    try { await uni.publicClient.getChainId(); break; } catch { if (i >= 40) throw new Error('Isolated fork did not become ready.'); await delay(250); }
  }
  await uni.blockNumber();
  const funding = spawn(process.execPath, [resolve('scripts/fund-fork.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  funding.stdout.on('data', () => {}); funding.stderr.on('data', () => {});
  if ((await once(funding, 'exit'))[0] !== 0) throw new Error('Isolated fork funding failed. Verify FORK_USDC_DONOR balance at the chosen block.');
  console.log(`Isolated Anvil ready at Ethereum block ${block}; opening and closing both fee tiers.`);
  const state = JSON.parse(readFileSync('data/strategy-state.json', 'utf8')) as { proposal: StrategyProposal };
  if (!state.proposal) throw new Error('Generate one real proposal before checking the fork.');
  // Replay the same starting balances independently for both official pools.
  for (const poolFee of [500, 3000] as const) {
    const checkpoint = await uni.publicClient.request({ method: 'evm_snapshot' } as never);
    try {
      const opened = await uni.open({ ...state.proposal, poolFee });
      assert.ok(BigInt(opened.liquidity) > 0n);
      assert.ok(Number(opened.weth) + Number(opened.freeWeth) > 0);
      const closed = await uni.close(opened.tokenId);
      const remainingWeth = await uni.publicClient.readContract({ address: UNISWAP.weth, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [uni.account.address] });
      assert.equal(remainingWeth, 0n);
      assert.ok(Number(closed.usdcReceived) > Number(opened.initialValueUsdc) * .95);
      await assert.rejects(() => uni.publicClient.readContract({ address: UNISWAP.positionManager, abi: parseAbi(['function ownerOf(uint256) view returns (address)']), functionName: 'ownerOf', args: [BigInt(opened.tokenId)] }));
      results.push({ poolFee, opened, closed, remainingWeth: '0' });
      console.log(`PASS ${poolFee}: NFT ${opened.tokenId}, mint ${opened.hash}, close ${closed.hash}, WETH residue 0.`);
    } finally { await uni.publicClient.request({ method: 'evm_revert', params: [checkpoint] } as never); }
  }
  const forkBlock = await uni.publicClient.getBlock({ blockNumber: BigInt(block) });
  atomicWrite(resolve('data/evidence/uniswap-fork-check.json'), { kind: 'isolated-anvil-contract-verification', checkedAt: new Date().toISOString(), chainId: 31337, forkBlock: Number(block), forkBlockHash: forkBlock.hash, contracts: UNISWAP, results, transactions,
    limitation: 'Real contract execution on a disposable local fork, reverted after each pool. These hashes are local, not Ethereum mainnet or Hyperliquid transactions.' });
} finally {
  if (child.pid && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
}
