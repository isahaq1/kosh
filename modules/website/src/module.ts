/**
 * The data layer of Sites (RFC 0021): websites per company, pages built from blocks (published or draft, in English or
 * Bangla, translations linked), and forms whose submissions become records of the apps that allow it — a contact
 * here, a lead with `website_crm`. The public rendering is the Next.js site's; this is the content and its API.
 */
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { type Id, orm } from '@kosh/server/orm';
import {
  check,
  defineModel,
  defineModule,
  type Env,
  f,
  method,
  records,
} from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;
const LANGS = { en: 'English', bn: 'Bangla' } as const;

/** A site's key and a form's key: what URLs name them by. */
export const KEY = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
/** A page's path: `/`, `/about`, `/products/rice`. */
export const PATH = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;
/** A form field's input name. */
export const INPUT = /^[a-z][a-z0-9_]{0,39}$/;

export const WebsiteSite = defineModel('website.site', {
  label: 'Site',
  recName: 'name',
  order: ['name asc'],
  companyScoped: { required: true },
  archivable: true,
  access: {
    'website.editor': ['read'],
    'website.manager': [...ALL, 'export'],
  },
  fields: {
    name: f.char({ required: true }),
    /** The slug the public API names the site by (`padma`): `/api/v1/public/sites/padma/…`. */
    key: f.char({ required: true, size: 63 }),
    domain: f.char({
      label: 'Domain',
      help: 'Where the public site is served, e.g. www.example.com',
    }),
    lang: f.selection(LANGS, { required: true, default: 'en', label: 'Default language' }),
    pages: f.one2many('website.page', 'site'),
  },
  sqlConstraints: {
    oneKey: { unique: ['key'], message: 'Another site has this key.' },
  },
  constraints: {
    keyShape: {
      ...check('website.site', ['key'], async (sites) =>
        sites.filter((s) => !KEY.test(s.key)).map((s) => s.id),
      ),
      message: 'A key is lower-case letters, digits and dashes, e.g. padma-traders.',
    },
  },
});

export const WebsitePage = defineModel('website.page', {
  label: 'Page',
  recName: 'title',
  order: ['site asc', 'sequence asc', 'path asc'],
  companyScoped: { required: true },
  tracking: ['state', 'path', 'title'],
  access: {
    'website.editor': ['read', 'write', 'create', 'unlink'],
    'website.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    site: f.many2one('website.site', { required: true, ondelete: 'cascade' }),
    path: f.char({ required: true, default: '/', help: '/ for the home page, /about, /contact' }),
    lang: f.selection(LANGS, { required: true, default: 'en', label: 'Language' }),
    title: f.char({ required: true }),
    /** For search engines and link previews. */
    description: f.text({ label: 'Summary' }),
    inMenu: f.boolean({ default: true, label: 'In the menu' }),
    sequence: f.integer({ required: true, default: 10 }),
    /** The page this one translates (its other languages link to the same original). */
    translationOf: f.many2one('website.page', { ondelete: 'set null', label: 'Translation of' }),
    blocks: f.one2many('website.block', 'page', { label: 'Content' }),
    state: f.state({
      states: { draft: 'Draft', published: 'Published' },
      initial: 'draft',
      transitions: {
        publish: {
          from: ['draft'],
          to: 'published',
          after: records('website.page', async (pages): Promise<void> => {
            await pages.write({ publishedAt: new Date() } as never);
          }),
        },
        unpublish: { from: ['published'], to: 'draft' },
      },
    }),
    publishedAt: f.datetime({ label: 'Published on' }),
  },
  sqlConstraints: {
    onePath: {
      unique: ['site', 'path', 'lang'],
      message: 'The site already has a page at this path in this language.',
    },
  },
  constraints: {
    pathShape: {
      ...check('website.page', ['path'], async (pages) =>
        pages.filter((p) => !PATH.test(p.path)).map((p) => p.id),
      ),
      message:
        'A path starts with / and has letters, digits, dashes, dots or underscores: /about-us.',
    },
    sameSite: {
      ...check('website.page', ['translationOf', 'site'], async (pages) =>
        (await pages.load({ translationOf: true }))
          .filter(
            (p) =>
              p.translationOf !== null &&
              (p.translationOf.id === p.id || p.translationOf.site.id !== p.site.id),
          )
          .map((p) => p.id),
      ),
      message: 'A page translates another page of the same site.',
    },
  },
});

