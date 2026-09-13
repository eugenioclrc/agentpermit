// Deliberate public export: known files and explicitly selected fields only. Never load .env.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWrite } from '../server/engine.ts';
import { normalizeEvidenceIds, validateDecision } from '../server/proposal.ts';
import { agentName } from '../shared/ens.ts';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evidence object.');
  return value as Json;
};
const list = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid evidence list.');
  return value;
};
const integer = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid evidence integer.');
  return value;
};
const decimal = (value: unknown) => {
  if (typeof value !== 'string' || !/^-?\d{1,60}(\.\d{1,60})?$/.test(value)) throw new Error('Invalid evidence decimal.');
  return value;
};
const match = (value: unknown, pattern: RegExp) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('Invalid evidence identifier.');
  return value;
};
const hash = (value: unknown) => match(value, /^0x[\da-f]{64}$/i);
const address = (value: unknown) => match(value, /^0x[\da-f]{40}$/i);
const uuid = (value: unknown) => match(value, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
const choice = <T extends string | number | boolean>(value: unknown, allowed: readonly T[]): T => {
  if (!allowed.includes(value as T)) throw new Error('Unexpected evidence value.');
  return value as T;
};
const numbers = (value: unknown, keys: readonly string[]) => {
  const input = object(value);
  return Object.fromEntries(keys.map(key => [key, decimal(input[key])]));
};
const nullable = <T>(value: unknown, parse: (value: unknown) => T) => value === null || value === undefined ? null : parse(value);
const metricId = (value: unknown) => match(value, /^(pool_(500|3000)_(tvl_usd|volume_7d_usd|fees_7d_usd)|hl_(mark_usd|funding_rate|bid_depth_0_5pct_usd|ask_depth_0_5pct_usd))$/);
const externalId = (kind: string, value: unknown) => nullable(value, value => kind === 'weth-sell' && value === 'no-weth' ? 'no-weth' : kind === 'perp-order' ? decimal(value) : hash(value));
const transaction = (value: unknown) => {
  const tx = object(value);
  return { hash: hash(tx.hash), operation: choice(tx.operation, ['LP token approval', 'LP mint', 'LP remove and collect', 'WETH router approval', 'WETH sale']), status: choice(tx.status, ['prepared', 'confirmed', 'reverted']) };
};

function proposalEvidence(input: Json) {
  const proposal = object(input.proposal), graph = object(input.theGraph), rawGraph = object(object(graph.response).data);
  const ai = object(input.openai), request = object(ai.request), response = object(ai.response);
  const text = list(response.output).flatMap(item => list(object(item).content ?? [])).map(object).find(item => item.type === 'output_text')?.text;
  if (response.status !== 'completed' || request.model !== 'gpt-5-nano' || typeof text !== 'string') throw new Error('No completed model evidence.');
  const decision = object(JSON.parse(text));
  const poolFee = choice(decision.poolFee, [500, 3000]);
  const recommendation = choice(decision.recommendation, ['open', 'wait']);
  const supplied = object(object(JSON.parse(String(request.input))).metrics);
  const allowed = new Set(Object.keys(supplied).map(metricId));
  const evidenceIds = decision.evidenceIds ? normalizeEvidenceIds(decision.evidenceIds, allowed) : validateDecision(decision, allowed).evidenceIds;
  if (!evidenceIds) throw new Error('Invalid model evidence references.');
  if (poolFee !== proposal.poolFee || recommendation !== proposal.recommendation || JSON.stringify(evidenceIds) !== JSON.stringify(proposal.evidenceIds)) throw new Error('Saved proposal differs from model evidence.');
  const block = integer(object(object(rawGraph._meta).block).number);
  if (block !== object(proposal.graph).block) throw new Error('Graph block differs from proposal.');
  const variables = object(graph.variables), start = integer(variables.start), end = integer(variables.end);
  if (end - start !== 7 * 86_400 || start % 86_400 !== 0) throw new Error('Expected seven complete UTC days.');
  const pools = list(rawGraph.pools).map(value => {
    const pool = object(value), fee = choice(Number(pool.feeTier), [500, 3000]);
    const id = choice(String(pool.id).toLowerCase(), ['0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8']);
    if (object(pool.token0).symbol !== 'USDC' || object(pool.token1).symbol !== 'WETH') throw new Error('Unexpected pool tokens.');
    const days = list(pool.poolDayData).map((value, index) => {
      const day = object(value), date = integer(day.date);
      if (date !== start + index * 86_400) throw new Error('Graph days are incomplete or out of order.');
      return { date, ...numbers(day, ['tvlUSD', 'volumeUSD', 'feesUSD', 'token0Price', 'token1Price']) };
    });
    if (days.length !== 7) throw new Error('Expected seven days per pool.');
    return { address: id, fee, liquidity: decimal(pool.liquidity), tvlUsd: decimal(pool.totalValueLockedUSD), days };
  });
  if (pools.length !== 2 || new Set(pools.map(pool => pool.fee)).size !== 2) throw new Error('Expected both pools.');
  return {
    id: uuid(proposal.id), capturedAt: integer(input.createdAt),
    theGraph: { network: 'Ethereum mainnet', indexedBlock: block, startUtc: start, endUtcExclusive: end, pools },
    openai: { model: 'gpt-5-nano', status: 'completed', selectedFee: poolFee, recommendation, evidenceIds, reasonsCount: list(decision.reasons).length, risksCount: list(decision.risks).length },
    hyperliquidAnalysis: { network: 'Hyperliquid mainnet; analysis only', ...numbers(proposal.hyperliquid, ['markPrice', 'fundingRate', 'openInterestEth', 'bidDepthUsd', 'askDepthUsd']), timestamp: integer(object(proposal.hyperliquid).timestamp) },
    limitation: 'Historical capture of real provider requests. Export does not refresh data or attest profitability. Free-text prompts, reasons, risks, headers and raw provider payloads are omitted.',
  };
}

function strategyEvidence(input: Json) {
  const lp = object(input.lp), perp = object(input.perp), fork = object(input.fork), environment = object(input.perpEnvironment), exposure = object(input.exposure);
  if (input.schema !== 1 || input.mode !== 'delta-neutral' || fork.chainId !== 31337 || environment.network !== 'Hyperliquid testnet') throw new Error('Unexpected strategy environment.');
  return {
    source: 'Persisted local strategy ledger; exporter does not query receipts or place orders',
    recordedAt: integer(input.generatedAt), phase: choice(input.phase, ['idle', 'proposed', 'opening', 'recovering', 'active', 'paused', 'closing', 'closed', 'intervention_required']),
    proposalId: input.proposal ? uuid(object(input.proposal).id) : null,
    fork: { chainId: 31337, block: nullable(fork.blockNumber, integer), positionManager: address(fork.positionManager), transactionScope: 'Local Anvil hashes, not mainnet transactions' },
    hyperliquid: { network: 'testnet', account: nullable(environment.account, address), replayEnabled: environment.replay !== null },
    lp: { status: choice(lp.status, ['empty', 'open', 'closed', 'unknown']), tokenId: nullable(lp.tokenId, decimal), pool: nullable(lp.pool, address), ...numbers(lp, ['liquidity', 'usdc', 'weth', 'feesUsdc', 'feesWeth', 'freeWeth', 'proceedsUsdc']), openTx: nullable(lp.openTx, hash), closeTx: nullable(lp.closeTx, hash) },
    perp: { status: choice(perp.status, ['flat', 'open', 'unknown']), ...numbers(perp, ['sizeEth', 'entryPrice', 'markPrice', 'marginUsd', 'fundingUsd', 'unrealizedPnlUsd']), lastOrderId: nullable(perp.lastOrderId, decimal) },
    exposure: { ...numbers(exposure, ['eth', 'usd']), recordedAt: nullable(exposure.updatedAt, integer), freshAtExport: exposure.fresh === true && typeof exposure.updatedAt === 'number' && Date.now() - exposure.updatedAt <= 30_000 && exposure.updatedAt <= Date.now() + 5_000 },
    costs: numbers(input.costs, ['lpFeesUsdc', 'perpFeesUsdc', 'fundingUsdc', 'forkValueChangeUsdc', 'perpUnrealizedUsdc', 'valueChangeUsdc']),
    accounting: input.accounting ? numbers(input.accounting, ['forkInitialUsdc', 'perpInitialUsdc', 'perpValueChangeUsdc']) : null,
    chainTransactions: list(input.chainTransactions ?? []).map(transaction),
    intents: list(input.intents).map(value => {
      const intent = object(value), kind = choice(intent.kind, ['lp-open', 'perp-order', 'lp-close', 'weth-sell']);
      return { kind, status: choice(intent.status, ['prepared', 'submitted', 'confirmed', 'unknown', 'failed']), createdAt: integer(intent.createdAt), updatedAt: integer(intent.updatedAt), attempts: integer(intent.attempts), requestedEth: nullable(intent.requestedEth, decimal), cloid: nullable(intent.cloid, value => match(value, /^0x[\da-f]{32}$/i)), externalId: externalId(kind, intent.externalId) };
    }),
    limitation: 'Two separate balances and environments. Ledger status is not independently reverified execution or a combined investment return. Errors and arbitrary action text are omitted.',
  };
}

function forkEvidence(input: Json) {
  if (input.kind !== 'isolated-anvil-contract-verification' || input.chainId !== 31337) throw new Error('Unexpected fork evidence kind.');
  return {
    kind: 'isolated-anvil-contract-verification', chainId: 31337, forkBlock: integer(input.forkBlock), forkBlockHash: hash(input.forkBlockHash),
    checkedAt: match(input.checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
    results: list(input.results).map(value => {
      const result = object(value), opened = object(result.opened), closed = object(result.closed);
      return { poolFee: choice(result.poolFee, [500, 3000]), tokenId: decimal(opened.tokenId), liquidity: decimal(opened.liquidity), mintHash: hash(opened.hash), closeHash: hash(closed.hash), sellHash: nullable(closed.sellHash, hash), initialValueUsdc: nullable(opened.initialValueUsdc, decimal), receivedUsdc: decimal(closed.usdcReceived), remainingWeth: decimal(result.remainingWeth) };
    }),
    transactions: list(input.transactions).map(transaction),
    limitation: 'Official contract execution on a disposable Anvil fork, reverted after each fee-tier check. Hashes are local and have no mainnet explorer receipts.',
  };
}

function ensEvidence(input: Json) {
  if (input.chainId !== 11155111) throw new Error('Expected a Sepolia browser manifest.');
  const name = agentName(match(input.name, /^[^\s]{1,255}$/));
  if (name.includes('your-team')) throw new Error('Placeholder ENS name is not evidence.');
  const permissions = object(input.permissionChecks);
  if (permissions.kind !== 'eth_call') throw new Error('Expected simulated permissions.');
  return { chainId: 11155111, name, admin: nullable(input.admin, address), operator: nullable(input.operator, address),
    receipts: list(input.receipts).map(value => { const receipt = object(value); return { hash: hash(receipt.hash), block: match(receipt.block, /^\d{1,30}$/), timestamp: integer(receipt.timestamp) }; }),
    permissionChecks: { kind: 'eth_call', checkedAt: integer(permissions.checkedAt), report: list(permissions.report).map(value => { const check = object(value); return { key: choice(check.key, ['endpoint', 'payout', 'description', 'grant', 'resolver', 'registry']), allowed: check.allowed === null ? null : choice(check.allowed, [true, false]) }; }) },
    limitation: 'Browser-exported mined receipt identifiers and separate eth_call simulations. Exporter does not independently reverify them; ENS controls endpoint permissions, not financial limits.',
  };
}

if (process.argv.includes('--self-test')) {
  const secret = 'PRIVATE_SENTINEL_DO_NOT_EXPORT';
  assert.deepEqual(numbers({ usdc: '150', privateKey: secret }, ['usdc']), { usdc: '150' });
  const safe = transaction({ hash: `0x${'a'.repeat(64)}`, operation: 'LP mint', status: 'confirmed', headers: { authorization: secret }, rawTransaction: secret });
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.deepEqual(Object.keys(safe), ['hash', 'operation', 'status']);
  assert.throws(() => decimal(secret));
  assert.throws(() => hash(`0x${'a'.repeat(128)}`));
  assert.throws(() => metricId(secret));
  assert.equal(externalId('weth-sell', 'no-weth'), 'no-weth');
  assert.throws(() => externalId('lp-close', 'no-weth'));
  assert.throws(() => uuid('../proposal'));
  console.log('PASS export self-check: secrets excluded, strict identifiers, no-weth restricted to WETH-sale intent.');
} else {
  try {
    if (process.argv.length !== 2 && !(process.argv.length === 4 && process.argv[2] === '--proposal')) throw new Error('Use no arguments or --proposal <UUID>.');
    const sources: { file: string; sha256: string }[] = [];
    const read = (file: string) => {
      if (statSync(file).size > 10_000_000) throw new Error('Evidence file exceeds 10 MB.');
      const raw = readFileSync(file, 'utf8');
      sources.push({ file, sha256: createHash('sha256').update(raw).digest('hex') });
      return object(JSON.parse(raw));
    };
    const state = read('data/strategy-state.json');
    const executionProposalId = state.proposal ? uuid(object(state.proposal).id) : null;
    const id = uuid(process.argv[3] ?? executionProposalId);
    const proposal = proposalEvidence(read(`data/evidence/proposal-${id}.json`));
    if (proposal.id !== id) throw new Error('Proposal filename and evidence differ.');
    const uniswapFork = existsSync('data/evidence/uniswap-fork-check.json') ? forkEvidence(read('data/evidence/uniswap-fork-check.json')) : null;
    const ens = existsSync('data/evidence/ens-application.json') ? ensEvidence(read('data/evidence/ens-application.json')) : null;
    const bundle = { schema: 1, exportedAt: new Date().toISOString(), sources, proposal,
      proposalContext: { selectedProposalId: id, executionProposalId, matchesExecutionProposal: id === executionProposalId,
        limitation: 'The selected analytics capture does not replace the saved execution proposal. The fork check is an independent artifact; no matching proposal is asserted.' },
      strategy: strategyEvidence(state), uniswapFork, ens,
      missingEvidence: [...(!uniswapFork ? ['Isolated Uniswap contract check'] : []), ...(!ens ? ['User-owned ENS Sepolia application receipts'] : []), ...(!list(state.intents).some(value => { const intent = object(value); return intent.kind === 'perp-order' && intent.status === 'confirmed' && intent.externalId; }) ? ['Confirmed Hyperliquid testnet order in the strategy ledger'] : [])] };
    atomicWrite(resolve('docs/evidence/demo.json'), bundle);
    console.log(`Exported docs/evidence/demo.json from ${sources.length} existing files. Missing evidence: ${bundle.missingEvidence.join('; ') || 'none listed; inspect receipts and recording separately'}.`);
    console.log(`Selected proposal ${id}; saved execution proposal ${executionProposalId ?? 'none'}; match ${bundle.proposalContext.matchesExecutionProposal}. No input file was changed.`);
  } catch { console.error('Evidence export failed; existing public file was preserved. Use no arguments or --proposal <UUID>; require valid data/strategy-state.json and the selected real proposal evidence. Check optional fork/ENS evidence format in docs/SETUP.md. No raw error or source content was printed.'); process.exitCode = 1; }
}
