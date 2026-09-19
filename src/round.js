// A round is one scoring window: who contributed, what share of it they earned,
// and what they were paid. Today the share is used to split a reward budget.
// The same table is what a token distribution needs, so every run records one.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromUnits } from './token.js';

const DIR = 'rounds';

/** Share in basis points — integer maths, no floats in the record. */
export function shareBps(units, total) {
  if (total === 0n) return 0;
  return Number((BigInt(units) * 10_000n) / BigInt(total));
}

export const pct = (bps) => `${(bps / 100).toFixed(2)}%`;

export function shareTable(payments, total, token) {
  const width = Math.max(...payments.map((p) => p.github.length));
  const sorted = [...payments].sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0));
  return sorted.map((p) => {
    const bps = shareBps(p.units, total);
    const bar = '█'.repeat(Math.max(1, Math.round(bps / 250))); // 40 chars = 100%
    return `@${p.github.padEnd(width)}  ${pct(bps).padStart(7)}  ${fromUnits(p.units, token.decimals)} ${token.symbol}  ${bar}`;
  });
}

export function defaultLabel(repo) {
  return `${repo.replace('/', '-')}-${new Date().toISOString().slice(0, 10)}`;
}

/** Write rounds/<label>.json. Returns the path. */
export function writeRound({ round, repo, token, payments, total, status, summary, txHashes = [], record = [] }) {
  const label = round || defaultLabel(repo);
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${label}.json`);
  const byGithub = new Map(record.map((r) => [r.github, r]));

  writeFileSync(
    path,
    JSON.stringify(
      {
        round: label,
        repo,
        status, // proposed | paid
        at: new Date().toISOString(),
        token: { symbol: token.symbol, address: token.address, decimals: token.decimals },
        total: fromUnits(total, token.decimals),
        summary,
        contributors: [...payments]
          .sort((a, b) => (b.units > a.units ? 1 : b.units < a.units ? -1 : 0))
          .map((p) => ({
          github: p.github,
          wallet: p.address,
          shareBps: shareBps(p.units, total),
          share: pct(shareBps(p.units, total)),
          amount: fromUnits(p.units, token.decimals),
          prs: p.prs,
          reason: p.reason,
          txHash: byGithub.get(p.github)?.txHash,
        })),
        txHashes,
      },
      null,
      2,
    ),
  );
  return path;
}
