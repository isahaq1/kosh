/**
 * Git proposals (RFC 0012 §5.3): the settings from the environment, and a proposal on a fake GitHub (a branch from
 * the base, every file created or updated, a pull request; a taken branch name gets a fresh one) and a fake GitLab
 * (one commit with create / update actions, a merge request); a refusal says what was refused.
 */
import { expect, test } from 'vitest';
import { GitProposalError, gitConfigFromEnv, proposeOnGit } from '../src/index.js';

type Seen = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** A fetch answering from `routes` (`METHOD path` → status and JSON), recording every call. */
function fake(routes: (method: string, path: string, body: unknown) => [number, unknown]) {
  const seen: Seen[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    seen.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const [status, json] = routes(method, new URL(url).pathname + new URL(url).search, body);
    return new Response(json === null ? '' : JSON.stringify(json), { status });
  }) as typeof fetch;
  return { http, seen };
}

const proposal = {
  branch: 'studio/acme-0.1.1',
  title: 'Studio: Acme 0.1.1',
  body: 'A Kosh Studio change.',
  files: [
    { path: 'src/modules/acme/studio.json', content: '{"name":"acme"}\n' },
    { path: 'src/modules.ts', content: 'export const modules = [base, acme];\n' },
  ],
};

test('the settings come from the environment; without a URL or a token there are none', () => {
  expect(gitConfigFromEnv({})).toBeNull();
  expect(gitConfigFromEnv({ KOSH_STUDIO_GIT_URL: 'https://github.com/acme/erp' })).toBeNull();
  expect(
    gitConfigFromEnv({
      KOSH_STUDIO_GIT_URL: 'https://github.com/acme/erp.git',
      KOSH_STUDIO_GIT_TOKEN: 't',
    }),
  ).toEqual({
    provider: 'github',
    repository: 'acme/erp',
    api: 'https://api.github.com',
    token: 't',
    base: 'main',
  });
  expect(
    gitConfigFromEnv({
      KOSH_STUDIO_GIT_URL: 'https://gitlab.example.com/acme/tools/erp',
      KOSH_STUDIO_GIT_TOKEN: 't',
      KOSH_STUDIO_GIT_BASE: 'develop',
    }),
  ).toMatchObject({
    provider: 'gitlab',
    repository: 'acme/tools/erp',
    api: 'https://gitlab.example.com/api/v4',
    base: 'develop',
  });
  expect(
    gitConfigFromEnv({
      KOSH_STUDIO_GIT_URL: 'https://git.acme.test/acme/erp',
      KOSH_STUDIO_GIT_TOKEN: 't',
    })?.api,
  ).toBe('https://git.acme.test/api/v3'); // GitHub Enterprise
});

test('GitHub: a branch from the base, the files created or updated, a pull request', async () => {
  let refs = 0;
  const { http, seen } = fake((method, path, body) => {
    if (method === 'GET' && path === '/repos/acme/erp/git/ref/heads/main')
      return [200, { object: { sha: 'base-sha' } }];
    if (method === 'POST' && path === '/repos/acme/erp/git/refs') {
      refs += 1;
      return refs === 1 ? [422, { message: 'Reference already exists' }] : [201, {}];
    }
    if (method === 'GET' && path.startsWith('/repos/acme/erp/contents/src/modules.ts'))
      return [200, { sha: 'old-sha' }];
    if (method === 'GET' && path.startsWith('/repos/acme/erp/contents/'))
      return [404, { message: 'Not Found' }];
    if (method === 'PUT' && path.startsWith('/repos/acme/erp/contents/')) return [201, {}];
    if (method === 'POST' && path === '/repos/acme/erp/pulls')
      return [
        201,
        { html_url: `https://github.com/acme/erp/pull/7`, head: (body as { head: string }).head },
      ];
    return [500, { message: `unexpected ${method} ${path}` }];
  });
  const config = gitConfigFromEnv({
    KOSH_STUDIO_GIT_URL: 'https://github.com/acme/erp',
    KOSH_STUDIO_GIT_TOKEN: 'ghp_x',
  });
  if (config === null) throw new Error('configured');
  const result = await proposeOnGit({ ...config, fetch: http }, proposal);
  expect(result.url).toBe('https://github.com/acme/erp/pull/7');
  expect(result.branch).toMatch(/^studio\/acme-0\.1\.1-[a-z0-9]+$/); // the first name was taken
  expect(seen[0]?.headers['authorization']).toBe('Bearer ghp_x');
  const puts = seen.filter((s) => s.method === 'PUT');
  expect(puts.map((p) => [new URL(p.url).pathname, (p.body as { sha?: string }).sha])).toEqual([
    ['/repos/acme/erp/contents/src/modules/acme/studio.json', undefined],
    ['/repos/acme/erp/contents/src/modules.ts', 'old-sha'],
  ]);
  expect(
    Buffer.from(
      (puts[1]?.body as { content: string } | undefined)?.content ?? '',
      'base64',
    ).toString(),
  ).toBe('export const modules = [base, acme];\n');
  expect(seen.at(-1)?.body).toEqual({
    title: 'Studio: Acme 0.1.1',
    head: result.branch,
    base: 'main',
    body: 'A Kosh Studio change.',
  });
});

test('GitLab: one commit of create / update actions on a new branch, a merge request', async () => {
  const { http, seen } = fake((method, path) => {
    if (method === 'GET' && path.includes('/repository/files/src%2Fmodules.ts')) return [200, {}];
    if (method === 'GET' && path.includes('/repository/files/'))
      return [404, { message: '404 File Not Found' }];
    if (method === 'POST' && path.endsWith('/repository/commits')) return [201, { id: 'c1' }];
    if (method === 'POST' && path.endsWith('/merge_requests'))
      return [201, { web_url: 'https://gitlab.example.com/acme/erp/-/merge_requests/3' }];
    return [500, { message: `unexpected ${method} ${path}` }];
  });
  const config = gitConfigFromEnv({
    KOSH_STUDIO_GIT_URL: 'https://gitlab.example.com/acme/erp',
    KOSH_STUDIO_GIT_TOKEN: 'glpat-x',
  });
  if (config === null) throw new Error('configured');
  const result = await proposeOnGit({ ...config, fetch: http }, proposal);
  expect(result).toEqual({
    url: 'https://gitlab.example.com/acme/erp/-/merge_requests/3',
    branch: 'studio/acme-0.1.1',
  });
  expect(seen[0]?.headers['private-token']).toBe('glpat-x');
  const commit = seen.find((s) => s.url.endsWith('/repository/commits'));
  expect(new URL(commit?.url ?? 'http://x').pathname).toBe(
    '/api/v4/projects/acme%2Ferp/repository/commits',
  );
  expect(commit?.body).toMatchObject({
    branch: 'studio/acme-0.1.1',
    start_branch: 'main',
    actions: [
      { action: 'create', file_path: 'src/modules/acme/studio.json' },
      { action: 'update', file_path: 'src/modules.ts' },
    ],
  });
});

test('a refusal says what was refused', async () => {
  const { http } = fake(() => [401, { message: 'Bad credentials' }]);
  const config = gitConfigFromEnv({
    KOSH_STUDIO_GIT_URL: 'https://github.com/acme/erp',
    KOSH_STUDIO_GIT_TOKEN: 'bad',
  });
  if (config === null) throw new Error('configured');
  const failed = proposeOnGit({ ...config, fetch: http }, proposal);
  await expect(failed).rejects.toBeInstanceOf(GitProposalError);
  await expect(failed).rejects.toThrow('The base branch main: 401 Bad credentials');
});
