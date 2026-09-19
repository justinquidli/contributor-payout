const API = 'https://api.github.com';
const MAX_PRS = 50;

function headers(token) {
  const h = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'contributor-payout',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

async function gh(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers(token), ...init.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.message ?? 'error'}`);
  return body;
}

export function isBot(user) {
  return !user || user.type === 'Bot' || /\[bot\]$/i.test(user.login);
}

/** Merged PRs in `repo` ("owner/name") merged at or after `since` (Date). */
export async function fetchMergedPRs(repo, since, token) {
  const out = [];
  for (let page = 1; page <= 10 && out.length < MAX_PRS; page++) {
    const list = await gh(
      `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50&page=${page}`,
      token,
    );
    if (list.length === 0) break;
    for (const pr of list) {
      if (!pr.merged_at || new Date(pr.merged_at) < since) continue;
      if (isBot(pr.user)) continue;
      out.push(pr);
    }
    // Sorted by updated desc: once a whole page is older than `since`, stop.
    if (new Date(list[list.length - 1].updated_at) < since) break;
  }

  const detailed = [];
  for (const pr of out.slice(0, MAX_PRS)) {
    const d = await gh(`/repos/${repo}/pulls/${pr.number}`, token);
    detailed.push({
      number: d.number,
      url: d.html_url,
      author: d.user.login,
      title: d.title,
      body: (d.body ?? '').slice(0, 2000),
      mergedAt: d.merged_at,
      additions: d.additions,
      deletions: d.deletions,
      changedFiles: d.changed_files,
    });
  }
  return detailed;
}

export async function commentOnPR(repo, number, text, token) {
  return gh(`/repos/${repo}/issues/${number}/comments`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: text }),
  });
}
