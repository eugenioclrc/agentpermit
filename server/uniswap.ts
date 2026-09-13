import { createRequire } from 'node:module';
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, formatUnits, http, keccak256, maxUint128, parseAbi, parseEventLogs,
  parseUnits, type Address, type Hash, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { StrategyProposal } from '../shared/strategy.ts';

const require = createRequire(import.meta.url);
const { Token, CurrencyAmount, Percent } = require('@uniswap/sdk-core') as typeof import('@uniswap/sdk-core');
const { Pool, Position, NonfungiblePositionManager, nearestUsableTick } = require('@uniswap/v3-sdk') as typeof import('@uniswap/v3-sdk');

export const UNISWAP = {
  factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
  swapRouter: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
} as const satisfies Record<string, Address>;

const factoryAbi = parseAbi(['function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)']);
const poolAbi = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
]);
const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const managerAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns (uint256 amount0,uint256 amount1)',
  'event IncreaseLiquidity(uint256 indexed tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
]);
const routerAbi = parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)']);

export type LpSnapshot = {
  pool: Address; tokenId: string; fee: 500 | 3000; tickLower: number; tickUpper: number; tick: number;
  liquidity: string; usdc: string; weth: string; feesUsdc: string; feesWeth: string; freeWeth: string;
  freeUsdc?: string;
  inRange: boolean; priceUsd: string; timestamp: number;
};
export type LpOpenResult = LpSnapshot & { hash: Hash; initialValueUsdc?: string };

