import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWalletClient, http, namehash, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { agentName, DEFAULT_RPC, ENDPOINT_KEY, errorText, permissionReport, resolveAgent, resolverAbi, resolverForWrite, rpcClient } from '../shared/ens.ts';
import { endpoints } from '../shared/status.ts';
import { Engine } from './engine.ts';
import { apiServer } from './http.ts';
import { reconcile, rotate, type MigrationChain } from './migration.ts';
import { StrategyService } from './strategy.ts';

const name = agentName(process.env.AGENT_NAME || 'delta.your-team.eth');
const key = process.env.AGENT_PRIVATE_KEY;
if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('AGENT_PRIVATE_KEY must be a 32-byte hex key in .env.');
const account = key ? privateKeyToAccount(key as Hash) : null;
const client = rpcClient(process.env.SEPOLIA_RPC_URL);
const wallet = account ? createWalletClient({ account, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL || DEFAULT_RPC) }) : null;
const engine = new Engine(resolve('data/state.json'), name, Number(process.env.FEE_BPS ?? 5), Number(process.env.SLIPPAGE_BPS ?? 10));
const strategy = new StrategyService(resolve('data/strategy-state.json'), name);
const server = apiServer(() => engine, account?.address ?? null, strategy, randomBytes(32).toString('hex'));
// The fixed loopback port keeps the two ledgers single-writer.
await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(4318, '127.0.0.1', ready); });

const chain: MigrationChain = {
  endpoint: async () => (await resolveAgent(client, name)).endpoint,
  write: async endpoint => {
    if (!wallet || !account) throw new Error('No operator key. Run npm run keygen, fund its address on Sepolia, then grant its endpoint role.');
    const resolver = await resolverForWrite(client, name);
    const { request } = await client.simulateContract({ address: resolver, abi: resolverAbi, functionName: 'setText', args: [namehash(name), ENDPOINT_KEY, endpoint], account });
    if (await wallet.getChainId() !== sepolia.id) throw new Error('Operator RPC is not Sepolia.');
    const hash = await wallet.writeContract(request);
    console.log(`Submitted endpoint transaction: https://sepolia.etherscan.io/tx/${hash}\nWaiting for a mined receipt…`);
    return hash;
  },
  receipt: async hash => (await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 })).status,
};

async function pollPrice() {
  try {
    const response = await fetch('https://api.exchange.coinbase.com/products/ETH-USD/ticker', { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Coinbase HTTP ${response.status}`);
    const quote = await response.json() as { price?: unknown; time?: unknown };
    engine.quote(quote.price, typeof quote.time === 'string' ? Date.parse(quote.time) : NaN);
    const count = engine.state.history.length;
    engine.action('hedge');
    if (engine.state.history.length > count) console.log('\nRule executed: hedge restored to delta 0 ETH.');
  } catch (error) {
    engine.feedError = errorText(error);
    console.log(`\nPrice feed: ${engine.feedError}`);
  }
}
const help = `
AgentPermit — PAPER SIMULATION • ENS on Sepolia
Read-only API: ${endpoints.v1}
Identity: ${name}
Operator: ${account?.address ?? 'not configured (npm run keygen)'}

open          Open +0.1 spot / -0.1 synthetic short
partial       Open +0.1 / -0.08; next fresh quote triggers hedge
hedge         Apply delta rule now (fresh price required)
close         Close both paper positions
status        Print current metrics
check         Simulate operator permissions on Sepolia (no transactions)
migrate v2    Publish prepared v2 endpoint with the operator key
migrate v1    Rotate back to v1
reconcile     Recover a pending rotation from ENS
help          Show commands
exit          Stop (state persists)
`;
console.log(help);
if (engine.state.pending) {
  console.log('Pending rotation recovered; both endpoints available. Resolving ENS…');
  try { console.log(await reconcile(engine, chain)); } catch (error) { console.log(errorText(error)); }
}
await pollPrice();
if (['opening', 'closing', 'recovering'].includes(strategy.state.phase) || strategy.state.intents.some(i => ['prepared', 'submitted', 'unknown'].includes(i.status))) {
  try { await strategy.recover(); } catch (error) { console.log(`Strategy recovery: ${errorText(error)}`); }
}
let polling = false;
const timer = setInterval(async () => {
  if (polling) return; polling = true;
  try { await Promise.all([pollPrice(), strategy.monitor().catch(error => console.log(`\nStrategy monitor: ${errorText(error)}`))]); }
  finally { polling = false; }
}, 10_000);
const cli = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
cli.setPrompt('agentpermit> ');
cli.prompt();
let commands = Promise.resolve();
cli.on('line', line => {
  commands = commands.then(async () => {
    const command = line.trim();
    try {
      if (['open', 'partial', 'hedge', 'close'].includes(command)) { engine.action(command as 'open' | 'partial' | 'hedge' | 'close'); console.log(JSON.stringify(engine.status(), null, 2)); }
      else if (command === 'status') console.log(JSON.stringify(engine.status(), null, 2));
      else if (command === 'check') {
        if (!account) throw new Error('Configure an operator with npm run keygen first.');
        console.table(await permissionReport(client, name, account.address));
      } else if (command === 'migrate v1' || command === 'migrate v2') {
        if (!wallet) throw new Error('Configure an operator with npm run keygen first.');
        console.log(await rotate(engine, command.endsWith('v1') ? 'v1' : 'v2', chain));
      } else if (command === 'reconcile') console.log(await reconcile(engine, chain));
      else if (command === 'help') console.log(help);
      else if (command === 'exit') { cli.close(); return; }
      else if (command) console.log('Unknown command. Type help.');
    } catch (error) { console.log(errorText(error)); }
    cli.prompt();
  });
});
function shutdown() { clearInterval(timer); server.close(); process.exitCode = 0; }
cli.on('close', shutdown);
process.once('SIGINT', () => { cli.close(); shutdown(); });
process.once('SIGTERM', () => { cli.close(); shutdown(); });
