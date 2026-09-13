import type { Hash } from 'viem';
import { endpoints, type Version } from '../shared/status.ts';
import type { Engine } from './engine.ts';
import { permissionDenied } from '../shared/ens.ts';

export type MigrationChain = {
  endpoint: () => Promise<string | null>;
  write: (endpoint: string) => Promise<Hash>;
  receipt: (hash: Hash) => Promise<'success' | 'reverted'>;
};

export async function reconcile(engine: Engine, chain: MigrationChain) {
  const pending = engine.state.pending;
  if (!pending) return 'No pending rotation.';
  const endpoint = await chain.endpoint();
  if (endpoint === endpoints[pending.to]) {
    // Chain is the source of truth, including a crash after broadcast but before saving the hash.
    engine.update(s => {
      s.active = pending.to;
      s.pending = null;
      s.migrations.push({ version: pending.to, hash: pending.hash ?? null, timestamp: Date.now() });
    });
    return `Resolved ${pending.to} on ENS. Previous endpoint retired; ledger preserved.`;
  }
  if (pending.hash && await chain.receipt(pending.hash) === 'reverted') {
    engine.update(s => { s.pending = null; });
    return 'Rotation reverted. Original endpoint remains active.';
  }
  throw new Error('ENS has not confirmed the prepared endpoint. Both endpoints remain available; run reconcile after checking the transaction.');
}

export async function rotate(engine: Engine, target: Version, chain: MigrationChain) {
  if (engine.state.pending) throw new Error('A rotation is pending. Run reconcile first.');
  if (target === engine.state.active) throw new Error(`${target} is already active.`);
  const current = await chain.endpoint();
  if (current !== endpoints[engine.state.active]) throw new Error('ENS endpoint differs from local active version. Align it in admin before rotating.');
  engine.update(s => { s.pending = { from: s.active, to: target }; }); // B is live before publication.
  // Once a send is attempted its outcome may be uncertain. Keep both endpoints if RPC times out.
  let hash: Hash;
  try { hash = await chain.write(endpoints[target]); }
  catch (error) {
    if (permissionDenied(error)) engine.update(s => { s.pending = null; });
    throw error;
  }
  engine.update(s => { s.pending!.hash = hash; });
  if (await chain.receipt(hash) === 'reverted') {
    engine.update(s => { s.pending = null; });
    throw new Error('Endpoint transaction reverted. Original endpoint remains active.');
  }
  return reconcile(engine, chain);
}
