# AgentPermit Delta

One user describes a goal, an AI compares two live Uniswap V3 pools, and deterministic code opens and maintains a covered WETH/USDC position after explicit approval.

The demo deliberately separates environments:

- Uniswap V3 executes against official Ethereum contracts on a fixed Anvil fork.
- Hyperliquid market data informs the proposal from mainnet; orders execute only on testnet.
- ENSv2 identity and endpoint permissions operate on Sepolia.
- The previous paper ledger remains available and persists separately from live strategy state.

This is a test-funds hackathon executor, not a profit promise. Delta neutrality does not remove funding, basis, range, liquidation, smart-contract or execution risk. Real Graph/OpenAI evidence and both Uniswap fork fee-tier checks are verified; Hyperliquid execution, the user-owned ENS flow, publication and the final recording remain pending.

## Run the complete local demo

Requires Node 24.7+, Foundry/Anvil, an Ethereum archive-capable RPC, The Graph and OpenAI API keys, and a dedicated Hyperliquid testnet master with at least 200 USDC in Perps, no orders or positions, and a separate authorized API wallet. Follow [the setup remedies](docs/SETUP.md).

```sh
npm ci
# Only if .env does not already exist:
cp .env.example .env
npm run doctor
```

Fill the server-only values in `.env`. Keep the three private keys separate: the public Anvil development key, the Hyperliquid testnet API wallet, and the ENS Sepolia operator. The Hyperliquid API signer must also differ from its master; the master key stays out of the executor.

The verified fixed mainnet block is `25965916`. `FORK_USDC_DONOR` must hold at least 150 USDC at that block; it is impersonated only inside Anvil. Inspect an existing fork and ledger before restarting or funding it. The read-only doctor reports the actual fork origin and balances without changing them.

```sh
# Terminal 1
npm run fork

# Terminal 2, once per fresh fork
npm run fund:fork

# Terminal 2, after funding
npm run agent

# Terminal 3
npm run dev
```

