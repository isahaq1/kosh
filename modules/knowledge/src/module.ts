/**
 * The data layer of Knowledge (RFC 0038, step 7): **articles** in a tree, written in rich text, each with who may
 * read and who may write it — the whole company, its members, or its owner alone —, and **links** from any record
 * to the articles about it.
 *
 * Who reads and writes is decided by record rules, so the same holds in lists, search, exports and the API. An
 * article is never wider than the one it sits in: what a private page holds stays private.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { orm } from '@kosh/server/orm';
import { check, defineModel, defineModule, type Env, f, onchange } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const me = { $env: 'uid' } as const;
const USER = 'knowledge.user';
const MANAGER = 'knowledge.manager';

export const VISIBILITY = {
  company: 'Everyone',
  members: 'Its members',
  private: 'Only me',
} as const;
type Visibility = keyof typeof VISIBILITY;

/** How wide each visibility is: an article is never wider than its parent. */
export const WIDTH: Readonly<Record<Visibility, number>> = { private: 0, members: 1, company: 2 };

/** Whether `child` may sit in `parent`: no wider than it. */
export const fitsIn = (child: Visibility, parent: Visibility): boolean =>
  WIDTH[child] <= WIDTH[parent];

export const KnowledgeArticle = defineModel('knowledge.article', {
  label: 'Article',
  recName: 'name',
  order: ['sequence asc', 'name asc'],
  archivable: true,
  companyScoped: { required: true },
  hierarchy: { parent: 'parent', path: 'parentPath' },
  tracking: ['name', 'parent', 'visibility', 'owner', 'members', 'editors'],
  access: {
    [USER]: [...ALL],
    [MANAGER]: [...ALL, 'export', 'import'],
  },
  rules: {
    // Read: what is everyone's, what is one's own, what one is a member or an editor of.
    read: {
      groups: [USER],
      perms: ['read'],
      domain: {
        or: [
          { visibility: 'company' },
          { owner: me },
          { members: { any: { id: me } } },
          { editors: { any: { id: me } } },
        ],
      },
    },
    // Write: its owner and its editors.
    write: {
      groups: [USER],
      perms: ['write', 'unlink'],
      domain: { or: [{ owner: me }, { editors: { any: { id: me } } }] },
    },
    // A new article is one's own.
    create: { groups: [USER], perms: ['create'], domain: { owner: me } },
    all: { groups: [MANAGER], perms: [...ALL], domain: {} },
  },
  fields: {
    name: f.char({ required: true, label: 'Title' }),
    icon: f.char({ size: 8, label: 'Icon', help: 'An emoji shown before the title: 📘, 🧾, 🛠️.' }),
    parent: f.many2one('knowledge.article', {
      ondelete: 'restrict',
      index: true,
      label: 'Inside',
      help: 'The article this one belongs under. Empty: at the top.',
    }),
    parentPath: f.char({ readonly: true, index: true }),
    children: f.one2many('knowledge.article', 'parent', { label: 'Articles inside' }),
    sequence: f.integer({ required: true, default: 10, label: 'Order' }),
    body: f.html({ label: 'Content' }),
    visibility: f.selection(VISIBILITY, {
      required: true,
      default: 'company',
      label: 'Who reads it',
      help: 'Everyone with Knowledge, its members only, or only its owner. Never wider than the article it is inside.',
    }),
    owner: f.many2one('res.users', {
      required: true,
      ondelete: 'restrict',
      index: true,
      default: (env: Env) => orm.asId(env.uid, 'res.users'),
      label: 'Owner',
      help: 'Reads and writes it, and decides who else does.',
    }),
    members: f.many2many('res.users', {
      relation: 'knowledge_article_member',
      label: 'Members',
      help: 'Read it when it is for its members only.',
    }),
    editors: f.many2many('res.users', {
      relation: 'knowledge_article_editor',
      label: 'Editors',
      help: 'Read and write it, whoever else may.',
    }),
    links: f.one2many('knowledge.link', 'article', { label: 'Linked records' }),
  },
  onchange: {
    // Inside another article: as wide as it, to start with.
    parent: onchange('knowledge.article', async (d) => {
      const p = await d.record('parent');
      if (p !== null && p !== undefined) d.set('visibility', p.visibility);
    }),
  },
  constraints: {
    noWiderThanParent: {
      ...check('knowledge.article', ['parent', 'visibility'], async (articles) =>
        articles.env.asSuperuser({ reason: 'knowledge: no wider than the parent' }, async (su) => {
          const failing: number[] = [];
          for (const a of await su
            .model('knowledge.article')
            .browse(articles.ids as never)
            .load({ parent: true, children: true })) {
            if (
              a.parent !== null &&
              !fitsIn(a.visibility as Visibility, a.parent.visibility as Visibility)
            )
              failing.push(a.id as number);
            // Narrowing an article: what is inside it may not stay wider.
            for (const c of a.children)
              if (!fitsIn(c.visibility as Visibility, a.visibility as Visibility))
                failing.push(a.id as number);
          }
          return failing;
        }),
      ),
      message:
        'An article is never wider than the one it is inside: narrow the articles inside it first, or choose who reads it again.',
    },
    // The owner is who makes it — or a manager handing it to someone.
    ownerAtCreate: {
      ...check('knowledge.article', ['owner'], async (articles) => {
        const env = articles.env as unknown as Env;
        if (env.su || env.access.has('knowledge.manage')) return [];
        return [...articles]
          .filter((a) => (a.owner as { id: number }).id !== env.uid)
          .map((a) => a.id as number);
      }),
      message: 'Only a Knowledge manager gives an article to someone else.',
    },
  },
});

