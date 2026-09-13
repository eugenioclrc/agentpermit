import {
  BaseError, ContractFunctionRevertedError, createPublicClient, encodeAbiParameters,
  encodeFunctionData, getAddress, http, isAddress, keccak256, namehash, parseAbi,
  parseEventLogs, stringToHex, toHex, zeroAddress,
  type Abi, type Address, type Hash, type WalletClient,
} from 'viem';
import { sepolia } from 'viem/chains';
import { normalize, packetToBytes } from 'viem/ens';
import { allowedEndpoint, endpoints } from './status.ts';

export const SOURCE_COMMIT = '97a57293f3b4279d94b571e678edb53ce62638f4';
// Signatures checked against deployment artifacts, not the evolving prose tutorial.
export const contracts = {
  factory: '0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef',
  resolverImplementation: '0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e',
  registryImplementation: '0x624a25d67b59d587752ebec8dded8827dae52050',
  ethRegistry: '0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2',
} as const;
export const ENDPOINT_KEY = 'agentpermit.endpoint';
export const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const errors = [
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)',
] as const;
export const resolverAbi = parseAbi([
  ...errors,
  'function initialize(address admin, uint256 roleBitmap, bytes[] setters)',
  'function setText(bytes32 node, string key, string value)',
  'function text(bytes32 node, string key) view returns (string)',
  'function setAddr(bytes32 node, address addr_)',
  'function addr(bytes32 node) view returns (address)',
  'function authorizeTextRoles(bytes toName, string key, address account, bool grant) returns (bool)',
  'function authorizeNameRoles(bytes toName, uint256 roleBitmap, address account, bool grant) returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function getAlias(bytes fromName) view returns (bytes)',
  'function multicall(bytes[] calls) returns (bytes[])',
]);
export const registryAbi = parseAbi([
  ...errors,
  'function initialize(address rootAccount, uint256 roleBitmap)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource) state)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256 tokenId)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
]);
export const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)',
  'function verifyContract(address proxy) view returns (address implementation)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
]);
export const ALL_ROLES = BigInt('0x' + '1'.repeat(64));
const NAME_ROLES = (1n << 20n) | (1n << 24n) | (1n << 148n) | (1n << 152n) | (1n << 156n);

