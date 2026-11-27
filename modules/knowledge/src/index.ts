/**
 * @packageDocumentation
 * `@kosh/knowledge`: Knowledge (RFC 0038, step 7) — articles in a tree, in rich text, read by everyone, by their
 * members or by their owner alone, and linked from any record.
 *
 * - `GET /api/v1/knowledge/search?q=`              articles whose title or content says it, that one may read
 * - `GET /api/v1/knowledge/for?model=&id=`          the articles linked to a record, that one may read
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { HttpProblem, htmlToText, type ModuleContext } from '@kosh/server';
import { action, form, hierarchy, list, search } from '@kosh/views';
import type { Env } from './.kosh/bindings.js';
import { knowledgeDemo } from './demo.js';
import { KnowledgeArticle, KnowledgeLink, knowledgeShutro } from './module.js';

export {
  fitsIn,
  KnowledgeArticle,
  KnowledgeLink,
  knowledgeShutro,
  VISIBILITY,
  WIDTH,
} from './module.js';

/** At most this many articles a search returns. */
export const SEARCH_LIMIT = 30;

/** A line of text around the first place `q` appears, or the beginning. */
export function snippetOf(text: string, q: string, width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return flat.slice(0, width);
  const from = Math.max(0, at - Math.floor(width / 3));
  return `${from > 0 ? '…' : ''}${flat.slice(from, from + width)}${from + width < flat.length ? '…' : ''}`;
}

function registerKnowledgeRoutes(context: ModuleContext): void {
  const { app } = context;

  app.get('/api/v1/knowledge/search', async (request) => {
    const q = String((request.query as { q?: unknown }).q ?? '').trim();
    if (q.length < 2)
      throw new HttpProblem(400, 'invalid-query', 'Too short', 'Search with two letters or more.');
    return request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        // Found by the database in the title and the text; kept only where the reader's rules allow.
        const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const company = env.companyId as number;
        const found = await env.asSuperuser(
          { reason: 'knowledge search' },
          (su) =>
            su.sql<{ id: number }>`
            SELECT id FROM knowledge_article
             WHERE company_id = ${company} AND active
               AND (name ILIKE ${pattern}
                    OR regexp_replace(coalesce(body, ''), '<[^>]*>', ' ', 'g') ILIKE ${pattern})
             ORDER BY (name ILIKE ${pattern}) DESC, id DESC
             LIMIT ${SEARCH_LIMIT * 4}`,
        );
        if (found.length === 0) return { items: [] };
        const readable = await env
          .model('knowledge.article')
          .search({ where: { id: { in: found.map((r) => Number(r.id)) } } as never })
          .then((r) => r.load(['name', 'icon', 'body', 'parentPath']));
        const order = new Map(found.map((r, i) => [Number(r.id), i]));
        return {
          items: [...readable]
            .sort((a, b) => (order.get(a.id as number) ?? 0) - (order.get(b.id as number) ?? 0))
            .slice(0, SEARCH_LIMIT)
            .map((a) => ({
              id: a.id,
              name: a.name,
              icon: a.icon,
              snippet: snippetOf(htmlToText(a.body ?? ''), q),
            })),
        };
      },
      { write: true },
    );
  });

  app.get('/api/v1/knowledge/for', async (request) => {
    const query = request.query as { model?: unknown; id?: unknown };
    const model = String(query.model ?? '');
    const id = Number(query.id);
    if (!/^[a-z][a-z0-9_.]*$/.test(model) || !Number.isInteger(id))
      throw new HttpProblem(400, 'invalid-query', 'Invalid record', 'Give model and id.');
    return request.env(async (raw) => {
      const env = raw as unknown as Env;
      const links = await env
        .model('knowledge.link')
        .search({ where: { resModel: model, resId: id } as never })
        .then((r) => r.load({ article: true }));
      return {
        items: [...links].map((l) => ({
          id: l.article.id,
          name: l.article.name,
          icon: l.article.icon,
        })),
      };
    });
  });
}

