#!/usr/bin/env node
process.on('uncaughtException', (e) => { console.error(`\nError: ${e.shortMessage ?? e.message}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`\nError: ${e?.shortMessage ?? e?.message ?? e}`); process.exit(1); });
// Acquire a reward token through Bankr, on its own — no PRs, no payouts.
//   npm run treasury:acquire -- BNKR 1000 [--fund-with USDC]
import { parseArgs } from 'node:util';
import { publicClient, resolveToken, toUnits, fromUnits } from '../src/token.js';
import { Bankr } from '../src/bankr.js';
import { acquire } from '../src/treasury.js';
import { dynamicPayer } from '../src/payers/dynamic.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'fund-with': { type: 'string', default: 'USDC' } },
});
const [symbol, amount] = positionals;
if (!symbol || !amount) {
  console.error('usage: npm run treasury:acquire -- <TOKEN|0x…> <amount> [--fund-with USDC]');
  process.exit(2);
}

const env = process.env;
const client = publicClient(env);
const rewardToken = await resolveToken(symbol, { client, env });
const fundingToken = await resolveToken(values['fund-with'], { client, env });
const payer = await dynamicPayer(rewardToken, env);

console.log(`${rewardToken.symbol} ${rewardToken.address} (${rewardToken.decimals} decimals)`);
const result = await acquire(
  {
    rewardToken,
    fundingToken,
    needUnits: toUnits(amount, rewardToken.decimals),
    agentAddress: payer.address,
  },
  {
    bankr: new Bankr({ apiKey: env.BANKR_API_KEY }),
    client,
    sendFunding: (tok, to, units) => payer.sendToken(tok, to, units),
  },
);

if (result.already) {
  console.log('Wallet already holds enough — nothing to do.');
} else {
  console.log(`\nAcquired ${fromUnits(result.acquired, rewardToken.decimals)} ${rewardToken.symbol}`);
  for (const s of result.steps) console.log(`  ${s.step}: https://basescan.org/tx/${s.txHash}`);
}