const anvil = defineChain({
  id: 31337, name: 'Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

export class UniswapFork {
  readonly account;
  readonly publicClient;
  readonly wallet;
  readonly record;
  constructor(record: (hash: Hash, operation: string, status: 'prepared' | 'confirmed' | 'reverted') => void = () => {}) {
    this.record = record;
    const key = process.env.ANVIL_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('ANVIL_PRIVATE_KEY is required for fork execution.');
    const rpc = process.env.ANVIL_RPC_URL || 'http://127.0.0.1:8545';
    const url = new URL(rpc);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Anvil RPC must be a loopback HTTP endpoint.');
    this.account = privateKeyToAccount(key as Hash);
    this.publicClient = createPublicClient({ chain: anvil, transport: http(rpc, { timeout: 10_000 }) });
    this.wallet = createWalletClient({ account: this.account, chain: anvil, transport: http(rpc, { timeout: 10_000 }) });
  }

  async blockNumber() {
    if (await this.publicClient.getChainId() !== 31337) throw new Error('Uniswap executor only accepts Anvil chain 31337.');
    const expected = Number(process.env.FORK_BLOCK_NUMBER);
    if (!Number.isSafeInteger(expected) || expected <= 0) throw new Error('FORK_BLOCK_NUMBER is required for reproducible execution.');
    const metadata = await this.publicClient.request({ method: 'anvil_metadata' } as never) as { forkedNetwork?: { forkBlockNumber?: number } };
    if (metadata.forkedNetwork?.forkBlockNumber !== expected) throw new Error('Running Anvil fork block differs from FORK_BLOCK_NUMBER. Restart the configured fork.');
    const code = await this.publicClient.getCode({ address: UNISWAP.positionManager });
    if (!code || code === '0x') throw new Error('Uniswap V3 is not deployed at this fork block. Choose a later Ethereum block and restart the fork.');
    return expected;
  }

  private async send(operation: string, to: Address, data: Hex, value = 0n) {
    const request = await this.wallet.prepareTransactionRequest({ to, data, value });
    const serializedTransaction = await this.wallet.signTransaction(request);
    const hash = keccak256(serializedTransaction);
    this.record(hash, operation, 'prepared'); // Persist the locally computed hash BEFORE broadcasting.
    await this.publicClient.sendRawTransaction({ serializedTransaction });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 45_000 });
    this.record(hash, operation, receipt.status === 'success' ? 'confirmed' : 'reverted');
    if (receipt.status !== 'success') throw new Error(`${operation} reverted: ${hash}`);
    return receipt;
  }

  private async pool(fee: 500 | 3000) {
    const address = await this.publicClient.readContract({ address: UNISWAP.factory, abi: factoryAbi, functionName: 'getPool', args: [UNISWAP.usdc, UNISWAP.weth, fee] });
    if (address === '0x0000000000000000000000000000000000000000') throw new Error(`Uniswap V3 ${fee} pool not found on the fork.`);
    const [token0, token1, actualFee, slot0, liquidity] = await Promise.all([
      this.publicClient.readContract({ address, abi: poolAbi, functionName: 'token0' }),
      this.publicClient.readContract({ address, abi: poolAbi, functionName: 'token1' }),
      this.publicClient.readContract({ address, abi: poolAbi, functionName: 'fee' }),
      this.publicClient.readContract({ address, abi: poolAbi, functionName: 'slot0' }),
      this.publicClient.readContract({ address, abi: poolAbi, functionName: 'liquidity' }),
    ]);
    if (token0.toLowerCase() !== UNISWAP.usdc.toLowerCase() || token1.toLowerCase() !== UNISWAP.weth.toLowerCase() || actualFee !== fee) {
      throw new Error('Resolved Uniswap pool tokens or fee do not match USDC/WETH.');
    }
    const USDC = new Token(1, UNISWAP.usdc, 6, 'USDC');
    const WETH = new Token(1, UNISWAP.weth, 18, 'WETH');
    return { address, slot0, liquidity, sdk: new Pool(USDC, WETH, fee, slot0[0].toString(), liquidity.toString(), slot0[1]), USDC, WETH };
  }

  private async approve(token: Address, amount: bigint) {
    const allowance = await this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [this.account.address, UNISWAP.positionManager] });
    if (allowance >= amount) return;
    await this.send('LP token approval', token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [UNISWAP.positionManager, amount] }));
  }

  private async preparePosition(proposal: StrategyProposal) {
    await this.blockNumber();
    const data = await this.pool(proposal.poolFee);
    const ethPrice = Number(data.sdk.token1Price.toSignificant(12));
    if (!Number.isFinite(ethPrice) || ethPrice <= 0) throw new Error('Fork pool returned an invalid ETH price.');
    const spacing = proposal.poolFee === 500 ? 10 : 60;
    const tickLower = nearestUsableTick(data.slot0[1] + Math.floor(Math.log(1 / 1.2) / Math.log(1.0001)), spacing);
    const tickUpper = nearestUsableTick(data.slot0[1] + Math.ceil(Math.log(1 / .8) / Math.log(1.0001)), spacing);
    const amount0 = parseUnits('150', 6), amount1 = parseUnits(cleanNumber(150 / ethPrice, 18), 18);
    const position = Position.fromAmounts({ pool: data.sdk, tickLower, tickUpper, amount0: amount0.toString(), amount1: amount1.toString(), useFullPrecision: true });
    const mint = position.mintAmounts;
    const [usdcBalance, wethBalance] = await Promise.all([
      this.publicClient.readContract({ address: UNISWAP.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] }),
      this.publicClient.readContract({ address: UNISWAP.weth, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] }),
    ]);
    if (usdcBalance < BigInt(mint.amount0.toString()) || wethBalance < BigInt(mint.amount1.toString())) {
      throw new Error('Fork strategy account lacks the USDC/WETH required for the LP. For a new trial, start a fresh fixed fork and run npm run fund:fork.');
    }
    return { position, mint, usdcBalance, wethBalance, ethPrice };
  }

  async preflight(proposal: StrategyProposal): Promise<void> { await this.preparePosition(proposal); }

  async open(proposal: StrategyProposal): Promise<LpOpenResult> {
    const { position, mint, usdcBalance, wethBalance, ethPrice } = await this.preparePosition(proposal);
    await this.approve(UNISWAP.usdc, BigInt(mint.amount0.toString()));
    await this.approve(UNISWAP.weth, BigInt(mint.amount1.toString()));
    const call = NonfungiblePositionManager.addCallParameters(position, {
      recipient: this.account.address, deadline: Math.floor(Date.now() / 1000) + 300,
      slippageTolerance: new Percent(100, 10_000),
    });
    const receipt = await this.send('LP mint', UNISWAP.positionManager, call.calldata as Hex, BigInt(call.value));
    const event = parseEventLogs({ abi: managerAbi, eventName: 'IncreaseLiquidity', logs: receipt.logs }).at(-1);
    if (!event) throw new Error('Confirmed Uniswap mint has no IncreaseLiquidity event.');
    return { ...(await this.read(event.args.tokenId.toString())), hash: receipt.transactionHash,
      initialValueUsdc: cleanNumber(Number(formatUnits(usdcBalance, 6)) + Number(formatUnits(wethBalance, 18)) * ethPrice, 6) };
  }

  async read(tokenId: string): Promise<LpSnapshot> {
    const id = BigInt(tokenId), position = await this.publicClient.readContract({ address: UNISWAP.positionManager, abi: managerAbi, functionName: 'positions', args: [id] });
    const fee = Number(position[4]);
    if (fee !== 500 && fee !== 3000) throw new Error('LP position fee is outside the MVP allowlist.');
    const data = await this.pool(fee);
    if (position[2].toLowerCase() !== UNISWAP.usdc.toLowerCase() || position[3].toLowerCase() !== UNISWAP.weth.toLowerCase()) throw new Error('LP position tokens changed.');
    const sdkPosition = new Position({ pool: data.sdk, liquidity: position[7].toString(), tickLower: position[5], tickUpper: position[6] });
    const simulated = await this.publicClient.simulateContract({
      account: this.account, address: UNISWAP.positionManager, abi: managerAbi, functionName: 'collect',
      args: [{ tokenId: id, recipient: this.account.address, amount0Max: maxUint128, amount1Max: maxUint128 }],
    });
    const freeWeth = await this.publicClient.readContract({ address: UNISWAP.weth, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] });
    const freeUsdc = await this.publicClient.readContract({ address: UNISWAP.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] });
    return {
      pool: data.address, tokenId, fee, tickLower: position[5], tickUpper: position[6], tick: data.slot0[1], liquidity: position[7].toString(),
      usdc: sdkPosition.amount0.toExact(), weth: sdkPosition.amount1.toExact(), feesUsdc: formatUnits(simulated.result[0], 6),
      feesWeth: formatUnits(simulated.result[1], 18), freeWeth: formatUnits(freeWeth, 18), freeUsdc: formatUnits(freeUsdc, 6), inRange: data.slot0[1] >= position[5] && data.slot0[1] < position[6],
      priceUsd: data.sdk.token1Price.toSignificant(12), timestamp: Date.now(),
    };
  }

  async close(tokenId: string): Promise<{ hash: Hash; sellHash: Hash | null; usdcReceived: string; feesValueUsdc: string }> {
    await this.blockNumber();
    const snapshot = await this.read(tokenId), data = await this.pool(snapshot.fee);
    const position = new Position({ pool: data.sdk, liquidity: snapshot.liquidity, tickLower: snapshot.tickLower, tickUpper: snapshot.tickUpper });
    const call = NonfungiblePositionManager.removeCallParameters(position, {
      tokenId, liquidityPercentage: new Percent(1, 1), slippageTolerance: new Percent(100, 10_000),
      deadline: Math.floor(Date.now() / 1000) + 300, burnToken: true,
      collectOptions: { expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(data.USDC, 0), expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(data.WETH, 0), recipient: this.account.address },
    });
    const receipt = await this.send('LP remove and collect', UNISWAP.positionManager, call.calldata as Hex, BigInt(call.value));
    const hash = receipt.transactionHash;
    const weth = await this.publicClient.readContract({ address: UNISWAP.weth, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] });
    let sellHash: Hash | null = null;
    if (weth > 0n) {
      const allowance = await this.publicClient.readContract({ address: UNISWAP.weth, abi: erc20Abi, functionName: 'allowance', args: [this.account.address, UNISWAP.swapRouter] });
      if (allowance < weth) {
        await this.send('WETH router approval', UNISWAP.weth, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [UNISWAP.swapRouter, weth] }));
      }
      const minOut = BigInt(Math.floor(Number(formatUnits(weth, 18)) * Number(snapshot.priceUsd) * .98 * 1e6));
      const sold = await this.send('WETH sale', UNISWAP.swapRouter, encodeFunctionData({ abi: routerAbi, functionName: 'exactInputSingle', args: [{
        tokenIn: UNISWAP.weth, tokenOut: UNISWAP.usdc, fee: snapshot.fee, recipient: this.account.address,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300), amountIn: weth, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
      }] }));
      sellHash = sold.transactionHash;
    }
    const afterUsdc = await this.publicClient.readContract({ address: UNISWAP.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [this.account.address] });
    return { hash, sellHash, usdcReceived: formatUnits(afterUsdc, 6),
      feesValueUsdc: cleanNumber(Number(snapshot.feesUsdc) + Number(snapshot.feesWeth) * Number(snapshot.priceUsd), 6) };
  }
}

function cleanNumber(value: number, decimals: number) {
  return value.toFixed(decimals).replace(/\.?0+$/, '');
}
