import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hash } from 'viem';

const file = '.env';
let contents = existsSync(file) ? readFileSync(file, 'utf8') : readFileSync('.env.example', 'utf8');
const existing = parseEnv(contents).AGENT_PRIVATE_KEY;
const key = existing || generatePrivateKey();
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Existing AGENT_PRIVATE_KEY is invalid; it was not overwritten.');
if (!existing) {
  contents = /^AGENT_PRIVATE_KEY=.*$/m.test(contents) ? contents.replace(/^AGENT_PRIVATE_KEY=.*$/m, `AGENT_PRIVATE_KEY=${key}`) : contents + `\nAGENT_PRIVATE_KEY=${key}\n`;
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
}
console.log(`Operator: ${privateKeyToAccount(key as Hash).address}`);
console.log('Private key stays in .env. Fund this separate operator with test ETH on Sepolia.');