/** A piece of a page, in order: what the public site renders, one component per kind. */
export const WebsiteBlock = defineModel('website.block', {
  label: 'Block',
  order: ['sequence asc', 'id asc'],
  access: {
    'website.editor': ['read', 'write', 'create', 'unlink'],
    'website.manager': ALL,
  },
  fields: {
    page: f.many2one('website.page', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    kind: f.selection(
      { hero: 'Hero', text: 'Text', image: 'Image', cta: 'Call to action', form: 'Form' },
      { required: true, default: 'text' },
    ),
    title: f.char(),
    body: f.text({ label: 'Text' }),
    imageUrl: f.char({ label: 'Image URL', size: 1000 }),
    buttonLabel: f.char({ label: 'Button' }),
    buttonUrl: f.char({ label: 'Button link', size: 1000 }),
    form: f.many2one('website.form', { ondelete: 'restrict' }),
  },
  constraints: {
    formBlock: {
      ...check('website.block', ['kind', 'form'], async (blocks) =>
        blocks.filter((b) => b.kind === 'form' && b.form === null).map((b) => b.id),
      ),
      message: 'A form block names its form.',
    },
    safeLinks: {
      ...check('website.block', ['imageUrl', 'buttonUrl'], async (blocks) =>
        blocks
          .filter((b) => [b.imageUrl, b.buttonUrl].some((u) => u !== null && !safeUrl(u)))
          .map((b) => b.id),
      ),
      message: 'A link is a path on the site (/contact) or an http(s) address.',
    },
  },
});

/** The models website forms may create (`targets()` on `website.form`, as bridges extend it). */
export async function formTargets(env: Env): Promise<string[]> {
  return env.model('website.form').browse([]).targets();
}

/** What a record of `target` made from a submission starts with (`submissionValues()`, as bridges extend it). */
export async function submissionValues(env: Env, target: string): Promise<Record<string, unknown>> {
  return env.model('website.form').browse([]).submissionValues(target);
}

/** A link a public page may carry: a path on the site, or http(s) — never `javascript:` or `data:`. */
export function safeUrl(url: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  return /^https?:\/\/[^\s]+$/i.test(url);
}

export const WebsiteForm = defineModel('website.form', {
  label: 'Website form',
  recName: 'name',
  order: ['name asc'],
  companyScoped: { required: true },
  archivable: true,
  access: {
    'website.editor': ['read'],
    'website.manager': [...ALL, 'export'],
  },
  fields: {
    name: f.char({ required: true }),
    /** What the public API names it by: `POST /api/v1/public/sites/:site/forms/:key`. */
    key: f.char({ required: true, size: 63 }),
    /** The model a submission becomes; one of `targets()`. */
    target: f.char({ required: true, default: 'res.partner', label: 'Creates' }),
    fields: f.one2many('website.form.field', 'form', { label: 'Fields' }),
    successMessage: f.text({
      required: true,
      default: 'Thank you. We will be in touch soon.',
      label: 'Message after sending',
    }),
    submissions: f.one2many('website.submission', 'form'),
  },
  methods: {
    /** The models a form may create: contacts here; bridges add theirs (`website_crm`: `crm.lead`). */
    targets: method('website.form', async (): Promise<string[]> => ['res.partner']),
    /**
     * What a record made from a submission starts with, before the form's inputs (which win): nothing here; bridges
     * set their own (`website_crm`: a deal from the website, for no salesperson yet).
     */
    submissionValues: method(
      'website.form',
      async (_target: string): Promise<Record<string, unknown>> => ({}),
    ),
  },
  sqlConstraints: {
    oneKey: { unique: ['company', 'key'], message: 'Another form has this key.' },
  },
  constraints: {
    keyShape: {
      ...check('website.form', ['key'], async (forms) =>
        forms.filter((x) => !KEY.test(x.key)).map((x) => x.id),
      ),
      message: 'A key is lower-case letters, digits and dashes, e.g. contact-us.',
    },
    allowedTarget: {
      ...check('website.form', ['target'], async (forms): Promise<Id<'website.form'>[]> => {
        const allowed = forms.length === 0 ? [] : await formTargets(forms.env as unknown as Env);
        return forms.filter((x) => !allowed.includes(x.target)).map((x) => x.id);
      }),
      message:
        'A website form creates contacts, or what an installed app allows (a lead with Pipeline).',
    },
  },
});

export const WebsiteFormField = defineModel('website.form.field', {
  label: 'Form field',
  order: ['sequence asc', 'id asc'],
  access: {
    'website.editor': ['read'],
    'website.manager': ALL,
  },
  fields: {
    form: f.many2one('website.form', { required: true, ondelete: 'cascade' }),
    sequence: f.integer({ required: true, default: 10 }),
    /** The input's name in what the visitor sends (`email`). */
    name: f.char({ required: true, size: 40, label: 'Input name' }),
    label: f.char({ required: true }),
    kind: f.selection(
      {
        text: 'Text',
        email: 'Email',
        phone: 'Phone',
        textarea: 'Long text',
        number: 'Number',
        date: 'Date',
      },
      { required: true, default: 'text', label: 'Type' },
    ),
    required: f.boolean({ default: false }),
    /** The field of the created record it fills (`email`); plain fields only, checked on submission. */
    targetField: f.char({ required: true, size: 80, label: 'Fills' }),
  },
  sqlConstraints: {
    oneName: { unique: ['form', 'name'], message: 'The form already has an input with this name.' },
  },
  constraints: {
    nameShape: {
      ...check('website.form.field', ['name'], async (fields) =>
        fields.filter((x) => !INPUT.test(x.name) || x.name === HONEYPOT).map((x) => x.id),
      ),
      message:
        'An input name is lower-case letters, digits and underscores, starting with a letter.',
    },
  },
});

/** The hidden input a person leaves empty and a bot fills in. */
export const HONEYPOT = 'website_url';

/** What a visitor sent through a form, and what it became. */
export const WebsiteSubmission = defineModel('website.submission', {
  label: 'Submission',
  order: ['id desc'],
  companyScoped: { required: true },
  access: {
    'website.editor': ['read'],
    'website.manager': ['read', 'unlink', 'export'],
  },
  fields: {
    form: f.many2one('website.form', { required: true, ondelete: 'cascade' }),
    site: f.many2one('website.site', { ondelete: 'set null' }),
    /** The values as sent (the form's inputs only). */
    data: f.json({ required: true, default: {} }),
    state: f.selection(
      { received: 'Received', spam: 'Spam' },
      { required: true, default: 'received' },
    ),
    resModel: f.char({ label: 'Created (model)' }),
    resId: f.integer({ label: 'Created (id)' }),
    /** The created record's name, as it was. */
    resName: f.char({ label: 'Created' }),
  },
});

export const websiteShutro = defineModule({
  name: 'website',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    orm.defineGroup({ code: 'website.editor', label: 'Sites editor' }),
    orm.defineGroup({
      code: 'website.manager',
      label: 'Sites manager',
      implies: ['website.editor'],
    }),
  ],
  models: [
    WebsiteSite,
    WebsitePage,
    WebsiteBlock,
    WebsiteForm,
    WebsiteFormField,
    WebsiteSubmission,
  ],
});
