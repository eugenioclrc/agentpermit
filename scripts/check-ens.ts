import { privateKeyToAccount } from 'viem/accounts';
import type { Hash } from 'viem';
import { address, errorText, permissionReport, resolveAgent, rpcClient, verifyNetwork } from '../shared/ens.ts';

try {
  const client = rpcClient(process.env.SEPOLIA_RPC_URL);
  await verifyNetwork(client);
  console.log('PASS: Sepolia chain ID and bytecode at all pinned ENSv2 addresses.');
  const name = process.env.AGENT_NAME;
  if (!name || name.includes('your-team')) throw new Error('Set AGENT_NAME to your registered subname to complete the live checks.');
  console.log(await resolveAgent(client, name));
  const operator = process.env.OPERATOR_ADDRESS ? address(process.env.OPERATOR_ADDRESS) : process.env.AGENT_PRIVATE_KEY ? privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hash).address : null;
  if (!operator) throw new Error('Set OPERATOR_ADDRESS or run npm run keygen to check actual permissions.');
  const report = await permissionReport(client, name, operator);
  console.table(report);
  const expected = process.argv.includes('--revoked') ? false : true;
  if (report.some(r => r.allowed !== (r.key === 'endpoint' ? expected : false))) throw new Error('Unexpected or inconclusive access. Inspect the report; RPC errors are not permission denials.');
  console.log(`PASS: endpoint ${expected ? 'allowed' : 'denied'}; protected operations denied. All checks above are eth_call simulations, not mined transactions.`);
} catch (error) { console.error(errorText(error)); process.exitCode = 1; }
