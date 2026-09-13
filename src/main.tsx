import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from 'viem';
import { sepolia } from 'viem/chains';
import {
  SOURCE_COMMIT, address, agentName, contracts, errorText, permissionReport, resolveAgent,
  rpcClient, setPermission, setRecords, setupName,
  type PermissionCheck, type Resolution, type TxRecord,
} from '../shared/ens.ts';
import { API_ORIGIN, FRESH_MS, allowedEndpoint, endpoints, parseStatus, type AgentStatus, type Version } from '../shared/status.ts';
import { parseStrategyStatus, type StrategyState } from '../shared/strategy.ts';
import './style.css';

declare global { interface Window { ethereum?: EIP1193Provider } }
const rpc = rpcClient(import.meta.env.VITE_SEPOLIA_RPC_URL);
const initialName = import.meta.env.VITE_AGENT_NAME || 'delta.your-team.eth';
type Config = { name: string; operator: Address | null; active: Version; pending: unknown; migrations: unknown[] };
const short = (value: string | null | undefined) => value ? `${value.slice(0, 7)}…${value.slice(-5)}` : 'Not set';
const usd = (value: string | null | undefined) => value == null ? '—' : Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const when = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function readLocal<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function writeLocal(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Browser storage is optional; chain remains authoritative. */ } }
async function json(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error(`Local agent HTTP ${response.status}. Start npm run agent or resolve the name again.`);
  const text = await response.text();
  if (text.length > 4_000_000) throw new Error('Agent response exceeds demo size limit.');
  return JSON.parse(text) as unknown;
}
function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  return now;
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
function Arrow() { return <span aria-hidden="true">↗</span>; }

