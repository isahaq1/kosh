/**
 * Git proposals (RFC 0012 §5.3): in propose mode, a Studio change can be pushed as a branch with a pull request
 * (GitHub) or a merge request (GitLab) instead of being downloaded as a patch. The repository is
 * `KOSH_STUDIO_GIT_URL` (`https://github.com/acme/erp`), the token `KOSH_STUDIO_GIT_TOKEN` (from the environment or
 * the secret manager that fills it; never stored by Kosh), the base branch `KOSH_STUDIO_GIT_BASE` (default `main`).
 * The provider is read from the host (`gitlab` in it: GitLab) unless `KOSH_STUDIO_GIT_PROVIDER` says otherwise;
 * `KOSH_STUDIO_GIT_API` points at a self-hosted API.
 */

export type GitProvider = 'github' | 'gitlab';

export interface GitConfig {
  readonly provider: GitProvider;
  /** `owner/repo` (GitHub) or `group/subgroup/project` (GitLab). */
  readonly repository: string;
  /** The REST API's root: `https://api.github.com`, `https://gitlab.example.com/api/v4`. */
  readonly api: string;
  readonly token: string;
  readonly base: string;
  /** For tests: the HTTP client (default: the global `fetch`). */
  readonly fetch?: typeof fetch;
}

/** One file of a proposal: its new content (the whole file, UTF-8). */
export interface ProposedFile {
  readonly path: string;
  readonly content: string;
}

export interface Proposal {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly files: readonly ProposedFile[];
}

export interface ProposalResult {
  readonly url: string;
  readonly branch: string;
}

export class GitProposalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitProposalError';
  }
}

/** The git settings from the environment; null when no repository is configured. */
export function gitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitConfig | null {
  const url = env['KOSH_STUDIO_GIT_URL'];
  const token = env['KOSH_STUDIO_GIT_TOKEN'];
  if (url === undefined || url === '' || token === undefined || token === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const repository = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!repository.includes('/')) return null;
  const named = env['KOSH_STUDIO_GIT_PROVIDER'];
  const provider: GitProvider =
    named === 'github' || named === 'gitlab'
      ? named
      : parsed.hostname.includes('gitlab')
        ? 'gitlab'
        : 'github';
  const api =
    env['KOSH_STUDIO_GIT_API'] ??
    (provider === 'gitlab'
      ? `${parsed.origin}/api/v4`
      : parsed.hostname === 'github.com'
        ? 'https://api.github.com'
        : `${parsed.origin}/api/v3`);
  return {
    provider,
    repository,
    api: api.replace(/\/$/, ''),
    token,
    base: env['KOSH_STUDIO_GIT_BASE'] ?? 'main',
  };
}

type Call = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown }>;

function caller(config: GitConfig): Call {
  const http = config.fetch ?? fetch;
  return async (method, path, body) => {
    const res = await http(`${config.api}${path}`, {
      method,
      headers: {
        ...(config.provider === 'github'
          ? {
              authorization: `Bearer ${config.token}`,
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2022-11-28',
            }
          : { 'private-token': config.token }),
        'user-agent': 'kosh-studio',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
}

const ok = (status: number) => status >= 200 && status < 300;
const failure = (what: string, r: { status: number; json: unknown }): GitProposalError => {
  const message =
    typeof r.json === 'object' && r.json !== null && 'message' in r.json
      ? String((r.json as { message: unknown }).message)
      : String(r.json ?? '');
  return new GitProposalError(`${what}: ${r.status} ${message}`.trim(), r.status);
};
const path = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function github(config: GitConfig, proposal: Proposal): Promise<ProposalResult> {
  const call = caller(config);
  const repo = `/repos/${path(config.repository)}`;
  const base = await call('GET', `${repo}/git/ref/heads/${path(config.base)}`);
  if (!ok(base.status)) throw failure(`The base branch ${config.base}`, base);
  const sha = (base.json as { object?: { sha?: string } }).object?.sha;
  // A branch of that name may exist (an earlier proposal of the same version): take a fresh one.
  let branch = proposal.branch;
  let created = await call('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (created.status === 422) {
    branch = `${proposal.branch}-${Date.now().toString(36)}`;
    created = await call('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  if (!ok(created.status)) throw failure(`The branch ${branch}`, created);
  for (const file of proposal.files) {
    const existing = await call(
      'GET',
      `${repo}/contents/${path(file.path)}?ref=${encodeURIComponent(branch)}`,
    );
    const fileSha = ok(existing.status) ? (existing.json as { sha?: string }).sha : undefined;
    const put = await call('PUT', `${repo}/contents/${path(file.path)}`, {
      message: `${proposal.title}: ${file.path}`,
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      branch,
      ...(fileSha === undefined ? {} : { sha: fileSha }),
    });
    if (!ok(put.status)) throw failure(file.path, put);
  }
  const pull = await call('POST', `${repo}/pulls`, {
    title: proposal.title,
    head: branch,
    base: config.base,
    body: proposal.body,
  });
  if (!ok(pull.status)) throw failure('The pull request', pull);
  return { url: String((pull.json as { html_url?: string }).html_url ?? ''), branch };
}

async function gitlab(config: GitConfig, proposal: Proposal): Promise<ProposalResult> {
  const call = caller(config);
  const project = `/projects/${encodeURIComponent(config.repository)}`;
  const actions: { action: string; file_path: string; content: string }[] = [];
  for (const file of proposal.files) {
    const existing = await call(
      'GET',
      `${project}/repository/files/${encodeURIComponent(file.path)}?ref=${encodeURIComponent(config.base)}`,
    );
    actions.push({
      action: ok(existing.status) ? 'update' : 'create',
      file_path: file.path,
      content: file.content,
    });
  }
  let branch = proposal.branch;
  const commit = (name: string) =>
    call('POST', `${project}/repository/commits`, {
      branch: name,
      start_branch: config.base,
      commit_message: proposal.title,
      actions,
    });
  let committed = await commit(branch);
  if (committed.status === 400 && /already exists/i.test(JSON.stringify(committed.json))) {
    branch = `${proposal.branch}-${Date.now().toString(36)}`;
    committed = await commit(branch);
  }
  if (!ok(committed.status)) throw failure(`The branch ${branch}`, committed);
  const merge = await call('POST', `${project}/merge_requests`, {
    source_branch: branch,
    target_branch: config.base,
    title: proposal.title,
    description: proposal.body,
  });
  if (!ok(merge.status)) throw failure('The merge request', merge);
  return { url: String((merge.json as { web_url?: string }).web_url ?? ''), branch };
}

/** Pushes the proposal's files on a new branch and opens the pull / merge request. */
export function proposeOnGit(config: GitConfig, proposal: Proposal): Promise<ProposalResult> {
  return config.provider === 'gitlab' ? gitlab(config, proposal) : github(config, proposal);
}
