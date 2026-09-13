# Complete the real demo

Use Node 24.7+ and Foundry/Anvil. Run `npm ci`, then create `.env` from `.env.example` only if you do not already have it. Preserve existing `.env`, `data/`, and any running fork. The unrelated `heist/` directory is outside AgentPermit.

```sh
npm run doctor
```

Doctor makes bounded read-only RPC/info requests and writes `data/doctor.json` atomically. It exits 1 for missing prerequisites and prints public addresses and remedies without printing private keys or RPC URLs. A pass means readiness for a **fresh** trial, not proof that orders, ENS writes, or sponsor submissions occurred. It checks credential presence without paying for new OpenAI/Graph requests. Existing positions or orders fail the fresh-account check; this is a reason to inspect them, not reset them.

## Resolve the current prerequisites

| Setting/check | Exact remedy |
| --- | --- |
| `OPENAI_API_KEY`, `THE_GRAPH_API_KEY` | Set server-only keys in `.env`. Existing real evidence is retained under `data/evidence/proposal-<id>.json`; do not regenerate it merely to test key presence. |
| `ETHEREUM_RPC_URL` | Use an Ethereum mainnet RPC with historical state at the chosen block. Doctor calls `eth_getCode` at that block for the factory, Position Manager, router, tokens and both pools. |
| `FORK_BLOCK_NUMBER` | Now configured to `25965916`, verified with both LP fee tiers through mint and close. The old value `12345678` has no Position Manager and cannot execute this demo. The existing fork process was not reset: inspect its state, then restart it explicitly to use the configured block. |
| `ANVIL_RPC_URL` | Use `http://127.0.0.1:8545`. Doctor reports both the actual current head and the fork origin from `anvil_metadata`; mining local blocks does not change the fork origin. |
| `FORK_USDC_DONOR` | Choose a mainnet address holding at least 150 USDC at the fixed block. Funding impersonates it only in Anvil. The address needs no real transaction or approval. |
| `ANVIL_PRIVATE_KEY` | Keep the public Anvil development key only on the local fork. Do not fund or reuse it on public chains. |
| `HYPERLIQUID_ACCOUNT_ADDRESS` | Set the dedicated testnet **master** account address. It needs at least 200 test USDC in **Perps**, with no existing positions or open orders before a fresh trial. |
| `HYPERLIQUID_API_PRIVATE_KEY` | Create and authorize a separate API wallet on the [Hyperliquid testnet API screen](https://app.hyperliquid-testnet.xyz/API). Store only that API wallet key server-side; never store the master key. Doctor derives its address and checks the testnet `userRole` master mapping and any listed expiry. |
| `AGENT_PRIVATE_KEY` | `npm run keygen` creates the separate Sepolia endpoint operator locally, or retains an existing configured operator. It prints only the operator address. Fund that address with Sepolia test ETH. |
| `AGENT_NAME`, `VITE_AGENT_NAME` | Set both to the same actual direct subname, such as `delta.<your-owned-parent>.eth`. `delta.your-team.eth` is a placeholder. Register the parent on [ENS Sepolia](https://app.ens.dev) with the admin wallet, then use `/admin` to configure the subname. |
| `SEPOLIA_RPC_URL`, `VITE_SEPOLIA_RPC_URL` | Use Sepolia RPCs; the browser RPC must allow CORS and contain no private credentials. The default public Sepolia RPC is in `.env.example`. Restart Vite after changing any `VITE_` setting. |
| Git remote/public access | Use the intended AgentPermit public GitHub or GitLab repository. Doctor checks anonymous metadata access; a configured remote alone does not establish visibility. Commit and publish only after reviewing the exact files. |

The official [Hyperliquid faucet instructions](https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet) currently require the same address to have deposited on mainnet before claiming 1,000 mock USDC at the [testnet faucet](https://app.hyperliquid-testnet.xyz/drip). If your address is ineligible, obtain testnet collateral from an eligible test account or the event's test-fund support. This setup does not require the agent to make a mainnet deposit. Move test USDC from Spot to Perps in the testnet UI if necessary. API-wallet addresses sign for the master; account queries use the master address. See [official API wallet documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets).

## Fork and strategy

First verify a candidate block in a disposable instance; this uses real Uniswap contract calls on port 18545 and the existing proposal, independently of the main running fork:

```sh
npm run check:fork -- 25965916
```

It writes `data/evidence/uniswap-fork-check.json` only after both fee tiers complete. Its hashes belong to a local fork, never Ethereum mainnet. If port 18545 is occupied, inspect that process before retrying. Do not silently change or restart the fork on 8545.

Once the selected block is configured and existing state has been inspected, start the normal fork. Fund only an empty fresh fork:

```sh
# Terminal 1
npm run fork

# Terminal 2, once per fresh fork
npm run fund:fork
npm run doctor
npm run agent

# Terminal 3
npm run dev
```

Funding supplies 150 USDC and approximately 150 USDC of WETH locally. The separate 200 USDC reserve remains on Hyperliquid testnet. Open `/strategy`, generate a current proposal for a new demonstration when ready, and approve explicitly. A model `wait` recommendation requires explicit approval of a technical trial. Capture the actual LP hashes, Hyperliquid order IDs, residual exposure, and final close. Uncertain EVM operations require manual receipt inspection; inspect unknown ledger intents before any retry or compensation.

For the controlled recovery segment, follow [the storyboard](DEMO.md): `REPLAY_INITIAL_HEDGE_RATIO=0.8` and `REPLAY_TIMEOUT_AFTER_SEND=1` deliberately discard the confirmed first hedge response. Label the segment as replay, restart the agent to reconcile its existing client order ID, and record that only residual exposure is corrected. Clear both flags for a normal trial. Do not delete the ledger to reproduce recovery.

## ENS user proof

In `/admin`, connect the parent-name owner's Sepolia wallet, configure the real subname, save its v1 endpoint/payout/description, and grant the separate operator only `agentpermit.endpoint`. Check effective permissions: endpoint allowed; payout, description, self-grant, resolver, and registry denied. Read errors must remain inconclusive.

```sh
npm run check:ens
```

Use the running agent's `migrate v2` command, then show `/client` independently rediscovering v2 without a wallet. Revoke endpoint permission in `/admin`; `npm run check:ens -- --revoked` should then report every tested operation denied. Show that an endpoint change is refused, then regrant if needed for the final demo. Record real mined transactions separately from `eth_call` permission simulations. Revocation does not stop the trading process or enforce financial limits.

Use `/admin` → **Export manifest** after the actual flow. Save that browser-generated JSON as `data/evidence/ens-application.json` if it should be included in the public export. The exporter accepts its `chainId`, real `name`, public admin/operator addresses, receipt hash/block/timestamp, and `permissionChecks` (`kind: eth_call`, `checkedAt`, `report`); it excludes arbitrary text and raw errors. Missing receipts are never filled in. This file is distinct from `deployments/sepolia.json`, whose existing protocol-deployment receipts do not prove your application flow.

## Produce reviewable evidence

```sh
npm run check
npm run test:browser
npm run doctor
npm run evidence:export
node scripts/doctor.ts --self-test
node scripts/export-evidence.ts --self-test
```

`evidence:export` has no network access in its implementation and does not load `.env`. It reads the current strategy ledger and its matching real proposal, plus the optional fork check and browser ENS manifest, and writes only the whitelist projection to `docs/evidence/demo.json`. SHA-256 source checksums preserve the identity of the local inputs. Public fields include numeric Graph observations, the actual model selection and evidence IDs, environment labels, persisted intent statuses and external IDs, and available transaction identifiers. Free-text goals/reasons/risks, headers, keys, raw responses, raw signed transactions, and error strings are excluded. Provider captures can be old; exporting them does not refresh them. Ledger confirmations and browser receipts are identified as their source's records, not independent chain re-verification.

Review the JSON and recording before publication. A missing external operation appears in `missingEvidence`; an empty receipt list stays empty. Keep raw `data/`, `.env`, logs and unrelated `heist/` out of the public repository. Exporting creates a local review artifact; it does not commit, push, host a site, upload a video or submit a form. Finish [the submission checklist](SUBMISSION.md).

To export a separately captured proposal without changing the saved execution ledger, use `npm run evidence:export -- --proposal <UUID>` with the actual ID from `data/evidence/proposal-<UUID>.json`. The bundle records both IDs and `proposalContext.matchesExecutionProposal`; it does not imply that the selected capture was approved or executed. The fork check remains a separately labeled artifact. Model evidence IDs use the same duplicate normalization as the proposal producer. A WETH-sale intent with `externalId: "no-weth"` means the executor found no WETH to sell, so no sale transaction exists for that intent.
