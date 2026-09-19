// Acquire the reward token when the agent's wallet is short of it.
//
//   agent wallet --funding token--> Bankr wallet --swap--> reward token --> agent wallet
//
// Nothing is assumed: the run ends by watching the agent wallet's own balance
// rise past what the payout needs. A swap that "succeeded" but never landed
// does not count.
import { randomUUID } from 'node:crypto';
import { fromUnits, toUnits, balanceOf } from './token.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * deps: { bankr, client, sendFunding(token, to, units) -> txHash, log }
 * Returns { acquired: bigint, steps: [...] }.
 */
export async function acquire({ rewardToken, fundingToken, needUnits, agentAddress }, deps) {
  const log = deps.log ?? console.log;
  const { bankr, client } = deps;
  const steps = [];

  const before = await balanceOf(rewardToken, agentAddress, client);
  const shortfall = needUnits - before;
  if (shortfall <= 0n) return { acquired: 0n, steps, already: true };

  const needHuman = fromUnits(shortfall, rewardToken.decimals);
  log(`Short ${needHuman} ${rewardToken.symbol}. Acquiring via Bankr…`);

  // 1. What does that cost? Price with a probe, then quote the real size.
  const fundingHeld = await balanceOf(fundingToken, agentAddress, client);
  if (fundingHeld === 0n) throw new Error(`no ${fundingToken.symbol} in the agent wallet to fund the swap`);

  const probeHuman = fromUnits(fundingHeld / 10n || fundingHeld, fundingToken.decimals);
  const probe = await bankr.quote({ fromToken: fundingToken.address, toToken: rewardToken.address, amount: probeHuman });
  const probeIn = Number(probe.from.formattedAmount);
  const probeOut = Number(probe.to.formattedAmount);
  if (!(probeOut > 0)) throw new Error(`no liquidity quote for ${fundingToken.symbol} → ${rewardToken.symbol}`);

  const rate = probeOut / probeIn; // reward per funding
  const buffer = Number(process.env.SWAP_BUFFER ?? 1.1); // headroom for price move + fees
  const spendHuman = trim((Number(needHuman) / rate) * buffer, fundingToken.decimals);
  const spendUnits = toUnits(spendHuman, fundingToken.decimals);
  if (spendUnits > fundingHeld) {
    throw new Error(
      `need about ${spendHuman} ${fundingToken.symbol} to buy ${needHuman} ${rewardToken.symbol}, ` +
        `wallet holds ${fromUnits(fundingHeld, fundingToken.decimals)}`,
    );
  }
  log(`  ~${rate.toPrecision(6)} ${rewardToken.symbol} per ${fundingToken.symbol}; spending ${spendHuman} ${fundingToken.symbol}`);

  // 2. Fund the Bankr wallet from the agent wallet.
  const treasury = await bankr.address();
  log(`  funding Bankr wallet ${treasury}…`);
  const fundTx = await deps.sendFunding(fundingToken, treasury, spendUnits);
  steps.push({ step: 'fund', txHash: fundTx, amount: spendHuman, token: fundingToken.symbol });

  // 3. Swap there.
  const quote = await bankr.quote({ fromToken: fundingToken.address, toToken: rewardToken.address, amount: spendHuman });
  log(`  swapping (min ${quote.minBuyAmount} ${rewardToken.symbol})…`);
  const swap = await bankr.swap({
    fromToken: fundingToken.address,
    toToken: rewardToken.address,
    amount: spendHuman,
    minBuyAmount: quote.minBuyAmount,
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  if (!swap.success) throw new Error(`swap reverted on-chain (${swap.hash}) — nothing exchanged`);
  // Size everything from the exact integer amount, never the float: a float
  // round-trip invents digits and can ask for more than the wallet holds.
  const receivedUnits = BigInt(swap.amountReceivedRaw ?? toUnits(trim(Number(swap.amountReceived), rewardToken.decimals), rewardToken.decimals));
  const received = fromUnits(receivedUnits, rewardToken.decimals);
  steps.push({ step: 'swap', txHash: swap.hash, received, token: rewardToken.symbol });
  log(`  swapped: ${received} ${rewardToken.symbol} (${swap.hash})`);

  // 4. Send it back to the agent wallet — exactly what arrived.
  const sendBack = received;
  log(`  returning ${sendBack} ${rewardToken.symbol} to ${agentAddress}…`);
  // The tokens are already ours and sitting in the Bankr wallet: a rejected
  // transfer here is usually a pre-flight simulation failing against a wallet
  // that is briefly busy, not a permanent error. Retry before giving up, and
  // say plainly where the funds are if every attempt fails.
  const back = await returnWithRetry({ bankr, rewardToken, agentAddress, sendBack, log });
  steps.push({ step: 'return', txHash: back.txHash, amount: sendBack, token: rewardToken.symbol });

  // 5. Believe the balance, not the receipts.
  const landed = await waitForBalance({ token: rewardToken, owner: agentAddress, atLeast: needUnits, client, log });
  return { acquired: landed - before, balance: landed, steps };
}

async function waitForBalance({ token, owner, atLeast, client, log, attempts = 40, delayMs = 3000 }) {
  for (let i = 0; i < attempts; i++) {
    const bal = await balanceOf(token, owner, client);
    if (bal >= atLeast) {
      log(`  wallet now holds ${fromUnits(bal, token.decimals)} ${token.symbol}`);
      return bal;
    }
    await sleep(delayMs);
  }
  const bal = await balanceOf(token, owner, client);
  throw new Error(
    `${token.symbol} never landed: wallet holds ${fromUnits(bal, token.decimals)}, needs ${fromUnits(atLeast, token.decimals)}`,
  );
}

/** Decimal string with at most `decimals` places, rounded down. */
export function trim(n, decimals) {
  const f = Math.max(0, Math.min(decimals, 18));
  const s = n.toFixed(f);
  return s.replace(/\.?0+$/, '') || '0';
}

async function returnWithRetry({ bankr, rewardToken, agentAddress, sendBack, log, attempts = 4, delayMs = 8000 }) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await bankr.transfer({ tokenAddress: rewardToken.address, recipientAddress: agentAddress, amount: sendBack });
    } catch (e) {
      lastError = e;
      if (i === attempts) break;
      log(`  return attempt ${i}/${attempts} rejected (${e.message.slice(0, 80)}…), retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `could not return ${sendBack} ${rewardToken.symbol} to the agent wallet after ${attempts} attempts: ${lastError.message}. ` +
      `The tokens are safe in the Bankr wallet — send them to ${agentAddress} and re-run. No one was paid.`,
  );
}
