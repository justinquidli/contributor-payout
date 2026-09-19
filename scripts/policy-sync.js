#!/usr/bin/env node
process.on('uncaughtException', (e) => { console.error(`\nError: ${e.shortMessage ?? e.message}`); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(`\nError: ${e?.shortMessage ?? e?.message ?? e}`); process.exit(1); });
// Push the per-recipient cap from .env up to Dynamic, so the wallet enforces it.
//   npm run policy:list
//   npm run policy:sync -- USDC BNKR
import { publicClient, resolveToken, toUnits, fromUnits } from '../src/token.js';
import { usdPrice } from '../src/price.js';
import { Bankr } from '../src/bankr.js';
import { Policies, ruleFor, findRule } from '../src/policy.js';

const env = process.env;
const policies = new Policies({ environmentId: env.DYNAMIC_ENVIRONMENT_ID, authToken: env.DYNAMIC_AUTH_TOKEN });
const args = process.argv.slice(2);

if (args[0] === '--list' || args.length === 0) {
  console.log(JSON.stringify(await policies.list(), null, 2));
  process.exit(0);
}

const client = publicClient(env);
const bankr = env.BANKR_API_KEY ? new Bankr({ apiKey: env.BANKR_API_KEY }) : null;
const fundingToken = await resolveToken('USDC', { client, env });
const existing = await policies.list();

for (const spec of args) {
  const token = await resolveToken(spec, { client, env });
  const price = await usdPrice(token, { bankr, fundingToken });

  // The per-transaction ceiling is the per-recipient cap: a single payment can
  // never exceed what one contributor is allowed.
  const perToken = env[`MAX_PER_RECIPIENT_${token.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')}`];
  let human = perToken;
  if (!human) {
    if (!env.MAX_PER_RECIPIENT_USD) throw new Error('set MAX_PER_RECIPIENT_USD (or a per-token cap) in .env');
    if (!price?.usd) throw new Error(`no USD price for ${token.symbol}; set a per-token cap instead`);
    human = (Number(env.MAX_PER_RECIPIENT_USD) / price.usd).toFixed(Math.min(token.decimals, 8)).replace(/\.?0+$/, '');
  }
  const units = toUnits(human, token.decimals);
  const rule = ruleFor(token, units);
  const found = findRule(existing, token);

  if (found?.id) {
    await policies.update([{ ...rule, id: found.id }]);
    console.log(`updated  ${token.symbol}: ≤ ${fromUnits(units, token.decimals)} per transaction (rule ${found.id})`);
  } else {
    await policies.add([rule]);
    console.log(`created  ${token.symbol}: ≤ ${fromUnits(units, token.decimals)} per transaction`);
  }
  if (price) console.log(`         (${env.MAX_PER_RECIPIENT_USD ? `$${env.MAX_PER_RECIPIENT_USD} at $${price.usd}/${token.symbol}` : 'per-token cap from .env'})`);
}

console.log('\nThe wallet now refuses anything above these limits, before signing.');
