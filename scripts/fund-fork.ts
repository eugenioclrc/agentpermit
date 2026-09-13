import { createPublicClient, createTestClient, createWalletClient, defineChain, http, parseAbi, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { UNISWAP, UniswapFork } from '../server/uniswap.ts';

const rpc = process.env.ANVIL_RPC_URL || 'http://127.0.0.1:8545';
const key = process.env.ANVIL_PRIVATE_KEY;
const donor = process.env.FORK_USDC_DONOR;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set ANVIL_PRIVATE_KEY in .env.');
if (!donor || !/^0x[0-9a-fA-F]{40}$/.test(donor)) throw new Error('Set FORK_USDC_DONOR to a funded mainnet USDC holder.');
const chain = defineChain({ id: 31337, name: 'Anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = privateKeyToAccount(key as `0x${string}`);
const client = createPublicClient({ chain, transport: http(rpc) });
const testClient = createTestClient({ chain, mode: 'anvil', transport: http(rpc) });
const wallet = createWalletClient({ account, chain, transport: http(rpc) });
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const poolAbi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)']);
const wethAbi = parseAbi(['function deposit() payable']);
if (await client.getChainId() !== 31337) throw new Error('fund:fork only accepts Anvil chain 31337.');
await new UniswapFork().blockNumber();
const [usdc, weth] = await Promise.all([
  client.readContract({ address: UNISWAP.usdc, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
  client.readContract({ address: UNISWAP.weth, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
]);
if (usdc || weth) throw new Error('Strategy account is not empty. Restart the fixed fork before funding a new trial.');
await testClient.impersonateAccount({ address: donor as Address });
await testClient.setBalance({ address: donor as Address, value: 100n * 10n ** 18n });
const donorWallet = createWalletClient({ account: donor as Address, chain, transport: http(rpc) });
try {
  const transfer = await donorWallet.writeContract({ address: UNISWAP.usdc, abi: erc20, functionName: 'transfer', args: [account.address, parseUnits('150', 6)] });
  if ((await client.waitForTransactionReceipt({ hash: transfer })).status !== 'success') throw new Error('Fork USDC funding reverted.');
} finally { await testClient.stopImpersonatingAccount({ address: donor as Address }); }
const pool = await client.readContract({ address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', abi: poolAbi, functionName: 'slot0' });
const wethFor150Usdc = parseUnits('150', 6) * pool[0] * pool[0] / 2n ** 192n;
const wrap = await wallet.writeContract({ address: UNISWAP.weth, abi: wethAbi, functionName: 'deposit', value: wethFor150Usdc });
if ((await client.waitForTransactionReceipt({ hash: wrap })).status !== 'success') throw new Error('Fork WETH funding reverted.');
console.log(`Funded isolated fork account ${account.address} with 150 USDC and ~150 USDC of WETH. The other 200 USDC must be in Hyperliquid testnet Perps.`);
