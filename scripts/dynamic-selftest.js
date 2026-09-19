#!/usr/bin/env node
process.on('uncaughtException', (e) => { console.error(`\nError: ${e.shortMessage ?? e.message}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`\nError: ${e?.shortMessage ?? e?.message ?? e}`); process.exit(1); });
// Prove the Dynamic wallet can sign and send before any real payout.
//   npm run dynamic:selftest -- 0xRecipient [amount] [TOKEN]   (default 0.05 USDC)
import { dynamicPayer } from '../src/payers/dynamic.js';
import { publicClient, resolveToken, toUnits, fromUnits } from '../src/token.js';

const args = process.argv.slice(2);
// --force skips our own balance check so the WALLET gets the say: used to
// show a Dynamic policy refusing an over-cap payment before it is signed.
const force = args.includes('--force');
const [to, amount = '0.05', symbol = 'USDC'] = args.filter((a) => a !== '--force');
if (!/^0x[0-9a-fA-F]{40}$/.test(to ?? '')) {
  console.error('usage: npm run dynamic:selftest -- 0xRecipientAddress [amount] [TOKEN] [--force]');
  process.exit(2);
}

const client = publicClient(process.env);
const token = await resolveToken(symbol, { client, env: process.env });
const payer = await dynamicPayer(token, process.env);
const info = await payer.describe();
console.log(`Wallet ${info.wallet}: ${fromUnits(info.tokenUnits, token.decimals)} ${token.symbol}, ${Number(info.ethWei) / 1e18} ETH`);

const units = toUnits(amount, token.decimals);
if (info.tokenUnits < units && !force) throw new Error(`not enough ${token.symbol} in the Dynamic wallet (--force to ask the wallet anyway)`);
if (info.ethWei === 0n) throw new Error('no ETH for gas in the Dynamic wallet');

console.log(`Sending ${amount} ${token.symbol} to ${to}…`);
const { txHashes } = await payer.pay([{ address: to, units }], 'selftest');
for (const h of txHashes) console.log(`https://basescan.org/tx/${h}`);
console.log('Signing works.');
