const API = 'https://api.github.com';
const MAX_PRS = 50;
// Per-PR diff caps. Most merged PRs carry only a few hundred characters of
// patch, so these rarely bite; they exist so one large refactor cannot crowd
// everything else out of the model's context.
const MAX_FILES_PER_PR = 20;
const MAX_PATCH_CHARS = 2000;

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


/**
 * Filenames and patches for one PR, trimmed to the caps above.
 *
 * GitHub omits `patch` for binary and very large files; the filename and the
 * add/delete counts still say what changed, which is enough to judge it.
 *
 * A failure here degrades to no diff rather than aborting the round: the PR is
 * still scored on its title, body and size, exactly as it was before.
 */
async function fetchPRFiles(repo, number, token) {
  let list;
  try {
    list = await gh(`/repos/${repo}/pulls/${number}/files?per_page=100`, token);
  } catch (err) {
    return { files: [], omittedFiles: 0, filesError: String(err.message ?? err) };
  }
  const files = list.slice(0, MAX_FILES_PER_PR).map((f) => {
    const patch = f.patch ?? '';
    return {
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch:
        patch.length > MAX_PATCH_CHARS
          ? `${patch.slice(0, MAX_PATCH_CHARS)}\n...[patch truncated]`
          : patch,
    };
  });
  return { files, omittedFiles: Math.max(0, list.length - MAX_FILES_PER_PR) };
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
    const { files, omittedFiles, filesError } = await fetchPRFiles(repo, pr.number, token);
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
      files,
      omittedFiles,
      ...(filesError ? { filesError } : {}),
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
