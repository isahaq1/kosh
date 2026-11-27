/**
 * Knowledge on real PostgreSQL (RFC 0038, step 7): an article for everyone, for its members or for its owner
 * alone is read and written by exactly those; an article is never wider than the one it is inside; a link is
 * made only to a record one may read, and seen only with its article; search finds the title and the text, and
 * only what one may read; who may hand an article to someone else.
 */
import { snippetOf } from '@kosh/knowledge';
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { knowledge } from '../src/index.js';

const A = '/api/v1/models/knowledge.article';
const L = '/api/v1/models/knowledge.link';
let erp: TestInstallation;
const ids: Record<string, number> = {};
const users: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  body?: unknown,
) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (as: string, values: Record<string, unknown>) => {
  const made = await call('POST', A, as, values);
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.id as number;
};
const seen = async (as: string) =>
  ((await call('GET', `${A}?order=id+asc&limit=100`, as)).json.items as Json[]).map((a) => a.name);
const found = async (as: string, q: string) =>
  (await call('GET', `/api/v1/knowledge/search?q=${encodeURIComponent(q)}`, as)).json;

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [knowledge],
    users: {
      kim: ['knowledge.manager', 'contacts.user'],
      ana: ['knowledge.user', 'contacts.user'],
      ben: ['knowledge.user'],
      cy: ['knowledge.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
  for (const u of await erp.host.server.driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  }))
    users[u.login] = Number(u.id);
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('everyone, its members, or its owner alone — and writing is the owner’s and the editors’', async () => {
  ids['handbook'] = await make('ana', {
    name: 'Company handbook',
    body: '<p>How we work: the <strong>leave</strong> rules and expense claims.</p>',
  });
  ids['playbook'] = await make('ana', {
    name: 'Sales playbook',
    visibility: 'members',
    members: { set: [users['ben']] },
  });
  ids['notes'] = await make('ana', { name: 'My notes', visibility: 'private' });
  expect(await seen('ana')).toEqual(['Company handbook', 'Sales playbook', 'My notes']);
  expect(await seen('ben')).toEqual(['Company handbook', 'Sales playbook']);
  expect(await seen('cy')).toEqual(['Company handbook']);
  expect((await call('GET', `${A}/${ids['notes']}`, 'cy')).status).toBeGreaterThanOrEqual(403);
  expect((await call('GET', A, 'bob')).status).toBe(403);
  // A member reads; an editor writes; nobody else writes, not even what everyone reads.
  expect((await call('PATCH', `${A}/${ids['playbook']}`, 'ben', { name: 'Mine now' })).status).toBe(
    403,
  );
  expect((await call('PATCH', `${A}/${ids['handbook']}`, 'cy', { name: 'Mine now' })).status).toBe(
    403,
  );
  expect(
    (await call('PATCH', `${A}/${ids['handbook']}`, 'ana', { editors: { set: [users['cy']] } }))
      .status,
  ).toBe(200);
  expect(
    (await call('PATCH', `${A}/${ids['handbook']}`, 'cy', { name: 'The company handbook' })).status,
  ).toBe(200);
  // An editor of a private article reads it too.
  expect(
    (await call('PATCH', `${A}/${ids['notes']}`, 'ana', { editors: { set: [users['cy']] } }))
      .status,
  ).toBe(200);
  expect(await seen('cy')).toEqual(['The company handbook', 'My notes']);
  // A manager reads everything.
  expect(await seen('kim')).toHaveLength(3);
});

test('an article is never wider than the one it is inside', async () => {
  // Inside the members-only playbook, an article for everyone is refused.
  const wide = await call('POST', A, 'ana', {
    name: 'Pricing',
    parent: ids['playbook'],
    visibility: 'company',
  });
  expect(wide.status).toBe(422);
  ids['pricing'] = await make('ana', {
    name: 'Pricing',
    parent: ids['playbook'],
    visibility: 'members',
    members: { set: [users['ben']] },
  });
  // Narrowing the playbook while something inside it is wider is refused too.
  expect(
    (await call('PATCH', `${A}/${ids['playbook']}`, 'ana', { visibility: 'private' })).status,
  ).toBe(422);
  // A new article is one's own; only a manager hands one to someone else.
  const given = await call('POST', A, 'ana', { name: 'For Ben', owner: users['ben'] });
  expect(given.status).toBeGreaterThanOrEqual(403);
  const handed = await call('POST', A, 'kim', { name: 'For Ben', owner: users['ben'] });
  expect(handed.status, JSON.stringify(handed.json)).toBe(201);
  ids['forBen'] = handed.json.id;
  expect(await seen('ben')).toContain('For Ben');
});

test('a link only to a record one may read, and seen only with its article', async () => {
  const contact = (
    await call('POST', '/api/v1/models/res.partner', 'ana', { name: 'Meghna Textiles' })
  ).json.id as number;
  const link = await call('POST', L, 'ana', {
    article: ids['playbook'],
    resModel: 'res.partner',
    resId: contact,
    resName: 'Meghna Textiles',
  });
  expect(link.status, JSON.stringify(link.json)).toBe(201);
  // Ben owns an article, but has no Contacts: he cannot link a contact to it.
  const notMine = await call('POST', L, 'ben', {
    article: ids['forBen'],
    resModel: 'res.partner',
    resId: contact,
  });
  expect(notMine.status).toBe(422);
  // Nor link anything to an article he only reads.
  expect(
    (
      await call('POST', L, 'ben', {
        article: ids['pricing'],
        resModel: 'res.users',
        resId: users['ben'],
      })
    ).status,
  ).toBe(403);
  // A record that does not exist, or a kind that does not.
  for (const wrong of [
    { resModel: 'res.partner', resId: 999999 },
    { resModel: 'no.such.model', resId: 1 },
  ])
    expect((await call('POST', L, 'ana', { article: ids['handbook'], ...wrong })).status).toBe(422);
  // The record's articles: those one may read.
  const forAna = (await call('GET', `/api/v1/knowledge/for?model=res.partner&id=${contact}`, 'ana'))
    .json.items as Json[];
  expect(forAna.map((a) => a.name)).toEqual(['Sales playbook']);
  const forCy = (await call('GET', `/api/v1/knowledge/for?model=res.partner&id=${contact}`, 'cy'))
    .json.items as Json[];
  expect(forCy).toEqual([]);
});

test('search: the title and the text, only what one may read', async () => {
  const ana = await found('ana', 'leave');
  expect(ana.items.map((a: Json) => a.name)).toEqual(['The company handbook']);
  expect(ana.items[0].snippet).toContain('leave rules');
  // Markup is not text: "strong" is in the HTML only.
  expect((await found('ana', 'strong')).items).toEqual([]);
  expect((await found('ana', 'playbook')).items.map((a: Json) => a.name)).toEqual([
    'Sales playbook',
  ]);
  expect((await found('cy', 'playbook')).items).toEqual([]);
  // A pattern is text, not a wildcard.
  expect((await found('ana', '%_')).items).toEqual([]);
  expect((await call('GET', '/api/v1/knowledge/search?q=a', 'ana')).status).toBe(400);
  expect((await call('GET', '/api/v1/knowledge/search?q=handbook', 'bob')).status).toBe(403);
});

test('a snippet is the text around the first match', () => {
  const text = `${'x'.repeat(200)} the leave rules are simple ${'y'.repeat(200)}`;
  const s = snippetOf(text, 'leave', 60);
  expect(s.startsWith('…')).toBe(true);
  expect(s).toContain('leave rules');
  expect(snippetOf('short text', 'missing')).toBe('short text');
});
