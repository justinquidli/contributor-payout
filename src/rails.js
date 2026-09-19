// Hard limits enforced in code. The model proposes; these decide.
// Amounts are in the reward token's own units — see src/token.js.
import { toUnits, fromUnits } from './token.js';

/**
 * Validate a model-proposed plan against the PRs we actually fetched.
 * Returns { ok, payments, violations }. Any violation rejects the whole plan.
 *
 * limits: { budget, maxBudget, maxPerRecipient, minPerRecipient, decimals }
 */
export function checkPlan(plan, prs, limits, { exclude = [], alreadyPaid = new Set() } = {}) {
  const violations = [];
  const d = limits.decimals ?? 6;
  const units = (v) => toUnits(v, d);
  const show = (u) => fromUnits(u, d);
  const budget = units(limits.budget);
  const maxBudget = units(limits.maxBudget);
  const maxPer = units(limits.maxPerRecipient);
  const minPer = units(limits.minPerRecipient);

  if (budget > maxBudget) violations.push(`budget ${show(budget)} exceeds hard cap ${show(maxBudget)}`);

  const excluded = new Set(exclude.map((u) => u.toLowerCase()));
  const prsByAuthor = new Map();
  for (const pr of prs) {
    if (alreadyPaid.has(pr.number)) continue;
    const a = pr.author.toLowerCase();
    if (!prsByAuthor.has(a)) prsByAuthor.set(a, []);
    prsByAuthor.get(a).push(pr.number);
  }

  if (!plan || !Array.isArray(plan.payments)) {
    return { ok: false, payments: [], violations: ['plan has no payments array'] };
  }

  // The model may return one entry per PR. Entries for the same contributor are
  // summed, then the caps are applied to that contributor's total.
  const byUser = new Map();
  let total = 0n;

  for (const p of plan.payments) {
    const who = String(p?.github ?? '').trim().replace(/^@/, '');
    const key = who.toLowerCase();
    let amountUnits;
    try {
      amountUnits = units(p?.amount);
    } catch (e) {
      violations.push(`${who || '(unnamed)'}: ${e.message}`);
      continue;
    }

    if (!prsByAuthor.has(key)) {
      violations.push(`${who || '(unnamed)'} is not the author of any unpaid merged PR in this window`);
      continue;
    }
    if (excluded.has(key)) {
      violations.push(`${who} is excluded from payouts`);
      continue;
    }
    const entry = byUser.get(key) ?? { github: who, units: 0n, reasons: [], prs: prsByAuthor.get(key) };
    entry.units += amountUnits;
    if (p?.reason) entry.reasons.push(String(p.reason));
    byUser.set(key, entry);
  }

  const payments = [];
  for (const entry of byUser.values()) {
    const { github: who, units: u } = entry;
    if (u === 0n) continue; // model chose to pay nothing — allowed
    if (u < minPer) violations.push(`${who}: ${show(u)} is below minimum ${show(minPer)}`);
    if (u > maxPer) violations.push(`${who}: ${show(u)} exceeds per-recipient cap ${show(maxPer)}`);
    total += u;
    payments.push({ github: who, units: u, amount: show(u), prs: entry.prs, reason: entry.reasons.join(' ') });
  }

  if (total > budget) violations.push(`total ${show(total)} exceeds budget ${show(budget)}`);

  return { ok: violations.length === 0, payments, total, violations };
}

export { toUnits, fromUnits };
