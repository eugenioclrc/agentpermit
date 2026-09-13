import { spawn } from 'node:child_process';

const rpc = process.env.ETHEREUM_RPC_URL;
const block = process.env.FORK_BLOCK_NUMBER;
if (!rpc || !/^https?:\/\//.test(rpc)) throw new Error('Set ETHEREUM_RPC_URL in .env.');
if (!block || !/^\d+$/.test(block)) throw new Error('Set a fixed FORK_BLOCK_NUMBER in .env.');

const child = spawn('anvil', ['--fork-url', rpc, '--fork-block-number', block, '--chain-id', '31337', '--host', '127.0.0.1', '--port', '8545'], { stdio: 'inherit' });
child.once('error', error => { throw error; });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.exitCode = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)));