export const knowledge: ReturnType<typeof defineModule> = defineModule({
  shutro: knowledgeShutro,
  kosh: '^0.1.0',
  hooks: { demo: knowledgeDemo },
  depends: [contacts, messaging, reporting],
  app: {
    code: 'knowledge',
    label: 'Knowledge',
    icon: 'knowledge',
    sequence: 64,
    category: 'Productivity',
    summary:
      'Articles in a tree, in rich text, for everyone, their members or their owner; linked from records',
  },
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'User (reads and writes articles)', groups: ['knowledge.user'] },
    manager: {
      label: 'Knowledge manager (every article)',
      groups: ['knowledge.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerKnowledgeRoutes(context),
  // Exceptions to the module standard (RFC 0023), each with its reason.
  standard: {
    waive: [
      {
        rule: 'I1',
        model: 'knowledge.article',
        reason: 'An article is rich text written on screen; a workbook would carry its markup.',
      },
      {
        rule: 'I1',
        model: 'knowledge.link',
        reason: 'A link is made from an article to a record that the person may read, on screen.',
      },
    ],
  },
  documents: [
    {
      key: 'knowledge_article',
      name: 'Article',
      model: 'knowledge.article',
      layout: {
        paper: 'A4',
        header: '{{company.name}}',
        footer: 'Page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: '{{icon}} {{name}}', level: 1 },
          { kind: 'text', id: 'body', text: '{{body}}' },
        ],
      },
    },
  ],
  overview: {
    cards: [
      {
        id: 'articles',
        title: 'Articles',
        kind: 'kpi',
        model: 'knowledge.article',
        measure: 'count',
        w: 3,
      },
      {
        id: 'shared',
        title: 'For everyone',
        kind: 'kpi',
        model: 'knowledge.article',
        measure: 'count',
        filter: { visibility: 'company' },
        w: 3,
      },
      {
        id: 'members_only',
        title: 'For their members',
        kind: 'kpi',
        model: 'knowledge.article',
        measure: 'count',
        filter: { visibility: 'members' },
        w: 3,
      },
      {
        id: 'links',
        title: 'Linked records',
        kind: 'kpi',
        model: 'knowledge.link',
        measure: 'count',
        w: 3,
      },
      {
        id: 'by_visibility',
        title: 'Articles by who reads them',
        kind: 'chart',
        model: 'knowledge.article',
        measure: 'count',
        groupBy: 'visibility',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'by_owner',
        title: 'Articles by owner',
        kind: 'pivot',
        model: 'knowledge.article',
        measure: 'count',
        groupBy: 'owner',
        w: 6,
      },
      {
        id: 'by_month',
        title: 'Articles written by month',
        kind: 'chart',
        model: 'knowledge.article',
        measure: 'count',
        groupBy: 'createdAt:month',
        chart: 'bar',
        w: 6,
      },
      {
        id: 'links_by_kind',
        title: 'Links by kind of record',
        kind: 'pivot',
        model: 'knowledge.link',
        measure: 'count',
        groupBy: 'resModel',
        w: 6,
      },
    ],
  },
  actions: {
    'knowledge.action_articles': action(KnowledgeArticle, {
      label: 'Articles',
      views: ['hierarchy', 'list', 'form'],
    }),
    'knowledge.action_links': action(KnowledgeLink, {
      label: 'Linked records',
      views: ['list', 'form'],
    }),
  },
  menus: [
    { id: 'knowledge.root', label: 'Knowledge', app: 'knowledge' },
    {
      id: 'knowledge.articles',
      parent: 'knowledge.root',
      label: 'Articles',
      action: 'knowledge.action_articles',
      sequence: 1,
    },
    {
      id: 'knowledge.links',
      parent: 'knowledge.root',
      label: 'Linked records',
      action: 'knowledge.action_links',
      sequence: 2,
    },
  ],
  views: {
    'knowledge.article.hierarchy': hierarchy(KnowledgeArticle, {
      parent: 'parent',
      title: 'name',
      subtitle: 'visibility',
    }),
    'knowledge.article.list': list(KnowledgeArticle, {
      columns: ['icon', 'name', 'parent', { field: 'visibility', widget: 'badge' }, 'owner'],
      decorations: { neutral: { visibility: 'private' }, info: { visibility: 'members' } },
    }),
    'knowledge.article.form': form(KnowledgeArticle, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.stats('related', [
          {
            id: 'article_children',
            label: 'Articles inside',
            model: KnowledgeArticle,
            where: { parent: { $record: 'id' } },
            action: 'knowledge.action_articles',
          },
          {
            id: 'article_links',
            label: 'Linked records',
            model: KnowledgeLink,
            where: { article: { $record: 'id' } },
            action: 'knowledge.action_links',
          },
        ]),
        k.group('main', ['icon', 'name', 'parent', 'sequence']),
        k.group('content', ['body'], { label: 'Content', columns: 1 }),
        k.group('access', ['visibility', 'owner', 'members', 'editors'], {
          label: 'Who reads and writes it',
          description:
            'Its owner and its editors write it. Everyone with Knowledge reads it, or only its members, or only its owner. It is never wider than the article it is inside.',
        }),
        k.lines('links', [
          { field: 'resModel', id: 'link_model' },
          { field: 'resId', id: 'link_id' },
          { field: 'resName', id: 'link_name' },
        ]),
      ],
      chatter: true,
    })),
    'knowledge.link.list': list(KnowledgeLink, {
      columns: ['article', 'resModel', 'resId', 'resName'],
    }),
    'knowledge.link.form': form(KnowledgeLink, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['article', 'resModel', 'resId', 'resName'])],
    })),
  },
  search: {
    'knowledge.article': search(KnowledgeArticle, {
      fields: ['name', 'parent.name', 'owner.name'],
      filters: {
        mine: { label: 'Mine', domain: { owner: { $env: 'uid' } }, group: 'owner' },
        company: { label: 'For everyone', domain: { visibility: 'company' }, group: 'visibility' },
        members: {
          label: 'For their members',
          domain: { visibility: 'members' },
          group: 'visibility',
        },
        private: { label: 'Only me', domain: { visibility: 'private' }, group: 'visibility' },
      },
      groupBy: ['visibility', 'owner', 'parent'],
    }),
    'knowledge.link': search(KnowledgeLink, {
      fields: ['resName', 'resModel', 'article.name'],
      groupBy: ['resModel', 'article'],
    }),
  },
});