export const KnowledgeLink = defineModel('knowledge.link', {
  label: 'Article link',
  recName: 'resName',
  order: ['id asc'],
  access: {
    [USER]: [...ALL],
    [MANAGER]: [...ALL, 'export'],
  },
  rules: {
    // A link is seen with its article, and made or removed by whoever writes the article.
    read: {
      groups: [USER],
      perms: ['read'],
      domain: {
        or: [
          { 'article.visibility': 'company' },
          { 'article.owner': me },
          { 'article.members': { any: { id: me } } },
          { 'article.editors': { any: { id: me } } },
        ],
      },
    },
    write: {
      groups: [USER],
      perms: ['write', 'create', 'unlink'],
      domain: { or: [{ 'article.owner': me }, { 'article.editors': { any: { id: me } } }] },
    },
    all: { groups: [MANAGER], perms: [...ALL], domain: {} },
  },
  fields: {
    article: f.many2one('knowledge.article', { required: true, ondelete: 'cascade', index: true }),
    resModel: f.char({ required: true, size: 128, index: true, label: 'Kind of record' }),
    resId: f.integer({ required: true, index: true, label: 'Record' }),
    resName: f.char({ label: 'Name', help: 'The record’s name when it was linked.' }),
  },
  sqlConstraints: {
    once: {
      unique: ['article', 'resModel', 'resId'],
      message: 'This record is linked to the article already.',
    },
  },
  constraints: {
    // A record one may not read is not linked: the link would say it exists.
    readable: {
      ...check('knowledge.link', ['resModel', 'resId'], async (links) => {
        const env = links.env as unknown as Env;
        const failing: number[] = [];
        for (const l of links) {
          try {
            const found = await (
              env.model(l.resModel as never) as unknown as {
                search(q: unknown): Promise<{ length: number }>;
              }
            ).search({ where: { id: l.resId }, limit: 1 });
            if (found.length === 0) failing.push(l.id as number);
          } catch {
            failing.push(l.id as number);
          }
        }
        return failing;
      }),
      message: 'Link a record that exists and that you may read.',
    },
  },
});

export const knowledgeShutro = defineModule({
  name: 'knowledge',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({ code: USER, label: 'Knowledge: read and write articles', implies: [] }),
    orm.defineGroup({ code: MANAGER, label: 'Knowledge manager', implies: [USER] }),
  ],
  permissions: [
    orm.definePermission({
      code: 'knowledge.manage',
      label: 'Hand articles to someone else',
      groups: [MANAGER],
    }),
  ],
  models: [KnowledgeArticle, KnowledgeLink],
});
