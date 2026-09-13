import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, encodeFunctionData, namehash, toHex } from 'viem';
import { packetToBytes } from 'viem/ens';
import { Engine } from '../server/engine.ts';
import { apiServer } from '../server/http.ts';
import { reconcile, rotate, type MigrationChain } from '../server/migration.ts';
import { ALL_ROLES, agentName, dnsName, errorText, permissionDenied, resolverAbi } from '../shared/ens.ts';
import { allowedEndpoint, endpoints, parseStatus } from '../shared/status.ts';

const name = 'delta.agentpermit.eth';
const operator = '0x0000000000000000000000000000000000000001';
const hash = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const now = 1_800_000_000_000;
function instance(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'agentpermit-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Engine(join(dir, 'state.json'), name);
}
const denied = () => new ContractFunctionRevertedError({ abi: resolverAbi, functionName: 'setText', data: encodeErrorResult({ abi: resolverAbi, errorName: 'EACUnauthorizedAccountRoles', args: [0n, 16n, operator] }) });

test('paper lifecycle: real arithmetic, fee/slippage once, price-only neutrality, restart and closing', t => {
  const e = instance(t);
  e.quote('3000', now, now); e.action('open', now);
  const status = parseStatus(e.status('v1', now), name);
  assert.equal(status.deltaEth, '0');
  assert.equal(status.fees, '0.3');
  assert.equal(status.unrealizedPnl, '-0.6');
  assert.equal(status.netPnl, '-0.9');
  assert.throws(() => e.action('open', now), /existing position/);
  e.quote('3600', now + 1000, now + 1000); e.action('hedge', now + 1000);
  assert.equal(e.state.history.length, 2); // Price alone cannot change the linear delta.
  assert.equal(e.status('v1', now + 1000).netPnl, '-0.9');
  const reloaded = new Engine(e.path, name);
  assert.deepEqual(reloaded.state, e.state);
  reloaded.quote('3000', now + 2000, now + 2000); reloaded.action('close', now + 2000);
  assert.equal(reloaded.status('v1', now + 2000).realizedPnl, '-1.2');
  assert.equal(reloaded.status('v1', now + 2000).netPnl, '-1.8');
  assert.equal(reloaded.status('v1', now + 2000).fees, '0.6');
  reloaded.action('close', now + 2000);
  assert.equal(reloaded.state.history.length, 4);
});

test('partial execution rebalances once; stale/invalid quotes and failed persistence cannot create orders', t => {
  const e = instance(t);
  assert.throws(() => e.action('open', now), /No fresh quote/);
  for (const price of ['0', '-1', 'NaN', '1e3', '1.0000001', 3000]) assert.throws(() => e.quote(price, now, now), /Invalid/);
  e.quote('3000', now, now); e.action('partial', now);
  assert.equal(e.status('v1', now).deltaEth, '0.02');
  assert.throws(() => e.action('hedge', now + 30_001), /No fresh quote/);
  assert.equal(e.state.history.length, 2);
  e.quote('3000', now + 31_000, now + 31_000); e.action('hedge', now + 31_000); e.action('hedge', now + 31_000);
  assert.equal(e.state.history.length, 3);
  assert.equal(e.status('v1', now + 31_000).netPnl, '-0.9');
  assert.equal(e.delta(), 0n);
  assert.throws(() => e.quote('3000', now + 10_000, now + 31_000), /Out-of-order/);
  assert.throws(() => e.quote('3000', now + 50_000, now + 31_000), /Invalid/);
  const before = structuredClone(e.state), file = e.path;
  e.path = join(file, 'impossible.json');
  assert.throws(() => e.action('close', now + 31_000));
  assert.deepEqual(e.state, before);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before);
  assert.throws(() => new Engine(file, 'delta.other.eth'), /differ/);
  writeFileSync(file, '{bad data');
  assert.throws(() => new Engine(file, name));
});

