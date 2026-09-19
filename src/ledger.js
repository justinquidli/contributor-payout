import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

// Local record of what was paid, so a PR is never rewarded twice and a
// crashed run is never silently re-sent with a new idempotency key.

export class Ledger {
  constructor(path = 'ledger.json') {
    this.path = path;
    this.data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { runs: [] };
  }

  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  paidPRs(repo) {
    const set = new Set();
    for (const r of this.data.runs) {
      if (r.repo !== repo) continue;
      // A payment with a tx hash counts as paid even if its run was later cleared.
      for (const p of r.payments) if (r.status !== 'failed' || p.txHash) p.prs.forEach((n) => set.add(n));
    }
    return set;
  }

  pendingRun(repo) {
    return this.data.runs.find((r) => r.repo === repo && r.status === 'pending');
  }

  start(run) {
    this.data.runs.push({ ...run, status: 'pending', startedAt: new Date().toISOString() });
    this.save();
  }

  finish(id, fields) {
    const r = this.data.runs.find((x) => x.id === id);
    Object.assign(r, fields, { finishedAt: new Date().toISOString() });
    this.save();
  }
}