Open [the strategy workspace](http://127.0.0.1:5173/strategy). The local API listens only on `127.0.0.1:4318`.

## Proposal

`POST /strategy/propose` performs three real reads before returning:

1. The documented Uniswap V3 Ethereum subgraph on The Graph supplies the 0.05% and 0.3% USDC/WETH pools, its indexed block, and exactly seven complete UTC days of TVL, volume, fees and prices.
2. Hyperliquid mainnet supplies ETH mark, funding, open interest and ±0.5% book depth. These values are analysis inputs, not testnet execution results.
3. OpenAI Responses uses `gpt-5-nano` with strict structured output: selected fee tier, open/wait recommendation, reasons, risks and references to supplied metric IDs.

Missing, incomplete or stale data makes the proposal fail. Each model reason must cite supplied metrics, with both pools represented across the decision. There is no fabricated fallback. The exact GraphQL query, raw inputs, model request and model response are written atomically to ignored `data/evidence/proposal-<id>.json` without API keys. Approval requires a proposal no older than five minutes; historical evidence must not be approved as a current proposal.

The executor, not the model, fixes the test limits: 500 USDC total, 300 for the LP, up to 200 for perp reserve, ±20% range and isolated 1× leverage.

## Execution and recovery

`POST /strategy/actions` accepts `approve`, `pause`, `resume` and `close`, each with a caller-generated idempotency ID. The browser obtains an ephemeral session token after startup; writes also require the local Host and allowed Origin. Keys never enter the browser bundle.

On approval the server:

- requires Anvil chain 31337 at the configured fixed block;
- resolves the pool through the official factory and verifies USDC, WETH and fee;
- uses the Uniswap V3 SDK to build and mint the NFT position;
- reads confirmed LP amounts before calculating the short;
- requires at least 200 USDC in the Hyperliquid testnet master's Perps account, with no existing positions or orders;
- discovers ETH and size precision from metadata, sets isolated 1×, and sends IOC orders with deterministic client order IDs;
- recalculates `LP WETH + free strategy WETH + pending WETH fees + perp ETH` after every partial fill.

The ten-second monitor adjusts only when residual exposure exceeds $12 and meets the configured market minimum. Data older than 30 seconds blocks new orders. It closes after 60 seconds outside the LP range or when liquidation is less than 10% from mark. Pause stops new approvals while hedge maintenance continues.

Every external intent is persisted before send. A timeout leaves it `unknown`; restart queries the deterministic Hyperliquid client order ID and requires a current account read before acting. If initial coverage still fails after three known attempts, the executor unwinds the LP, sells its WETH and closes any partially filled short. Closure requires the actual perp ETH position to reach zero; residual exposure is not accepted as dust.

Unknown outcomes block replacement orders and compensation. An absent Hyperliquid client order ID is not proof that nothing was submitted: after 30 seconds it requires intervention. Unknown Uniswap operations require manual receipt inspection; automatic EVM reconciliation is not implemented. Preserve the ledger while inspecting either case.

For the controlled recovery segment, set `REPLAY_INITIAL_HEDGE_RATIO=0.8` and `REPLAY_TIMEOUT_AFTER_SEND=1` before approval. The first order requests 80% of the initial hedge; the actual IOC fill is not guaranteed. After a terminal fill and current account confirmation, its response is deliberately discarded and the UI labels the run as replay data. Restart `npm run agent`; startup reconciliation queries the persisted `cloid` and adjusts only confirmed remaining exposure. Clear both variables for the normal path.

Live state is `data/strategy-state.json`; the legacy paper ledger remains `data/state.json`. Both use temp-file write, `fsync`, rename and directory `fsync`.

## ENSv2

The admin registers/configures `delta.<team>.eth`, delegates only `agentpermit.endpoint` to the operator, and retains payout and protected records. The wallet-free client resolves the endpoint independently on Sepolia and displays the service's live strategy separately from the legacy paper ledger. ENS authenticates the pointer; it does not attest metrics or enforce financial limits.

See [the environment manifest](docs/ENVIRONMENTS.md), [ENS feedback](docs/ENS-FEEDBACK.md), [Uniswap feedback](FEEDBACK.md), and [three-minute demo](docs/DEMO.md).

## Validation

```sh
npm run check       # types, 33 deterministic tests, production build
npm run test:browser # strategy/admin/client desktop and mobile fixture render
npm run doctor      # read-only environment/account/identity readiness
npm run check:fork -- 25965916 # disposable fork; real mint/burn/sale for both fee tiers
npm run check:ens   # real Sepolia reads/simulations after ENS configuration
npm run evidence:export # whitelist public evidence from existing local files
```

Tests cover LP/perp exposure including pending fees and free WETH, partial fills, $12 re-hedging, 60-second range exit, idempotent actions, timeout/restart reconciliation without duplicate orders, three-failure unwind, HTTP session/origin boundaries, the legacy paper ledger and ENS endpoint recovery.

Verified on 2026-09-13: `npm run check` passed 33 tests and the production build; browser fixtures passed. The isolated contract check passed mint/read/remove/collect/NFT burn/WETH sale at block 25965916 for fees 500 and 3000, with zero remaining WETH. The latest real Graph/OpenAI capture is `0de9b168-62a2-4b13-8d62-55ef093a3aa2`, indexed block 25966246, model `gpt-5-nano`, recommendation `open`, fee 500.

The [public bundle](docs/evidence/demo.json) separates that analytics capture from the saved execution proposal and independent fork check. Select an actual capture with `npm run evidence:export -- --proposal <UUID>`; this does not alter the strategy ledger. Hyperliquid order evidence and user-owned ENS receipts remain missing. Current limitations and submission requirements are in [validation status](docs/VALIDATION.md) and [the submission checklist](docs/SUBMISSION.md).

Integration entry points: [Graph and AI proposal](server/proposal.ts#L152), [Uniswap SDK mint](server/uniswap.ts#L138), [Uniswap close/burn/sale](server/uniswap.ts#L174), [Hyperliquid testnet executor](server/hyperliquid.ts), and [ENSv2 resolver permissions](shared/ens.ts). Fixed contract addresses are in [the environment manifest](docs/ENVIRONMENTS.md).

## Fixed contracts and sources

- [Uniswap V3 Ethereum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments)
- [Uniswap V3 subgraph endpoint](https://developers.uniswap.org/docs/ecosystem/subgraphs/overview)
- [Hyperliquid API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api)
- [OpenAI Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [ENSv2 permissioned resolver](https://docs.ens.domains/ensv2/permissioned-resolver/)
