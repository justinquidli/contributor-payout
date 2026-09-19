#!/usr/bin/env node
// Pay contributors for merged PRs.
//
//   npm run payout -- --repo Quidli/connect-mcp --since 7d --budget 3            (dry run)
//   npm run payout -- --repo Quidli/connect-mcp --since 7d --budget 3 --execute  (sends USDC)

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { fetchMergedPRs, commentOnPR } from './src/github.js';
import { Connect } from './src/connect.js';
import { proposePlan } from './src/decide.js';
import { Ledger } from './src/ledger.js';
import { writeRound, shareTable } from './src/round.js';
import { connectPayer } from './src/payers/connect.js';
import { checkPlan } from './src/rails.js';
import { publicClient, resolveToken, capsFor, fromUnits, BASE_USDC } from './src/token.js';
import { Bankr } from './src/bankr.js';
import { usdPrice } from './src/price.js';
import { acquire } from './src/treasury.js';

const EXPLORER = 'https://basescan.org/tx/';

export function parseSince(s) {
  const m = /^(\d+)d$/.exec(s ?? '');
  if (m) return new Date(Date.now() - Number(m[1]) * 86_400_000);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`--since must be like 7d or an ISO date (got ${s})`);
  return d;
}

export async function run(opts, deps) {
  const log = deps.log ?? console.log;
  const { repo, budget } = opts;
  const token = deps.payer.token;
  const sym = token.symbol;
  const show = (units) => `${fromUnits(units, token.decimals)} ${sym}`;
  const limits = {
    budget,
    maxBudget: opts.maxBudget,
    maxPerRecipient: opts.maxPerRecipient,
    minPerRecipient: opts.minPerRecipient,
    decimals: token.decimals,
    symbol: sym,
  };

  const pending = deps.ledger.pendingRun(repo);
  if (pending) {
    throw new Error(
      `run ${pending.id} for ${repo} never finished (idempotencyKey ${pending.idempotencyKey}). ` +
        `Check the wallet on Basescan, then re-run with --clear-pending.`,
    );
  }

  const exclude = opts.exclude;
  const alreadyPaid = deps.ledger.paidPRs(repo);
  const all = await deps.fetchPRs(repo, opts.since);
  const prs = all.filter(
    (p) => !alreadyPaid.has(p.number) && !exclude.map((e) => e.toLowerCase()).includes(p.author.toLowerCase()),
  );

  log(`\n${repo}: ${all.length} merged PR(s) since ${opts.since.toISOString().slice(0, 10)}, ${prs.length} eligible`);
  for (const p of prs) log(`  #${p.number} @${p.author} +${p.additions}/-${p.deletions}  ${p.title}`);
  if (prs.length === 0) return { status: 'nothing-to-pay' };

  log(`\nAsking the agent to split ${budget} ${sym}…`);
  let plan = await deps.propose(prs, limits);
  if (plan.summary) log(`Agent: ${plan.summary}`);
  for (const p of plan.payments ?? []) log(`  @${p.github}: ${p.amount} ${sym} — ${p.reason}`);

  let check = checkPlan(plan, prs, limits, { exclude, alreadyPaid });

  // One correction pass: the rails tell the agent exactly what was wrong.
  if (!check.ok && deps.propose.length >= 3) {
    log('\nRails rejected that plan:');
    for (const v of check.violations) log(`  ✗ ${v}`);
    log('Asking the agent to correct it…');
    const retry = await deps.propose(prs, limits, { violations: check.violations, previous: plan });
    const recheck = checkPlan(retry, prs, limits, { exclude, alreadyPaid });
    if (recheck.ok) {
      plan = retry;
      check = recheck;
      if (plan.summary) log(`Agent: ${plan.summary}`);
      for (const p of plan.payments ?? []) log(`  @${p.github}: ${p.amount} ${sym} — ${p.reason}`);
    } else {
      check = recheck;
    }
  }

  if (!check.ok) {
    log('\nREJECTED by rails — nothing sent:');
    for (const v of check.violations) log(`  ✗ ${v}`);
    return { status: 'rejected', violations: check.violations, plan };
  }
  const toPay = check.payments.filter((p) => p.units > 0n);
  if (toPay.length === 0) {
    log('\nNothing to pay: every contributor was allocated 0. No transaction was made.');
    return { status: 'nothing-to-pay', plan };
  }
  log(`\nRails passed: ${toPay.length} payment(s), total ${show(check.total)}`);

  // Shares, not just amounts: this round's split is a distribution, and the
  // same table becomes a token allocation when a project launches one.
  log('');
  for (const line of shareTable(toPay, check.total, token)) log(`  ${line}`);

  // Resolving provisions a wallet for anyone who doesn't have one, so a
  // simulation of someone else's repo shouldn't do it.
  if (opts.skipResolve && !opts.execute) {
    log('Skipping Connect resolution (--skip-resolve): no wallets provisioned.');
  } else {
    log('Resolving GitHub usernames via Connect…');
    const addresses = await deps.resolve(toPay.map((p) => p.github));
    for (const p of toPay) {
      p.address = addresses.get(p.github.toLowerCase());
      if (!p.address) throw new Error(`Connect returned no Base wallet for @${p.github}`);
      log(`  @${p.github} → ${p.address}`);
    }
  }

  const wallet = await deps.payer.describe();
  log(`Payer (${deps.payer.name}) ${wallet.wallet}: ${show(wallet.tokenUnits)}, ${Number(wallet.ethWei) / 1e18} ETH`);
  if (wallet.ethWei === 0n) throw new Error('payer has no ETH for gas on Base');

  const short = check.total - wallet.tokenUnits;
  if (short > 0n && !deps.acquire) {
    throw new Error(`payer has ${show(wallet.tokenUnits)}, needs ${show(check.total)}`);
  }

  if (!opts.execute) {
    if (short > 0n) log(`Would acquire ${show(short)} via the treasury before paying.`);
    const file = writeRound({ round: opts.round, repo, token, payments: toPay, total: check.total, status: 'proposed', summary: plan.summary });
    log(`\nRound written to ${file} (proposed).`);
    log('Dry run — re-run with --execute to send.');
    return { status: 'dry-run', payments: toPay, plan, shortfall: short > 0n ? short : 0n, round: file };
  }
  if (!opts.yes && !(await deps.confirm(`Send ${show(check.total)} to ${toPay.length} contributor(s)? Type "send": `))) {
    log('Cancelled.');
    return { status: 'cancelled' };
  }

  if (short > 0n) {
    const got = await deps.acquire({ needUnits: check.total, agentAddress: wallet.wallet });
    log(`Acquired ${show(got.acquired)}.`);
  }

  const id = randomUUID();
  const idempotencyKey = randomUUID();
  const record = toPay.map(({ github, address, amount, prs: nums, reason }) => ({ github, address, amount, prs: nums, reason }));
  deps.ledger.start({ id, repo, idempotencyKey, payer: deps.payer.name, payments: record });

  let result;
  try {
    result = await deps.payer.pay(toPay, idempotencyKey, {
      onSent: (i, hash) => {
        record[i].txHash = hash;
        deps.ledger.finish(id, { status: 'pending', payments: record });
      },
    });
  } catch (e) {
    // Leave it pending: the transfer may or may not have gone through.
    log(`\nSend failed or timed out: ${e.message}`);
    throw e;
  }
  deps.ledger.finish(id, { status: 'sent', txHashes: result.txHashes, payments: record });

  const roundFile = writeRound({
    round: opts.round, repo, token, payments: toPay, total: check.total,
    status: 'paid', summary: plan.summary, txHashes: result.txHashes, record,
  });

  log('\nSent.');
  for (const h of result.txHashes) log(`  ${EXPLORER}${h}`);
  log(`Round recorded in ${roundFile}`);

  if (opts.comment && deps.comment) {
    for (const [i, p] of toPay.entries()) {
      const tx = record[i].txHash ?? result.txHashes[0];
      const text = `🎉 Thanks @${p.github}! The payout agent sent you **${p.amount} ${sym}** on Base for this contribution.\n\n> ${p.reason}\n\n${tx ? `Tx: ${EXPLORER}${tx}\n\n` : ''}Paid to your GitHub username via [Quidli Connect](https://connect.quid.li).`;
      for (const n of p.prs) {
        try {
          await deps.comment(repo, n, text);
        } catch (e) {
          log(`  (couldn't comment on #${n}: ${e.message})`);
        }
      }
    }
  }
  return { status: 'sent', txHashes: result.txHashes, payments: toPay };
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      since: { type: 'string', default: '7d' },
      budget: { type: 'string' },
      exclude: { type: 'string', default: '' },
      execute: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      comment: { type: 'boolean', default: false },
      'plan-file': { type: 'string' },
      ledger: { type: 'string', default: 'ledger.json' },
      'clear-pending': { type: 'boolean', default: false },
      payer: { type: 'string', default: 'connect' },
      round: { type: 'string' },
      'skip-resolve': { type: 'boolean', default: false },
      token: { type: 'string', default: 'USDC' },
      'fund-with': { type: 'string', default: 'USDC' },
    },
  });
  if (!['connect', 'dynamic'].includes(values.payer)) {
    console.error('--payer must be connect or dynamic');
    process.exit(2);
  }
  if (!values.repo || !values.budget) {
    console.error('usage: payout --repo owner/name --budget 3 [--since 7d] [--exclude a,b] [--payer connect|dynamic] [--token SYM|0x…] [--round label] [--skip-resolve] [--execute] [--comment]');
    process.exit(2);
  }

  const env = process.env;
  const ledger = new Ledger(values.ledger);
  if (values['clear-pending']) {
    const p = ledger.pendingRun(values.repo);
    if (p) ledger.finish(p.id, { status: 'failed', note: 'cleared manually after checking the wallet' });
  }

  const connect = new Connect({ apiKey: env.CONNECT_API_KEY, baseUrl: env.CONNECT_API_BASE_URL });
  const llm = { baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL };

  // Reward token is named on the command line — never chosen by the model.
  const client = publicClient(env);
  const candidates = await connect.balances({ address: BASE_USDC }).then((b) => b.assets).catch(() => []);
  const token = await resolveToken(values.token, { client, env, candidates });
  const fundingToken = await resolveToken(values['fund-with'], { client, env, candidates });
  const bankr = env.BANKR_API_KEY ? new Bankr({ apiKey: env.BANKR_API_KEY }) : null;
  const price = await usdPrice(token, { bankr, fundingToken });
  const caps = capsFor(token, env, price);
  console.log(`Reward token: ${token.symbol} ${token.address} (${token.decimals} decimals)`);
  if (price) console.log(`Price: $${price.usd} per ${token.symbol} (${price.source})`);
  console.log(`Caps: budget ≤ ${caps.maxBudget}, per recipient ≤ ${caps.maxPerRecipient}, min ${caps.minPerRecipient} — ${caps.basis}`);

  const opts = {
    repo: values.repo,
    since: parseSince(values.since),
    budget: values.budget,
    exclude: values.exclude.split(',').map((s) => s.trim()).filter(Boolean),
    execute: values.execute,
    yes: values.yes,
    comment: values.comment,
    round: values.round,
    skipResolve: values['skip-resolve'],
    maxBudget: caps.maxBudget,
    maxPerRecipient: caps.maxPerRecipient,
    minPerRecipient: caps.minPerRecipient,
  };

  const deps = {
    ledger,
    fetchPRs: (repo, since) => fetchMergedPRs(repo, since, env.GITHUB_TOKEN),
    propose: values['plan-file']
      ? async () => planFrom(JSON.parse(readFileSync(values['plan-file'], 'utf8')))
      : (prs, limits, retry) => proposePlan(prs, limits, llm, retry),
    resolve: (names) => connect.resolveGithub(names),
    payer:
      values.payer === 'dynamic'
        ? await (await import('./src/payers/dynamic.js')).dynamicPayer(token, env)
        : connectPayer(connect, token),
    comment: (repo, n, text) => commentOnPR(repo, n, text, env.GITHUB_TOKEN),
    confirm: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(q);
      rl.close();
      return a.trim() === 'send';
    },
  };

  if (bankr) {
    deps.acquire = ({ needUnits, agentAddress }) =>
      acquire(
        { rewardToken: token, fundingToken, needUnits, agentAddress },
        { bankr, client, sendFunding: (tok, to, units) => deps.payer.sendToken(tok, to, units) },
      );
  }

  await run(opts, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\nError: ${e.message}`);
    process.exit(1);
  });
}

/**
 * A plan file is either a raw plan ({payments:[…]}) or a round written by an
 * earlier dry run ({contributors:[…]}). Accepting the round matters: it lets a
 * proposal that was published somewhere — a chat, a PR comment — be the exact
 * thing that gets paid, instead of asking the model again and hoping it agrees
 * with itself.
 */
export function planFrom(file) {
  if (Array.isArray(file?.payments)) return file;
  if (Array.isArray(file?.contributors)) {
    return {
      payments: file.contributors.map((c) => ({ github: c.github, amount: c.amount, reason: c.reason })),
      summary: file.summary,
    };
  }
  throw new Error('plan file has neither payments[] nor contributors[]');
}
