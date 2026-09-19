#!/usr/bin/env node
process.on('uncaughtException', (e) => { console.error(`\nError: ${e.shortMessage ?? e.message}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`\nError: ${e?.shortMessage ?? e?.message ?? e}`); process.exit(1); });
// One-time: create the agent's Dynamic server wallet on EVM (works on Base).
//   npm run dynamic:setup
import { existsSync, writeFileSync } from 'node:fs';
import { dynamicClient, WALLET_FILE, SHARES_FILE } from '../src/dynamic.js';

if (existsSync(WALLET_FILE)) {
  console.log(`${WALLET_FILE} already exists — not creating another wallet.`);
  process.exit(0);
}
// DYNAMIC_BACKUP=false keeps the key share only in dynamic-shares.json
// (use if Dynamic's backup service errors). Lose that file = lose the wallet.
const backUpToDynamic = process.env.DYNAMIC_BACKUP !== 'false';
const password = process.env.WALLET_PASSWORD;
if (backUpToDynamic && (!password || password.length < 16)) {
  console.error('Set WALLET_PASSWORD in .env (16+ characters). It is needed for every signature.');
  process.exit(1);
}

const { ThresholdSignatureScheme } = await import('@dynamic-labs-wallet/core');
const client = await dynamicClient();

console.log(`Creating wallet (backup to Dynamic: ${backUpToDynamic})…`);
const { walletMetadata, externalServerKeyShares } = await client.createWalletAccount({
  thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
  ...(backUpToDynamic ? { password } : {}),
  backUpToDynamic,
  onError: (e) => console.error('keygen error:', e.message),
});

writeFileSync(WALLET_FILE, JSON.stringify(walletMetadata, null, 2));
writeFileSync(SHARES_FILE, JSON.stringify(externalServerKeyShares), { mode: 0o600 });

console.log(`\nAgent wallet: ${walletMetadata.accountAddress}`);
console.log(`Saved ${WALLET_FILE} (needed to sign — losing it means the wallet can't sign)`);
console.log(`Saved ${SHARES_FILE} (secret key share, chmod 600, git-ignored)`);
if (!backUpToDynamic) console.log(`  ⚠ No Dynamic backup: copy ${SHARES_FILE} and ${WALLET_FILE} somewhere safe now.`);
console.log('\nFund it on Base with a little USDC and ETH for gas, then run:');
console.log('  npm run payout -- --payer dynamic --repo … --budget …');