function Portfolio({ status }: { status: AgentStatus | null }) {
  const now = useClock();
  const fresh = !!status?.quote && now - status.quote.timestamp <= FRESH_MS && status.quote.timestamp <= now + 5_000;
  const delta = Number(status?.deltaEth ?? 0);
  return <section className="panel portfolio">
    <div className="panel-heading"><div><span className="eyebrow">THE AGENT AT WORK</span><h2>Delta-neutral monitor</h2></div><span className="tag amber">Paper simulation</span></div>
    <p className="muted">A rules-based agent maintains a spot + synthetic short hedge. Positions and PnL are reported by the local agent.</p>
    <div className="metrics">
      <div><span>Net delta · ETH</span><strong className={Math.abs(delta) > .001 ? 'orange' : 'green'}>{status ? `${delta > 0 ? '+' : ''}${delta.toFixed(4)}` : '—'}</strong><small>{status ? Math.abs(delta) > .001 ? 'Rebalance on next fresh quote' : 'Within ±0.001 ETH target' : 'Waiting for the local agent'}</small></div>
      <div><span>Net paper PnL</span><strong>{usd(status?.netPnl)}</strong><small>After fees and fill slippage</small></div>
      <div><span>ETH / USD reference</span><strong>{usd(status?.quote?.price)}</strong><small><i className={`dot ${fresh ? '' : 'off'}`} />{status?.quote ? `Coinbase · ${Math.max(0, Math.floor((now - status.quote.timestamp) / 1000))}s ago${fresh ? '' : ' · stale'}` : 'No quote available'}</small></div>
    </div>
    <div className="positions">
      {(['spot', 'short'] as const).map(leg => {
        const p = status?.positions.find(p => p.leg === leg);
        return <div key={leg}><span className={`leg-icon ${leg}`}>{leg === 'spot' ? '↗' : '↘'}</span><div><b>{leg === 'spot' ? 'ETH spot' : 'Synthetic ETH short'}</b><small>{leg === 'spot' ? 'Long exposure' : 'Linear hedge · no real orders'}</small></div><div className="position-value"><b>{p ? `${Number(p.quantity) > 0 ? '+' : ''}${Number(p.quantity).toFixed(3)} ETH` : '—'}</b><small>Entry {usd(p?.entryPrice)}</small></div></div>;
      })}
    </div>
    <div className="assumptions"><span>Fee <b>{status?.feeBps ?? 5} bps</b> / fill</span><span>Slippage <b>{status?.slippageBps ?? 10} bps</b> / fill</span><span>Fees paid <b>{usd(status?.fees)}</b></span></div>
    <p className="caption">Both legs use the same price feed. No funding, basis, margin or liquidation model. Delta neutrality does not imply profit. {!fresh && 'Orders pause without a valid quote from the last 30 seconds.'}</p>
    {status?.feedError && <p className="notice warning">Feed unavailable: {status.feedError}</p>}
  </section>;
}
function History({ status }: { status: AgentStatus | null }) {
  const fills = status?.history.slice(-12).reverse() ?? [];
  return <section className="panel"><div className="panel-heading"><h2>Execution journal</h2><span className="muted">{status?.history.length ?? 0} paper fills</span></div>
    {fills.length ? <div className="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Quantity</th><th>Fill price</th><th>Reason</th></tr></thead><tbody>{fills.map(t => <tr key={t.id}><td className="mono">{when(t.timestamp)}</td><td><span className={`tag ${Number(t.quantity) > 0 ? 'mint' : 'gray'}`}>{Number(t.quantity) > 0 ? 'BUY' : 'SELL'} {t.leg}</span></td><td>{t.quantity} ETH</td><td>{usd(t.price)}</td><td className="muted">{t.reason}</td></tr>)}</tbody></table></div> : <div className="empty"><span>⌁</span><b>No paper trades yet</b><p>Type <code>open</code> or <code>partial</code> in the local agent console.</p></div>}
  </section>;
}
function Records({ resolved }: { resolved: Resolution | null }) {
  return <div className="record-list">
    <div><span>Service endpoint</span><code>{resolved?.endpoint || 'Not resolved'}</code></div>
    <div><span>ETH payout record</span>{resolved?.payout ? <a className="mono" href={`https://sepolia.etherscan.io/address/${resolved.payout}`} target="_blank" rel="noreferrer">{short(resolved.payout)} <Arrow /></a> : <span className="muted">Not set</span>}</div>
    <div><span>Resolver</span>{resolved?.resolver ? <a className="mono" href={`https://sepolia.etherscan.io/address/${resolved.resolver}`} target="_blank" rel="noreferrer">{short(resolved.resolver)} <Arrow /></a> : <span className="muted">Not resolved</span>}</div>
    <div><span>Last RPC check</span><span>{resolved ? `${when(resolved.checkedAt)} · block ${resolved.block}` : 'Awaiting resolution'}</span></div>
  </div>;
}

function StrategyResults({ status }: { status: StrategyState | null }) {
  const now = useClock();
  const fresh = !!status?.exposure.fresh && !!status.exposure.updatedAt && now - status.exposure.updatedAt <= FRESH_MS;
  return <section className="panel">
    <div className="panel-heading"><div><span className="eyebrow">CONFIRMED STRATEGY STATE</span><h2>Exposure and results</h2></div><span className={`tag ${fresh ? 'mint' : 'amber'}`}>{fresh ? 'Fresh execution data' : 'Unverified exposure · orders blocked'}</span></div>
    <div className="metrics"><div><span>Net exposure · ETH</span><strong className={fresh && Math.abs(Number(status?.exposure.usd ?? 0)) <= 12 ? 'green' : 'orange'}>{status?.exposure.updatedAt ? Number(status.exposure.eth).toFixed(6) : '—'}</strong><small>{status?.exposure.updatedAt ? `${usd(status.exposure.usd)} · target within $12` : 'No execution snapshot yet'}</small></div>
      <div><span>Fork value change</span><strong>{usd(status?.accounting ? status.costs.forkValueChangeUsdc : null)}</strong><small>Ethereum fork · token balances</small></div>
      <div><span>Testnet value change</span><strong>{usd(status?.accounting?.perpValueChangeUsdc)}</strong><small>Hyperliquid · account value change</small></div></div>
    <div className="market-strip"><span>LP NFT <b>{status?.lp.tokenId ?? '—'}</b></span><span>LP WETH <b>{status?.lp.weth ?? '—'}</b></span><span>Free WETH <b>{status?.lp.freeWeth ?? '—'}</b></span><span>WETH fees <b>{status?.lp.feesWeth ?? '—'}</b></span><span>ETH perp <b>{status?.perp.sizeEth ?? '—'}</b></span><span>LP fees <b>{usd(status?.costs.lpFeesUsdc)}</b></span><span>Perp fees <b>{usd(status?.costs.perpFeesUsdc)}</b></span><span>Funding <b>{usd(status?.costs.fundingUsdc)}</b></span></div>
    <p className="caption">Exposure = LP WETH + free WETH + WETH fees + signed ETH perp. The two environments are separate trials; these figures are not a combined investment return. Perp fees and funding are already included in account value. Fork gas is excluded from token value change.</p>
  </section>;
}

function StrategyPage() {
  const [goal, setGoal] = useState('Use 500 test USDC to create a hedged WETH/USDC position.');
  const [status, setStatus] = useState<StrategyState | null>(null);
  const [token, setToken] = useState('');
  const [technicalTrial, setTechnicalTrial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return; loading = true;
      try {
        const [snapshot, session] = await Promise.all([json(`${API_ORIGIN}/strategy/status`, controller.signal), json(`${API_ORIGIN}/strategy/session`, controller.signal)]);
        const next = parseStrategyStatus(snapshot), nextToken = (session as { token?: unknown }).token;
        if (typeof nextToken !== 'string' || !nextToken) throw new Error('Local session unavailable. Restart the agent.');
        if (!controller.signal.aborted) { setStatus(next); setToken(nextToken); setLoadError(''); }
      } catch (e) { if (!controller.signal.aborted) { setLoadError(errorText(e)); setToken(''); } }
      finally { loading = false; }
    }
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  async function send(path: string, value: object) {
    setBusy(true);
    try {
      const response = await fetch(`${API_ORIGIN}${path}`, { method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'omit',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
      const result = await response.json() as unknown;
      if (!response.ok) throw new Error(typeof (result as { error?: unknown }).error === 'string' ? (result as { error: string }).error : `Agent HTTP ${response.status}`);
      setStatus(parseStrategyStatus(result)); setError('');
      if (path === '/strategy/propose') setTechnicalTrial(false);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const proposal = status?.proposal;
  const canPropose = !status || ['idle', 'proposed', 'closed'].includes(status.phase);
  return <>
    <div className="page-heading"><div><span className="eyebrow">LIVE STRATEGY / FORK + TESTNET</span><h1>Build the hedge, then prove it.</h1><p>AI compares live data. Deterministic code sizes, executes and recovers both legs.</p></div><span className={`phase ${status?.phase ?? 'idle'}`}>{(status?.phase ?? 'offline').replaceAll('_', ' ')}</span></div>
    <section className="panel strategy-compose">
      <div><span className="eyebrow">01 / OBJECTIVE</span><h2>Describe the test position</h2></div>
      <form onSubmit={e => { e.preventDefault(); void send('/strategy/propose', { goal, budget: 500 }); }}>
        <label>Objective<textarea value={goal} maxLength={500} disabled={busy || !canPropose} onChange={e => setGoal(e.target.value)} /></label>
        <label>Test budget<input value="500 USDC" readOnly /></label>
        <button disabled={busy || !token || !canPropose} type="submit">{busy ? 'Working…' : 'Compare pools and propose'} <Arrow /></button>
      </form>
      <p className="caption">The Graph supplies seven complete days for both pools. Hyperliquid mainnet data informs analysis only; execution uses its testnet.</p>
    </section>
    {error && <p className="notice error" role="alert">{error} <button type="button" className="text-button" onClick={() => setError('')}>Dismiss</button></p>}
    {!error && loadError && <p className="notice error" role="alert">{loadError}</p>}
    {!error && !loadError && status?.lastError && ['recovering', 'intervention_required', 'active', 'paused'].includes(status.phase) && <p className="notice warning" role="alert">{status.lastError}</p>}
    {status?.phase === 'recovering' && <p className="notice warning" role="status">An order outcome is uncertain. The agent checks the original order ID before any further adjustment. Exposure is not confirmed until reconciliation succeeds.</p>}
    {proposal && <section className="panel proposal">
      <div className="panel-heading"><div><span className="eyebrow">02 / AI PROPOSAL</span><h2>{proposal.recommendation === 'open' ? 'Open the technical trial' : 'Wait on economic grounds'}</h2></div><span className={`tag ${proposal.recommendation === 'open' ? 'mint' : 'amber'}`}>{proposal.model} · {proposal.recommendation}</span></div>
      <div className="proposal-grid"><div><span>Selected pool</span><strong>USDC / WETH · {(proposal.poolFee / 10_000).toFixed(2)}%</strong></div><div><span>Allocation</span><strong>300 LP / 200 reserve</strong></div><div><span>Range</span><strong>±{proposal.rangePercent}%</strong></div><div><span>Perp</span><strong>ETH isolated · {proposal.leverage}×</strong></div></div>
      <div className="two-col"><div><h3>Reasons</h3><ul>{proposal.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div><div><h3>Risks</h3><ul>{proposal.risks.map(risk => <li key={risk}>{risk}</li>)}</ul></div></div>
      <div className="table-wrap"><table><thead><tr><th>Pool</th><th>TVL</th><th>7d volume</th><th>7d fees</th><th>Indexed block</th></tr></thead><tbody>{proposal.graph.pools.map(pool => <tr key={pool.pool}><td><b>{(pool.fee / 10_000).toFixed(2)}%</b><small className="mono">{short(pool.pool)}</small></td><td>{usd(pool.tvlUsd)}</td><td>{usd(pool.sevenDayVolumeUsd)}</td><td>{usd(pool.sevenDayFeesUsd)}</td><td className="mono">{proposal.graph.block}</td></tr>)}</tbody></table></div>
      <div className="market-strip"><span>HL mainnet mark <b>{usd(proposal.hyperliquid.markPrice)}</b></span><span>Funding <b>{Number(proposal.hyperliquid.fundingRate).toExponential(2)}</b></span><span>±0.5% depth <b>{usd(String(Number(proposal.hyperliquid.bidDepthUsd) + Number(proposal.hyperliquid.askDepthUsd)))}</b></span></div>
      <p className="caption">Analysis captured {new Date(proposal.createdAt).toLocaleString()}. Hyperliquid depth describes ETH perps; it is not Uniswap pool depth. Pool fees are historical totals, not your expected yield.</p>
      <details><summary>Metrics cited by the proposal</summary><ul>{proposal.evidenceIds.map(id => <li key={id}><code>{id}</code></li>)}</ul></details>
      {proposal.recommendation === 'wait' && <label className="check"><input type="checkbox" checked={technicalTrial} onChange={e => setTechnicalTrial(e.target.checked)} /> Run an expressly approved technical trial with test funds</label>}
      <div className="button-row strategy-actions"><button disabled={busy || !token || status?.phase !== 'proposed' || (proposal.recommendation === 'wait' && !technicalTrial)} onClick={() => void send('/strategy/actions', { id: crypto.randomUUID(), action: 'approve', technicalTrial })}>Approve and execute <Arrow /></button>
        <button className="secondary" disabled={busy || !token || status?.phase !== 'active'} onClick={() => void send('/strategy/actions', { id: crypto.randomUUID(), action: 'pause' })}>Pause</button>
        <button className="secondary" disabled={busy || !token || status?.phase !== 'paused'} onClick={() => void send('/strategy/actions', { id: crypto.randomUUID(), action: 'resume' })}>Resume</button>
        <button className="secondary danger" disabled={busy || !token || !status || !['active', 'paused', 'intervention_required'].includes(status.phase)} onClick={() => void send('/strategy/actions', { id: crypto.randomUUID(), action: 'close' })}>Close both legs</button></div>
    </section>}
    <div className="two-col strategy-legs">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ETHEREUM MAINNET FORK</span><h2>Uniswap V3 LP</h2></div><span className={`tag ${status?.lp.status === 'open' ? 'mint' : 'gray'}`}>{status?.lp.status ?? 'offline'}</span></div>
        <div className="leg-metrics"><div><span>NFT</span><b>{status?.lp.tokenId ?? '—'}</b></div><div><span>Liquidity</span><b>{status?.lp.liquidity ?? '0'}</b></div><div><span>WETH + fees</span><b>{Number(status?.lp.weth ?? 0).toFixed(6)} + {Number(status?.lp.feesWeth ?? 0).toFixed(6)}</b></div><div><span>USDC + fees</span><b>{Number(status?.lp.usdc ?? 0).toFixed(2)} + {Number(status?.lp.feesUsdc ?? 0).toFixed(2)}</b></div></div>
        <p className="caption">Chain 31337 · fork block {status?.fork.blockNumber ?? 'not started'} · official Position Manager.</p></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">HYPERLIQUID TESTNET</span><h2>ETH perpetual hedge</h2></div><span className={`tag ${status?.perp.status === 'open' ? 'mint' : 'gray'}`}>{status?.perp.status ?? 'offline'}</span></div>
        <div className="leg-metrics"><div><span>Position</span><b>{Number(status?.perp.sizeEth ?? 0).toFixed(6)} ETH</b></div><div><span>Mark</span><b>{usd(status?.perp.markPrice)}</b></div><div><span>Margin</span><b>{usd(status?.perp.marginUsd)}</b></div><div><span>Liquidation</span><b>{usd(status?.perp.liquidationPrice)}</b></div></div>
        <p className="caption">ETH discovered from metadata · isolated 1× · account {short(status?.perpEnvironment.account)}.</p>{status?.perpEnvironment.replay && <p className="notice warning">{status.perpEnvironment.replay}. Testnet execution only; not performance evidence.</p>}</section>
    </div>
    <StrategyResults status={status} />
    <section className="panel"><div className="panel-heading"><h2>Execution evidence</h2><button className="secondary" disabled={!status} onClick={() => download({ kind: 'agentpermit-local-strategy', exportedAt: new Date().toISOString(), state: status }, 'agentpermit-strategy-evidence.json')}>Export strategy evidence ↓</button></div><p className="caption">Fork hashes are local Anvil transactions. Hyperliquid IDs are testnet orders. The export contains no session token or private keys.</p>
      {status?.chainTransactions?.length ? <div className="table-wrap"><table><thead><tr><th>Operation</th><th>State</th><th>Fork transaction hash</th></tr></thead><tbody>{status.chainTransactions.map(tx => <tr key={tx.hash}><td>{tx.operation}</td><td>{tx.status}</td><td className="mono">{tx.hash}</td></tr>)}</tbody></table></div> : <p className="muted">No fork transaction recorded in this strategy yet.</p>}
    </section>
    <section className="panel"><div className="panel-heading"><h2>Operation ledger</h2><span className="muted">{status?.intents.length ?? 0} persisted intents</span></div>{status?.intents.length ? <div className="table-wrap"><table><thead><tr><th>Intent</th><th>Kind</th><th>Status</th><th>Client order ID</th><th>External ID</th><th>Requested</th></tr></thead><tbody>{status.intents.slice().reverse().map(intent => <tr key={intent.id}><td className="mono">{intent.id}</td><td>{intent.kind}</td><td><span className={`tag ${intent.status === 'confirmed' ? 'mint' : intent.status === 'unknown' ? 'amber' : 'gray'}`}>{intent.status}</span></td><td className="mono">{intent.cloid ?? '—'}</td><td className="mono">{intent.externalId ?? '—'}</td><td>{intent.requestedEth ? `${intent.requestedEth} ETH` : '—'}</td></tr>)}</tbody></table></div> : <p className="muted">No live operation has been prepared.</p>}</section>
  </>;
}
function Admin() {
  const [name, setName] = useState(initialName);
  const [operator, setOperator] = useState('');
  const [payout, setPayout] = useState('');
  const [description, setDescription] = useState('A paper delta-neutral agent with scoped ENS permissions.');
  const [endpoint, setEndpoint] = useState<string>(endpoints.v1);
  const [account, setAccount] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [resolved, setResolved] = useState<Resolution | null>(null);
  const [report, setReport] = useState<PermissionCheck[]>([]);
  const [reportAt, setReportAt] = useState(0);
  const [receipts, setReceipts] = useState<TxRecord[]>(() => readLocal('agentpermit.receipts', []));
  const [message, setMessage] = useState('Connect your admin wallet to configure ENS on Sepolia.');
  const [error, setError] = useState('');
  const [localError, setLocalError] = useState('');
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    async function load() {
      if (loading) return; loading = true;
      try {
        const c = await json(`${API_ORIGIN}/config`, controller.signal) as Config;
        if (!c || typeof c.name !== 'string' || !['v1', 'v2'].includes(c.active)) throw new Error('Invalid local config.');
        const next = parseStatus(await json(endpoints[c.active], controller.signal), c.name);
        if (controller.signal.aborted) return;
        setConfig(c); setStatus(next); setLocalError('');
        if (!seeded.current) { seeded.current = true; setName(c.name); if (c.operator) setOperator(c.operator); setEndpoint(endpoints[c.active]); }
      } catch (e) { if (!controller.signal.aborted) setLocalError(errorText(e)); }
      finally { loading = false; }
    }
    void load(); const timer = setInterval(() => void load(), 5_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => {
    const provider = window.ethereum;
    const changed = () => { setAccount(null); setWallet(null); setReport([]); setMessage('Wallet account or network changed. Reconnect before writing.'); };
    provider?.on?.('accountsChanged', changed); provider?.on?.('chainChanged', changed);
    return () => { provider?.removeListener?.('accountsChanged', changed); provider?.removeListener?.('chainChanged', changed); };
  }, []);
  function progress(text: string, record?: TxRecord) {
    setMessage(text);
    if (record) setReceipts(old => { const next = [...old.filter(r => r.hash !== record.hash), record]; writeLocal('agentpermit.receipts', next); return next; });
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function connect() {
    if (!window.ethereum) throw new Error('No injected wallet detected. Open this local app in a browser with your wallet extension.');
    const next = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) });
    await next.switchChain({ id: sepolia.id });
    const [admin] = await next.requestAddresses();
    if (!admin) throw new Error('Wallet returned no account.');
    setWallet(next); setAccount(admin); if (!payout) setPayout(admin); setMessage('Admin connected on Sepolia.');
  }
  function signer() {
    if (!wallet || !account) throw new Error('Connect the admin wallet first.');
    return { wallet, account };
  }
  async function check() {
    const identity = agentName(name), agent = address(operator);
    setMessage('Resolving ENS and simulating the operator’s effective permissions…');
    const next = await resolveAgent(rpc, identity);
    const checks = await permissionReport(rpc, identity, agent);
    setResolved(next); setReport(checks); setReportAt(Date.now());
    setMessage('Permission checks complete. These are RPC simulations; no transaction was sent.');
  }
  const restricted = report.length > 0 && report.filter(r => r.key !== 'endpoint').every(r => r.allowed === false);
  return <>
    <div className="page-heading"><div><span className="eyebrow">WORKSPACE / PERMISSION CONTROL</span><h1>Autonomy, with boundaries.</h1><p>Give your agent the access it needs. Keep ownership in your hands.</p></div><button onClick={() => void run(connect)} disabled={busy} className="dark-button">{account ? short(account) : 'Connect admin wallet'} <Arrow /></button></div>
    <div className="identity-strip"><span className="agent-icon">δ</span><div><b>{name}</b><span>Delta-neutral agent <i>·</i> Rule-based execution</span></div><span className="tag amber">Paper simulation</span><a href="/client" className="client-link">Open independent client <Arrow /></a></div>
    {localError && <p className="notice warning">Local agent unavailable. Run <code>npm run agent</code> in a second terminal. {status && 'Metrics below are the last received snapshot.'}</p>}
    <div className="two-col">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">01 / IDENTITY</span><h2>Configure your agent</h2></div><span className="tag gray">Sepolia</span></div>
        <label>Agent ENS name<input value={name} disabled={busy} onChange={e => { setName(e.target.value); setResolved(null); setReport([]); }} placeholder="delta.your-team.eth" spellCheck={false} /></label>
        <p className="caption">Own the parent .eth name first on <a href="https://app.ens.dev" target="_blank" rel="noreferrer">ENS Sepolia <Arrow /></a>. Setup registers the subname to your admin.</p>
        <button className="secondary full" disabled={busy || !account} onClick={() => void run(async () => {
          const s = signer(), identity = agentName(name), key = `agentpermit.setup.${identity}.${s.account}`;
          const saved = readLocal<{ resolver?: Address; registry?: Address }>(key, {});
          await setupName(rpc, s.wallet, s.account, identity, saved, (kind, value) => { saved[kind] = value; writeLocal(key, saved); }, progress);
          setResolved(await resolveAgent(rpc, identity)); setMessage('Subname is ready. Configure its records next.');
        })}>Set up ENS identity <Arrow /></button>
        <div className="form-divider" />
        <label>Service endpoint<select value={endpoint} disabled={busy} onChange={e => setEndpoint(e.target.value)}><option value={endpoints.v1}>v1 · 127.0.0.1:4318/agent/v1/status</option><option value={endpoints.v2}>v2 · 127.0.0.1:4318/agent/v2/status</option></select></label>
        <label>ETH payout record<input value={payout} disabled={busy} onChange={e => setPayout(e.target.value)} placeholder="0x… admin-controlled address" spellCheck={false} /></label>
        <label>Description<input value={description} maxLength={280} disabled={busy} onChange={e => setDescription(e.target.value)} /></label>
        <button className="secondary full" disabled={busy || !account} onClick={() => void run(async () => {
          const s = signer(); setResolved(await setRecords(rpc, s.wallet, s.account, name, endpoint, address(payout), description, progress)); setMessage('Records confirmed and read back from ENS.');
        })}>Save ENS records <Arrow /></button>
      </section>
      <section className="panel permission-panel"><div className="panel-heading"><div><span className="eyebrow">02 / DELEGATION</span><h2>One agent. One permission.</h2></div><span className="scope-symbol">⊙</span></div>
        <label>Operator wallet<input value={operator} disabled={busy} onChange={e => { setOperator(e.target.value); setReport([]); }} placeholder="Public address from npm run keygen" spellCheck={false} /></label>
        <p className="caption">Separate from your admin. Its private key stays in the local agent process.</p>
        <div className="grant-callout"><span className="dot" /><div><b>Update service endpoint</b><code>agentpermit.endpoint</code></div><span className="tag mint">Single record</span></div>
        <div className="button-row"><button disabled={busy || !account || !operator} onClick={() => void run(async () => {
          const s = signer(); setReport(await setPermission(rpc, s.wallet, s.account, name, address(operator), true, progress)); setReportAt(Date.now()); setMessage('Endpoint permission granted and effective access checked.');
        })}>Grant permission</button><button className="secondary danger" disabled={busy || !account || !operator} onClick={() => void run(async () => {
          const s = signer(); setReport(await setPermission(rpc, s.wallet, s.account, name, address(operator), false, progress)); setReportAt(Date.now()); setMessage('Endpoint permission revoked. The paper engine continues running.');
        })}>Revoke</button></div>
        <div className="permission-title"><h3>Effective operator access</h3><button className="text-button" disabled={busy || !operator} onClick={() => void run(check)}>Check access ↻</button></div>
        <div className="access-list">{(report.length ? report : [
          ['endpoint', 'Update endpoint'], ['payout', 'Change payout'], ['description', 'Change description'], ['grant', 'Grant itself more roles'], ['resolver', 'Change resolver'], ['registry', 'Change subregistry'],
        ].map(([key, label]) => ({ key: key!, label: label!, allowed: null, detail: 'Run Check access against Sepolia.' }))).map(r => <div key={r.key} title={r.detail}><span>{r.label}</span><span className={`access ${r.allowed === null ? 'unknown' : r.allowed ? 'allowed' : 'denied'}`}>{r.allowed === null ? report.length ? 'Inconclusive' : 'Unchecked' : r.allowed ? 'Allowed' : 'Denied'}</span></div>)}</div>
        {!!report.length && <p className={`caption ${restricted ? '' : 'orange'}`}>{restricted ? 'Protected operations rejected by ENSv2.' : 'Some protected operations are allowed or inconclusive. Review before demonstrating.'} Checked {when(reportAt)} via eth_call. Hover a result for details.</p>}
        {!!report.length && <details className="caption"><summary>Inspect RPC results</summary>{report.map(r => <p key={r.key}><b>{r.label}:</b> {r.detail}</p>)}</details>}
        <p className="caption">Revocation affects future endpoint writes. It does not stop the agent, reverse earlier updates or control funds.</p>
      </section>
    </div>
    <div className="notice" role="status" aria-live="polite">{busy && <span className="spinner" />}{message}</div>
    {error && <p className="notice error" role="alert">{error}</p>}
    <Portfolio status={status} />
    <div className="two-col"><section className="panel"><div className="panel-heading"><h2>ENS records</h2><button className="text-button" disabled={busy} onClick={() => void run(async () => { setResolved(await resolveAgent(rpc, name)); setMessage('ENS records refreshed.'); })}>Refresh ↻</button></div><Records resolved={resolved} /></section>
      <section className="panel console-guide"><span className="eyebrow">03 / LIVE DEMO</span><h2>Run it from your terminal.</h2><div className="terminal"><span>agentpermit&gt; <b>partial</b></span><span className="terminal-comment"># next quote restores the hedge</span><span>agentpermit&gt; <b>migrate v2</b></span><span className="terminal-comment"># ENS updates, client discovers v2</span></div><p className="caption">Both versions share the same ledger. {config?.pending ? 'A rotation is pending; run reconcile.' : `Local active endpoint: ${config?.active ?? 'unavailable'}.`}</p></section></div>
    <History status={status} />
    <section className="panel"><div className="panel-heading"><div><h2>Transaction evidence</h2><p className="caption">Only mined receipts from this browser. Permission simulations are listed separately above.</p></div><button className="secondary" onClick={() => download({ chainId: sepolia.id, sourceCommit: SOURCE_COMMIT, contracts, name, admin: account, operator, resolved, receipts, permissionChecks: { kind: 'eth_call', checkedAt: reportAt, report }, migrations: config?.migrations ?? [] }, 'agentpermit-deployment.json')}>Export manifest ↓</button></div>
      {receipts.length ? <div className="receipt-list">{receipts.slice().reverse().map(r => <div key={r.hash}><span className="tag mint">Confirmed</span><b>{r.action}</b><a className="mono" href={`https://sepolia.etherscan.io/tx/${r.hash}`} target="_blank" rel="noreferrer">{short(r.hash)} <Arrow /></a></div>)}</div> : <p className="muted">No transactions confirmed yet. Setup, record changes and grants will appear here.</p>}
    </section>
  </>;
}

function Client() {
  const [input, setInput] = useState(initialName);
  const [name, setName] = useState('');
  const [resolved, setResolved] = useState<Resolution | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [strategy, setStrategy] = useState<StrategyState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!name) return;
    const controller = new AbortController();
    let inFlight = false;
    async function load() {
      if (inFlight) return; inFlight = true; setBusy(true);
      try {
        const next = await resolveAgent(rpc, name);
        if (controller.signal.aborted) return;
        setResolved(next);
        if (!next.endpoint) throw new Error('No agentpermit.endpoint record found. Configure it in admin.');
        const url = allowedEndpoint(next.endpoint);
        const payload = await json(url, controller.signal);
        const nextStatus = parseStatus(payload, next.name);
        const live = (payload as { strategy?: unknown }).strategy;
        const nextStrategy = live ? parseStrategyStatus(live) : null;
        if (nextStrategy && nextStrategy.name !== next.name) throw new Error('Live strategy belongs to a different ENS identity.');
        if (url !== endpoints[nextStatus.version]) throw new Error('Agent version differs from the resolved endpoint.');
        if (controller.signal.aborted) return;
        setStatus(nextStatus); setStrategy(nextStrategy); setError('');
      } catch (e) { if (!controller.signal.aborted) { setError(errorText(e)); setStatus(null); setStrategy(null); } }
      finally { if (!controller.signal.aborted) setBusy(false); inFlight = false; }
    }
    void load(); const timer = setInterval(() => void load(), 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [name, refresh]);
  return <>
    <div className="page-heading"><div><span className="eyebrow">INDEPENDENT CLIENT / ENS DISCOVERY</span><h1>A name that follows the agent.</h1><p>Resolve the service from ENS. Discover endpoint changes without reconnecting a wallet.</p></div><span className="tag mint">No wallet required</span></div>
    <section className="panel discovery"><form onSubmit={e => { e.preventDefault(); try { const next = agentName(input); setName(next); setResolved(null); setStatus(null); setStrategy(null); setRefresh(r => r + 1); setError(''); } catch (err) { setError(errorText(err)); } }}><label>Agent ENS name<input value={input} onChange={e => setInput(e.target.value)} placeholder="delta.your-team.eth" spellCheck={false} /></label><button type="submit">Resolve agent <Arrow /></button></form><p className="caption">Independent Sepolia RPC resolution every 10 seconds. Only the two local demo endpoints are accepted.</p></section>
    {error && <p className="notice error" role="alert">{error}</p>}
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ONCHAIN IDENTITY</span><h2>{name || 'Waiting for an ENS name'}</h2></div><div className="button-row"><span className={`tag ${status ? 'mint' : 'gray'}`}>{busy ? 'Resolving…' : status ? `Connected · ${status.version}` : 'Not connected'}</span><button className="text-button" disabled={!name || busy} onClick={() => setRefresh(r => r + 1)}>Refresh ↻</button></div></div><Records resolved={resolved} /><p className="caption">ENS records come from Sepolia. The metrics below come from the resolved service and are not attested by ENS.</p></section>
    {strategy ? <><div className="panel-heading"><h2>ENS-discovered live strategy</h2><span className="tag">{strategy.phase.replaceAll('_', ' ')}</span></div><StrategyResults status={strategy} /><details><summary>Legacy paper simulation</summary><Portfolio status={status} /><History status={status} /></details></> : <><Portfolio status={status} /><History status={status} /></>}
  </>;
}

function App() {
  const page = location.pathname === '/client' ? 'client' : location.pathname === '/strategy' ? 'strategy' : 'admin';
  return <div className="app"><aside className="sidebar"><a href="/strategy" className="brand"><span className="brand-mark">a<span>p</span></span>AgentPermit<span className="beta">BETA</span></a><div className="nav-label">CONTROL CENTER</div><nav aria-label="Main navigation"><a href="/strategy" aria-current={page === 'strategy' ? 'page' : undefined}><span>δ</span>Delta strategy</a><a href="/admin" aria-current={page === 'admin' ? 'page' : undefined}><span>⊞</span>ENS workspace</a><a href="/client" aria-current={page === 'client' ? 'page' : undefined}><span>◎</span>Independent client</a></nav><div className="sidebar-note"><div className="orb">⊙</div><h3>Scoped autonomy.</h3><p>AI proposes.<br />Deterministic code executes.</p><a href="https://docs.ens.domains/ensv2/permissioned-resolver/" target="_blank" rel="noreferrer">Discovered with ENSv2 <Arrow /></a></div><div className="network"><i className="dot" /><div><b>Local multi-environment demo</b><small>Fork · HL testnet · Sepolia</small></div></div></aside><main><header className="topbar"><span>ETHOnline 2026 <span className="slash">/</span> AgentPermit</span><span className="top-tag">LOCAL DEMO <span>↗</span></span></header><div className="content">{page === 'client' ? <Client /> : page === 'strategy' ? <StrategyPage /> : <Admin />}<footer><span>AgentPermit · delta-neutral executor</span><span>Fork and testnet funds only. Neutrality does not guarantee profit.</span></footer></div></main></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