export function rpcClient(url = DEFAULT_RPC) {
  if (!/^https?:\/\//.test(url)) throw new Error('RPC must be an HTTP(S) URL.');
  return createPublicClient({ chain: sepolia, transport: http(url, { timeout: 12_000, retryCount: 1 }), cacheTime: 0 });
}
export type RpcClient = ReturnType<typeof rpcClient>;
export function agentName(input: string) {
  const name = normalize(input.trim());
  const parts = name.split('.');
  if (parts.length !== 3 || parts[2] !== 'eth' || parts.some(p => !p)) throw new Error('Use a direct subname: delta.your-team.eth.');
  return name;
}
export const dnsName = (name: string) => toHex(packetToBytes(agentName(name)));
export const labelId = (label: string) => BigInt(keccak256(stringToHex(label)));
export function address(input: string): Address {
  if (!isAddress(input) || input.toLowerCase() === zeroAddress) throw new Error('Enter a nonzero Ethereum address.');
  return getAddress(input);
}
export function errorText(error: unknown): string {
  if (error instanceof BaseError) {
    const rejected = error.walk(e => typeof e === 'object' && e !== null && 'code' in e && e.code === 4001);
    if (rejected && 'code' in rejected && rejected.code === 4001) return 'Wallet request rejected. No confirmed change.';
    const revert = error.walk(e => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return `Contract reverted: ${revert.data?.errorName ?? revert.reason ?? 'unknown reason'}.`;
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : 'Unexpected error.';
}
export function permissionDenied(error: unknown) {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk(e => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError &&
    ['EACUnauthorizedAccountRoles', 'EACCannotGrantRoles', 'EACCannotRevokeRoles'].includes(revert.data?.errorName ?? '');
}
export async function verifyNetwork(client: RpcClient) {
  if (await client.getChainId() !== sepolia.id) throw new Error('RPC is not Sepolia. No write permitted.');
  const codes = await Promise.all(Object.entries(contracts).map(async ([name, addr]) => [name, await client.getCode({ address: addr })] as const));
  for (const [name, code] of codes) if (!code || code === '0x') throw new Error(`Missing ${name} at pinned ENSv2 deployment. Verify the current ENS Sepolia deployment.`);
}
export async function verifyProxy(client: RpcClient, proxy: Address, implementation: Address) {
  const actual = await client.readContract({ address: contracts.factory, abi: factoryAbi, functionName: 'verifyContract', args: [proxy] });
  if (actual.toLowerCase() !== implementation.toLowerCase()) throw new Error('Proxy implementation differs from pinned ENSv2 beta. Review the deployment before writing.');
}
export async function resolverForWrite(client: RpcClient, input: string) {
  const name = agentName(input);
  if (await client.getChainId() !== sepolia.id) throw new Error('RPC is not Sepolia.');
  const resolver = await client.getEnsResolver({ name });
  if (!resolver || resolver === zeroAddress) throw new Error('No resolver found. Complete ENS setup first.');
  await verifyProxy(client, resolver, contracts.resolverImplementation);
  const alias = await client.readContract({ address: resolver, abi: resolverAbi, functionName: 'getAlias', args: [dnsName(name)] });
  if (alias !== '0x') throw new Error('Aliased names are outside this demo. Use a direct, unaliased subname.');
  return resolver;
}
export async function resolveAgent(client: RpcClient, input: string) {
  const name = agentName(input);
  if (await client.getChainId() !== sepolia.id) throw new Error('RPC is not Sepolia.');
  // Resolve each record through the Universal Resolver, independent of admin memory.
  const [resolver, endpoint, payout, description, block] = await Promise.all([
    client.getEnsResolver({ name }), client.getEnsText({ name, key: ENDPOINT_KEY }),
    client.getEnsAddress({ name }), client.getEnsText({ name, key: 'description' }), client.getBlockNumber(),
  ]);
  if (!resolver || resolver === zeroAddress) throw new Error('ENS name has no resolver on Sepolia.');
  return { name, resolver, endpoint, payout, description, block: block.toString(), checkedAt: Date.now() };
}
export type Resolution = Awaited<ReturnType<typeof resolveAgent>>;
export type TxRecord = { action: string; hash: Hash; block: string; timestamp: number };
type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };
export type Progress = (message: string, record?: TxRecord) => void;

export async function confirmedWrite(client: RpcClient, wallet: WalletClient, account: Address, call: Call, action: string, progress: Progress = () => {}) {
  if (await wallet.getChainId() !== sepolia.id || await client.getChainId() !== sepolia.id) throw new Error('Switch both wallet and RPC to Sepolia.');
  progress(`Simulating: ${action}`);
  const { request } = await client.simulateContract({ ...call, account });
  progress(`Confirm in wallet: ${action}`);
  const hash = await wallet.writeContract({ ...request, account, chain: sepolia });
  progress(`Waiting for receipt: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  progress(`Confirmed: ${action}`, { action, hash, block: receipt.blockNumber.toString(), timestamp: Date.now() });
  return receipt;
}
export async function setPermission(client: RpcClient, wallet: WalletClient, admin: Address, name: string, operator: Address, grant: boolean, progress?: Progress) {
  if (admin.toLowerCase() === operator.toLowerCase()) throw new Error('Operator must be a separate account from the admin.');
  const resolver = await resolverForWrite(client, name);
  await confirmedWrite(client, wallet, admin, { address: resolver, abi: resolverAbi, functionName: 'authorizeTextRoles', args: [dnsName(name), ENDPOINT_KEY, operator, grant] }, grant ? 'Grant endpoint permission' : 'Revoke endpoint permission', progress);
  const report = await permissionReport(client, name, operator);
  if (report.find(r => r.key === 'endpoint')?.allowed !== grant) throw new Error('Transaction mined, but effective endpoint access differs. Check broader roles and the current resolver.');
  return report;
}
export async function setRecords(client: RpcClient, wallet: WalletClient, admin: Address, input: string, endpoint: string, payout: Address, description: string, progress?: Progress) {
  allowedEndpoint(endpoint);
  const name = agentName(input), resolver = await resolverForWrite(client, name);
  const node = namehash(name);
  await confirmedWrite(client, wallet, admin, { address: resolver, abi: resolverAbi, functionName: 'multicall', args: [[
    encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [node, ENDPOINT_KEY, endpoint] }),
    encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [node, 'description', description.slice(0, 280)] }),
    encodeFunctionData({ abi: resolverAbi, functionName: 'setAddr', args: [node, payout] }),
  ]] }, 'Save endpoint, description and payout', progress);
  const resolved = await resolveAgent(client, name);
  if (resolved.endpoint !== endpoint || resolved.payout?.toLowerCase() !== payout.toLowerCase() || resolved.description !== description.slice(0, 280)) throw new Error('Receipt mined, but readback differs. Refresh before continuing.');
  return resolved;
}
export type PermissionCheck = { key: string; label: string; allowed: boolean | null; detail: string };
export async function permissionReport(client: RpcClient, input: string, operator: Address): Promise<PermissionCheck[]> {
  const name = agentName(input), node = namehash(name), resolver = await resolverForWrite(client, name);
  const [label, parentLabel] = name.split('.');
  const registry = await client.readContract({ address: contracts.ethRegistry, abi: registryAbi, functionName: 'getSubregistry', args: [parentLabel!] });
  if (registry === zeroAddress) throw new Error('Parent has no subregistry.');
  const calls: (Call & { key: string; label: string })[] = [
    { key: 'endpoint', label: 'Update endpoint', address: resolver, abi: resolverAbi, functionName: 'setText', args: [node, ENDPOINT_KEY, endpoints.v2] },
    { key: 'payout', label: 'Change payout', address: resolver, abi: resolverAbi, functionName: 'setAddr', args: [node, operator] },
    { key: 'description', label: 'Change description', address: resolver, abi: resolverAbi, functionName: 'setText', args: [node, 'description', 'Permission check — never broadcast'] },
    { key: 'grant', label: 'Grant itself more roles', address: resolver, abi: resolverAbi, functionName: 'authorizeNameRoles', args: [dnsName(name), 1n, operator, true] },
    { key: 'resolver', label: 'Change resolver', address: registry, abi: registryAbi, functionName: 'setResolver', args: [labelId(label!), operator] },
    { key: 'registry', label: 'Change subregistry', address: registry, abi: registryAbi, functionName: 'setSubregistry', args: [labelId(label!), registry] },
  ];
  return Promise.all(calls.map(async ({ key, label: title, ...call }) => {
    try {
      await client.simulateContract({ ...call, account: operator });
      return { key, label: title, allowed: true, detail: 'eth_call accepted. No transaction sent.' };
    } catch (error) {
      return { key, label: title, allowed: permissionDenied(error) ? false : null, detail: errorText(error) };
    }
  }));
}

export async function setupName(client: RpcClient, wallet: WalletClient, admin: Address, input: string,
  saved: { resolver?: Address; registry?: Address }, remember: (kind: 'resolver' | 'registry', value: Address) => void, progress: Progress) {
  const name = agentName(input), [label, parentLabel] = name.split('.');
  const parent = `${parentLabel}.eth`;
  await verifyNetwork(client);
  const state = await client.readContract({ address: contracts.ethRegistry, abi: registryAbi, functionName: 'getState', args: [labelId(parentLabel!)] });
  if (state.status !== 2 || state.latestOwner.toLowerCase() !== admin.toLowerCase()) throw new Error(`Register ${parent} on app.ens.dev with this admin wallet first.`);
  async function deploy(kind: 'resolver' | 'registry', existing?: Address) {
    const implementation = kind === 'resolver' ? contracts.resolverImplementation : contracts.registryImplementation;
    if (existing && existing !== zeroAddress && await client.getCode({ address: existing })) {
      await verifyProxy(client, existing, implementation);
      const controls = await client.readContract({ address: existing, abi: resolverAbi, functionName: 'hasRootRoles', args: [kind === 'resolver' ? (1n << 128n) | (1n << 132n) : 1n, admin] });
      if (!controls) throw new Error(`This admin does not control the existing ${kind}.`);
      return existing;
    }
    const salt = BigInt(kind === 'resolver' ? keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [keccak256(stringToHex('OwnedResolver')), admin, 0n],
    )) : keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }], [keccak256(stringToHex('UserRegistry')), namehash(parent), 0n],
    )));
    const data = kind === 'resolver' ? encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [admin, ALL_ROLES, []] }) : encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [admin, ALL_ROLES] });
    const call = { address: contracts.factory, abi: factoryAbi, functionName: 'deployProxy', args: [implementation, salt, data] } as const;
    const predicted = await client.simulateContract({ ...call, account: admin });
    remember(kind, predicted.result); // Persist before sending so a reload can recover a mined proxy.
    const receipt = await confirmedWrite(client, wallet, admin, call, `Deploy ${kind} proxy`, progress);
    const log = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs }).find(l => l.address.toLowerCase() === contracts.factory);
    if (!log) throw new Error('Factory receipt missing ProxyDeployed. Inspect the transaction.');
    await verifyProxy(client, log.args.proxyAddress, implementation);
    return log.args.proxyAddress;
  }
  let registry = await client.readContract({ address: contracts.ethRegistry, abi: registryAbi, functionName: 'getSubregistry', args: [parentLabel!] });
  const hadRegistry = registry !== zeroAddress;
  registry = await deploy('registry', hadRegistry ? registry : saved.registry);
  remember('registry', registry);
  if (!hadRegistry) await confirmedWrite(client, wallet, admin, { address: contracts.ethRegistry, abi: registryAbi, functionName: 'setSubregistry', args: [labelId(parentLabel!), registry] }, `Attach registry to ${parent}`, progress);
  const child = await client.readContract({ address: registry, abi: registryAbi, functionName: 'getState', args: [labelId(label!)] });
  if (child.status === 2) {
    if (child.latestOwner.toLowerCase() !== admin.toLowerCase()) throw new Error('Subname already belongs to another owner.');
    const resolver = await resolverForWrite(client, name);
    remember('resolver', resolver);
    return { registry, resolver };
  }
  // Reuse the ENS app's owned resolver if available; never overwrite an existing parent's resolver.
  const parentResolver = await client.getEnsResolver({ name: parent });
  const resolver = await deploy('resolver', saved.resolver ?? (parentResolver && parentResolver !== zeroAddress ? parentResolver : undefined));
  remember('resolver', resolver);
  const year = BigInt(Math.floor(Date.now() / 1000) + 365 * 86400);
  const expiry = state.expiry < year ? state.expiry : year;
  await confirmedWrite(client, wallet, admin, { address: registry, abi: registryAbi, functionName: 'register', args: [label!, admin, zeroAddress, resolver, NAME_ROLES, expiry] }, `Register ${name} to admin`, progress);
  if ((await resolverForWrite(client, name)).toLowerCase() !== resolver.toLowerCase()) throw new Error('Subname resolution differs after registration.');
  return { registry, resolver };
}