test('endpoint rotation: prepare before publication, preserve fills, recover crash, denied/reverted/uncertain writes', async t => {
  const e = instance(t); e.quote('3000', now, now); e.action('open', now);
  const history = structuredClone(e.state.history);
  let current: string = endpoints.v1;
  const chain: MigrationChain = {
    endpoint: async () => current,
    write: async endpoint => { assert.equal(e.state.pending?.to, 'v2'); assert.equal(e.state.active, 'v1'); current = endpoint; return hash; },
    receipt: async () => 'success',
  };
  await rotate(e, 'v2', chain);
  assert.equal(e.state.active, 'v2'); assert.equal(e.state.pending, null); assert.deepEqual(e.state.history, history);
  const reloaded = new Engine(e.path, name);
  assert.equal(reloaded.state.active, 'v2'); assert.deepEqual(reloaded.state.history, history);
  await assert.rejects(() => rotate(e, 'v2', chain), /already active/);
  chain.write = async () => { throw denied(); };
  await assert.rejects(() => rotate(e, 'v1', chain));
  assert.equal(e.state.pending, null); assert.equal(e.state.active, 'v2');
  chain.write = async () => hash; chain.receipt = async () => 'reverted';
  await assert.rejects(() => rotate(e, 'v1', chain), /reverted/);
  assert.equal(e.state.active, 'v2'); assert.equal(e.state.pending, null);
  chain.write = async () => { throw new Error('RPC timed out after broadcasting'); };
  await assert.rejects(() => rotate(e, 'v1', chain), /timed out/);
  assert.deepEqual(e.state.pending, { from: 'v2', to: 'v1' }); assert.equal(e.state.active, 'v2');
  const afterCrash = new Engine(e.path, name);
  current = endpoints.v1; // Simulate the previously uncertain transaction becoming visible.
  await reconcile(afterCrash, chain);
  assert.equal(afterCrash.state.active, 'v1'); assert.equal(afterCrash.state.pending, null);
  assert.deepEqual(afterCrash.state.history, history);
});

test('read-only API: active endpoint, prepared endpoint, retirement, CORS, host and method limits', async t => {
  const e = instance(t);
  const server = apiServer(() => e, operator);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/agent/v1/status`)).status, 200);
  assert.equal((await fetch(`${base}/agent/v2/status`)).status, 410);
  e.update(s => { s.pending = { from: 'v1', to: 'v2' }; });
  assert.equal((await fetch(`${base}/agent/v2/status`)).status, 200);
  e.update(s => { s.pending = null; s.active = 'v2'; });
  assert.equal((await fetch(`${base}/agent/v1/status`)).status, 410);
  assert.equal((await fetch(`${base}/config`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/config`, { headers: { origin: 'https://example.com' } })).status, 403);
  const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    get(`${base}/config`, { headers: { host: `evil.example:${port}` } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  const response = await fetch(`${base}/config`, { headers: { origin: 'http://127.0.0.1:5173' } });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5173');
  const body = await response.text(); assert.ok(!body.includes('PRIVATE_KEY')); assert.ok(body.includes(operator));
  const options = await fetch(`${base}/config`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
  assert.equal(options.status, 204);
});

test('ENS encoding and permission errors stay distinct from transport failure; endpoint boundary rejects arbitrary destinations', () => {
  assert.equal(agentName(' DELTA.AgentPermit.eth '), name);
  assert.throws(() => agentName('agentpermit.eth'));
  assert.throws(() => agentName('delta.agentpermit.com'));
  assert.equal(dnsName(name), toHex(packetToBytes(name)));
  const authorization = encodeFunctionData({ abi: resolverAbi, functionName: 'authorizeTextRoles', args: [dnsName(name), 'agentpermit.endpoint', operator, true] });
  const setter = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [namehash(name), 'agentpermit.endpoint', endpoints.v2] });
  assert.notEqual(authorization.slice(0, 10), setter.slice(0, 10));
  assert.equal(ALL_ROLES.toString(16).length, 64);
  assert.ok(permissionDenied(denied())); assert.match(errorText(denied()), /Contract reverted/);
  const timeout = new BaseError('RPC request failed');
  assert.equal(permissionDenied(timeout), false); assert.equal(errorText(timeout), 'RPC request failed');
  assert.equal(allowedEndpoint(endpoints.v1), endpoints.v1);
  for (const bad of ['https://example.com', 'http://127.0.0.1:4318@evil.example/agent/v1/status', endpoints.v1 + '?redirect=x', 'http://localhost:4318/agent/v1/status']) assert.throws(() => allowedEndpoint(bad));
  assert.throws(() => parseStatus({ mode: 'live' }));
});

test('operator key creation is local, private, idempotent and never prints the secret', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentpermit-key-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyFileSync('.env.example', join(directory, '.env.example'));
  const script = join(process.cwd(), 'scripts/keygen.ts');
  const first = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const contents = readFileSync(join(directory, '.env'), 'utf8');
  const key = contents.match(/^AGENT_PRIVATE_KEY=(0x[a-f0-9]{64})$/m)?.[1];
  assert.ok(key); assert.ok(!first.stdout.includes(key));
  assert.equal(statSync(join(directory, '.env')).mode & 0o777, 0o600);
  const second = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
  assert.equal(second.status, 0); assert.equal(second.stdout, first.stdout);
  assert.equal(readFileSync(join(directory, '.env'), 'utf8'), contents);
});
