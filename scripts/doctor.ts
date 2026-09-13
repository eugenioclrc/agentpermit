// Read-only readiness for a fresh trial. No wallet client, exchange action, or model request.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { createPublicClient, formatUnits, http, parseAbi, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { atomicWrite } from '../server/engine.ts';
import { UNISWAP } from '../server/uniswap.ts';
import { address, agentName, DEFAULT_RPC, permissionReport, resolveAgent, verifyNetwork } from '../shared/ens.ts';
import { allowedEndpoint } from '../shared/status.ts';

const validUrl = (value: string | undefined, local = false) => {
  try {
    const url = new URL(value ?? '');
    return local ? url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash
      : ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
};
function keyAddress(value: string | undefined): Address | null {
  try { return value && /^0x[\da-f]{64}$/i.test(value) ? privateKeyToAccount(value as Hash).address : null; } catch { return null; }
}
function publicRemote(value: string) {
  const match = /^(?:https:\/\/|git@)(github\.com|gitlab\.com)[/:]([\w.-]+(?:\/[\w.-]+)+)\/?$/.exec(value.replace(/\.git\/?$/, ''));
  if (!match || match[2]!.split('/').some(part => part === '.' || part === '..')) return null;
  return { host: match[1]!, repo: match[2]!, url: `https://${match[1]}/${match[2]}` };
}

if (process.argv.includes('--self-test')) {
  assert.equal(validUrl('http://127.0.0.1:8545', true), true);
  for (const url of ['https://127.0.0.1', 'http://127.0.0.1.example.com', 'http://user:secret@localhost', 'http://localhost?key=secret']) assert.equal(validUrl(url, true), false);
  assert.equal(keyAddress(`0x${'0'.repeat(64)}`), null);
  assert.equal(publicRemote('git@github.com:team/demo.git')?.url, 'https://github.com/team/demo');
  assert.equal(publicRemote('https://token@github.com/team/demo.git'), null);
  assert.equal(publicRemote('https://github.com/../demo.git'), null);
  console.log('PASS doctor self-check: local boundary, key validation, and credential-free repository parsing.');
} else {
  const checks: { id: string; status: 'pass' | 'fail'; detail: string; remedy?: string }[] = [];
  const record = (id: string, ok: boolean, detail: string, remedy?: string) => {
    checks.push({ id, status: ok ? 'pass' : 'fail', detail, ...(!ok && remedy ? { remedy } : {}) });
  };
  const attempt = async (id: string, remedy: string, work: () => Promise<void>) => {
    try { await work(); } catch { record(id, false, 'Read failed or returned incomplete data; provider error text is withheld.', remedy); }
  };
  const env = process.env;
  const accounts = Object.fromEntries(['ANVIL_PRIVATE_KEY', 'HYPERLIQUID_API_PRIVATE_KEY', 'AGENT_PRIVATE_KEY'].map(key => [key, keyAddress(env[key])])) as Record<string, Address | null>;
  for (const key of ['OPENAI_API_KEY', 'THE_GRAPH_API_KEY']) record(`env.${key}`, Boolean(env[key]?.trim()), 'Presence only; no paid request or credential verification.', `Set ${key} server-side in .env.`);
  for (const [key, value] of Object.entries(accounts)) record(`env.${key}`, Boolean(value), value ? `Valid private key; public address ${value}.` : 'Missing or invalid private key.', key === 'AGENT_PRIVATE_KEY' ? 'Run npm run keygen for a separate Sepolia operator.' : `Set ${key} in .env; use separate keys for each environment.`);
  const distinct = Object.values(accounts).filter((value): value is Address => value !== null).map(value => value.toLowerCase());
  record('keys.separate', new Set(distinct).size === distinct.length, 'Compared derived public addresses across the three execution keys.', 'Generate a separate Hyperliquid API wallet and Sepolia operator; never reuse the public Anvil key.');
  const exposed = Object.keys(env).filter(key => /^VITE_.*(?:PRIVATE_KEY|API_KEY|SECRET|TOKEN|PASSWORD)/i.test(key) && env[key]);
  record('env.browserSecrets', exposed.length === 0, exposed.length ? `Unsafe public variable names: ${exposed.join(', ')}.` : 'No secret-named VITE_ variables are set.', 'Remove the VITE_ secret variables; browser environment values are public.');
  const archive = env.ETHEREUM_RPC_URL;
  const local = env.ANVIL_RPC_URL || 'http://127.0.0.1:8545';
  const sepRpc = env.SEPOLIA_RPC_URL || DEFAULT_RPC;
  for (const [key, value] of [['ETHEREUM_RPC_URL', archive], ['ANVIL_RPC_URL', local], ['SEPOLIA_RPC_URL', sepRpc], ['VITE_SEPOLIA_RPC_URL', env.VITE_SEPOLIA_RPC_URL || DEFAULT_RPC]] as const) record(`env.${key}`, validUrl(value, key === 'ANVIL_RPC_URL'), 'URL format checked; endpoint values are not recorded.', `Set ${key} to ${key === 'ANVIL_RPC_URL' ? 'a loopback HTTP Anvil endpoint' : 'an HTTP(S) RPC endpoint'}.`);
  const block = Number(env.FORK_BLOCK_NUMBER);
  const fixedBlock = /^\d+$/.test(env.FORK_BLOCK_NUMBER ?? '') && Number.isSafeInteger(block) && block > 0;
  record('env.FORK_BLOCK_NUMBER', fixedBlock, fixedBlock ? `Configured Ethereum block ${block}.` : 'Missing or invalid fixed block.', 'Select an archive-readable Ethereum block with all required Uniswap V3 contracts; rerun doctor before changing a running fork.');
  let master: Address | null = null, donor: Address | null = null, name: string | null = null;
  try { master = address(env.HYPERLIQUID_ACCOUNT_ADDRESS ?? ''); } catch {}
  try { donor = address(env.FORK_USDC_DONOR ?? ''); } catch {}
  try { if (!env.AGENT_NAME?.includes('your-team')) name = agentName(env.AGENT_NAME ?? ''); } catch {}
  record('env.HYPERLIQUID_ACCOUNT_ADDRESS', Boolean(master), master ? `Master ${master}.` : 'Missing or invalid testnet master address.', 'Set the funded master account address, never the API wallet address.');
  record('env.FORK_USDC_DONOR', Boolean(donor), donor ? `Fork donor ${donor}.` : 'Missing or invalid donor.', 'Set a mainnet USDC holder with at least 150 USDC at the fixed block; impersonation is local only.');
  record('env.AGENT_NAME', Boolean(name), name ? `Registered-name candidate ${name}.` : 'A real direct Sepolia subname is required.', 'Set AGENT_NAME and VITE_AGENT_NAME to your actual delta.<team>.eth name, then configure it in /admin.');
  record('env.VITE_AGENT_NAME', Boolean(name) && env.VITE_AGENT_NAME === name, 'Browser and server names must match.', 'Set VITE_AGENT_NAME to exactly the normalized AGENT_NAME and restart Vite.');
  const apiWallet = accounts.HYPERLIQUID_API_PRIVATE_KEY;
  record('hyperliquid.separateMaster', Boolean(apiWallet && master && apiWallet.toLowerCase() !== master.toLowerCase()), 'API signer must differ from its master.', 'Authorize a new API wallet on Hyperliquid testnet and keep the master private key out of .env.');
  const minimum = Number(env.HYPERLIQUID_MIN_NOTIONAL_USD || 10);
  record('env.HYPERLIQUID_MIN_NOTIONAL_USD', Number.isFinite(minimum) && minimum > 0, 'Order minimum must be finite and positive.', 'Use HYPERLIQUID_MIN_NOTIONAL_USD=10 for this demo.');
  const ratio = Number(env.REPLAY_INITIAL_HEDGE_RATIO || 1);
  record('env.replay', Number.isFinite(ratio) && ratio > 0 && ratio <= 1 && ['', '1'].includes(env.REPLAY_TIMEOUT_AFTER_SEND || ''), env.REPLAY_INITIAL_HEDGE_RATIO || env.REPLAY_TIMEOUT_AFTER_SEND ? 'Controlled replay is configured; label any recording as replay.' : 'Controlled replay is disabled.', 'Use a hedge ratio greater than 0 and at most 1, and timeout flag 1 or blank.');
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
  const requiredContracts = { ...UNISWAP, pool500: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', pool3000: '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8' } as const;
  await Promise.allSettled([
    attempt('archive.read', 'Check archive access and the fixed block. RPC credentials and URLs are never printed.', async () => {
      if (!validUrl(archive) || !fixedBlock) return;
      const client = createPublicClient({ transport: http(archive, { timeout: 6_000, retryCount: 0 }), cacheTime: 0 });
      const chainId = await client.getChainId();
      record('archive.chain', chainId === 1, `Archive chain ID ${chainId}.`, 'Use an Ethereum mainnet archive RPC.');
      if (chainId !== 1) return;
      const blockInfo = await client.getBlock({ blockNumber: BigInt(block) });
      record('archive.block', true, `Block ${block}; hash ${blockInfo.hash}; timestamp ${blockInfo.timestamp}.`);
      await Promise.all(Object.entries(requiredContracts).map(async ([key, target]) => {
        const code = await client.getCode({ address: target, blockNumber: BigInt(block) });
        record(`archive.${key}`, Boolean(code && code !== '0x'), `Bytecode ${code && code !== '0x' ? 'present' : 'absent'} at fixed block.`, 'Choose a later archive-readable block where every listed Uniswap contract and pool is deployed.');
      }));
      if (donor) {
        const balance = await client.readContract({ address: UNISWAP.usdc, abi: erc20, functionName: 'balanceOf', args: [donor], blockNumber: BigInt(block) });
        record('archive.donor', balance >= 150_000_000n, `Donor holds ${formatUnits(balance, 6)} USDC at fixed block.`, 'Choose a donor with at least 150 USDC at this same block.');
      }
    }),
    attempt('anvil.read', 'Start npm run fork after verifying the archive block. Preserve an existing fork and ledger until its open operations have been inspected.', async () => {
      if (!validUrl(local, true)) return;
      const client = createPublicClient({ transport: http(local, { timeout: 4_000, retryCount: 0 }), cacheTime: 0 });
      const [chainId, head, metadata] = await Promise.all([client.getChainId(), client.getBlockNumber(), client.request({ method: 'anvil_metadata' } as never) as Promise<{ forkedNetwork?: { forkBlockNumber?: number } }>]);
      const actual = metadata.forkedNetwork?.forkBlockNumber;
      record('anvil.network', chainId === 31337, `Actual chain ID ${chainId}; current head ${head}.`, 'Use local Anvil chain 31337.');
      record('anvil.forkBlock', fixedBlock && actual === block, `Actual fork origin ${Number.isSafeInteger(actual) ? actual : 'unavailable'}; configured ${fixedBlock ? block : 'unset'}.`, 'Align FORK_BLOCK_NUMBER and the actual running fork only after inspecting and preserving current state.');
      if (chainId !== 31337) return;
      const code = await client.getCode({ address: UNISWAP.positionManager });
      record('anvil.positionManager', Boolean(code && code !== '0x'), 'Checked actual local Position Manager bytecode.', 'The current fork predates V3 or cannot load archive state; select a verified later block.');
      const account = accounts.ANVIL_PRIVATE_KEY;
      if (!account) return;
      const [eth, usdc, weth] = await Promise.all([client.getBalance({ address: account }), ...[UNISWAP.usdc, UNISWAP.weth].map(token => client.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [account] }))]);
      record('anvil.balances', eth! > 0n && usdc! >= 150_000_000n && weth! > 0n, `Local account: ${formatUnits(eth!, 18)} ETH; ${formatUnits(usdc!, 6)} USDC; ${formatUnits(weth!, 18)} WETH. Exact mint sufficiency is checked on approval.`, 'For an empty fresh fork only, run npm run fund:fork once. For an existing trial inspect its positions; do not reset it.');
    }),
    attempt('hyperliquid.read', 'Verify access to Hyperliquid testnet info and the master address, then rerun doctor.', async () => {
      if (!master) return;
      const info = new InfoClient({ transport: new HttpTransport({ isTestnet: true, timeout: 8_000 }) });
      const [state, orders, agents, role] = await Promise.all([info.clearinghouseState({ user: master }), info.openOrders({ user: master }), info.extraAgents({ user: master }), apiWallet ? info.userRole({ user: apiWallet }) : null]);
      const value = Number(state.marginSummary.accountValue), positions = state.assetPositions.filter(item => Number(item.position.szi) !== 0);
      record('hyperliquid.collateral', Number.isFinite(value) && value >= 200, `Testnet Perps account value ${Number.isFinite(value) ? value : 'invalid'} USDC.`, 'Fund at least 200 test USDC in the master Perps balance, not Spot or the API wallet; see docs/SETUP.md.');
      record('hyperliquid.empty', orders.length === 0 && positions.length === 0, `${orders.length} open orders; ${positions.length} nonzero positions.`, 'Use a dedicated empty account for a fresh trial. Inspect existing positions/orders yourself; doctor never cancels or closes them.');
      record('hyperliquid.fresh', Number.isSafeInteger(state.time) && Date.now() - state.time <= 30_000 && state.time <= Date.now() + 5_000, 'Account data must be no more than 30 seconds old.', 'Retry when testnet account data and the local clock are current.');
      const approved = agents.find(agent => agent.address.toLowerCase() === apiWallet?.toLowerCase());
      const authorized = Boolean(apiWallet && apiWallet.toLowerCase() !== master.toLowerCase() && role?.role === 'agent' && role.data.user.toLowerCase() === master.toLowerCase() && (!approved || approved.validUntil === null || approved.validUntil > Date.now()));
      record('hyperliquid.apiWallet', authorized, 'Compared signer userRole/master mapping and listed expiry via read-only info.', 'In the testnet API screen, authorize this separate API wallet for the configured master; refresh an expired grant.');
    }),
    attempt('ens.read', 'Check Sepolia RPC access, register your real parent name, and complete /admin setup and endpoint delegation.', async () => {
      if (!validUrl(sepRpc)) return;
      const client = createPublicClient({ chain: sepolia, transport: http(sepRpc, { timeout: 5_000, retryCount: 0 }), cacheTime: 0 });
      await verifyNetwork(client);
      record('ens.infrastructure', true, 'Sepolia chain and pinned ENSv2 contract bytecode verified. This is not a user deployment receipt.');
      if (!name) return;
      const resolved = await resolveAgent(client, name);
      let endpointOk = false;
      try { allowedEndpoint(resolved.endpoint ?? ''); endpointOk = true; } catch {}
      record('ens.endpoint', endpointOk, `Name resolved at Sepolia block ${resolved.block}; endpoint ${endpointOk ? 'is allowed' : 'is missing or outside the demo allowlist'}.`, 'Save the v1 or v2 endpoint in /admin; arbitrary endpoint contents are not logged.');
      const operator = accounts.AGENT_PRIVATE_KEY;
      if (!operator) return;
      const [report, balance] = await Promise.all([permissionReport(client, name, operator), client.getBalance({ address: operator })]);
      record('ens.operatorGas', balance > 0n, `Operator holds ${formatUnits(balance, 18)} Sepolia ETH.`, 'Fund the separate ENS operator with Sepolia test ETH for endpoint updates.');
      for (const check of report) record(`ens.permission.${check.key}`, check.allowed === (check.key === 'endpoint'), `${check.key}: ${check.allowed === null ? 'inconclusive' : check.allowed ? 'allowed' : 'denied'} by eth_call; no transaction sent.`, 'Grant endpoint-only rights; protected payout/description/role/resolver/registry writes must be denied. RPC failure is inconclusive, never a denial.');
    }),
    attempt('git.public', 'Add your intended public GitHub/GitLab remote and verify anonymous access after publishing. Doctor does not create, commit, or push a repository.', async () => {
      let remotes = '';
      try { remotes = execFileSync('git', ['config', '--get-regexp', '^remote\..*\.url$'], { encoding: 'utf8', timeout: 3_000, maxBuffer: 32_768, stdio: ['ignore', 'pipe', 'pipe'] }); } catch {}
      const remote = remotes.split('\n').map(line => publicRemote(line.slice(line.indexOf(' ') + 1))).find(value => value !== null);
      record('git.remote', Boolean(remote), remote ? `Public repository candidate ${remote.url}.` : 'No credential-free GitHub/GitLab remote found.', 'Set a remote for the AgentPermit repository. Exclude heist/, .env and data/ from publication.');
      if (!remote) return;
      const api = remote.host === 'github.com' ? `https://api.github.com/repos/${remote.repo}` : `https://gitlab.com/api/v4/projects/${encodeURIComponent(remote.repo)}`;
      const response = await fetch(api, { signal: AbortSignal.timeout(6_000), redirect: 'error' });
      const body = response.ok ? await response.json() as { private?: boolean; visibility?: string } : null;
      record('git.public', Boolean(response.ok && (remote.host === 'github.com' ? body?.private === false : body?.visibility === 'public')), `Anonymous repository metadata request returned HTTP ${response.status}.`, 'Confirm repository is public; retry a rate-limited check. A remote alone does not prove publication.');
    }),
  ]);
  checks.sort((a, b) => a.id.localeCompare(b.id));
  const ready = checks.every(check => check.status === 'pass');
  try { atomicWrite(resolve('data/doctor.json'), { checkedAt: new Date().toISOString(), scope: 'Read-only readiness for a fresh local-fork + testnet trial; not execution evidence.', ready, checks }); }
  catch { record('report.write', false, 'Could not atomically write data/doctor.json.', 'Check local directory permissions.'); }
  for (const check of checks) console.log(`${check.status.toUpperCase()} ${check.id}: ${check.detail}${check.remedy ? ` Remedy: ${check.remedy}` : ''}`);
  process.exitCode = checks.some(check => check.status === 'fail') ? 1 : 0;
}
