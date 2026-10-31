/**
 * @packageDocumentation
 * `@kosh/website` (RFC 0021): the **Sites** app. Websites per company, pages built from blocks (a hero, text, an
 * image, a call to action, a form) with a live preview, in English or Bangla with their translations linked, and
 * forms whose submissions become contacts — or what another app allows (`targets()` on `website.form`). The public
 * rendering is the Next.js site's; Sites is the content and its API:
 *
 * - `GET  /api/v1/public/sites/:site?lang=`            the site and its menu (no sign-in; rate limited)
 * - `GET  /api/v1/public/sites/:site/page?path=&lang=` a published page with its blocks and translations
 * - `POST /api/v1/public/sites/:site/forms/:key`       a visitor's submission
 * - `GET  /api/v1/sites/pages/:id/preview`             the page as HTML, draft or published (editors)
 */
import { contacts } from '@kosh/contacts';
import { messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import type { ModuleContext } from '@kosh/server';
import { action, form, list, search } from '@kosh/views';
import { websiteDemo } from './demo.js';
import {
  WebsiteForm,
  WebsitePage,
  WebsiteSite,
  WebsiteSubmission,
  websiteShutro,
} from './module.js';
import { registerSitesRoutes, type SitesOptions, SUBMITTED } from './routes.js';

export {
  HONEYPOT,
  safeUrl,
  submissionValues,
  WebsiteBlock,
  WebsiteForm,
  WebsiteFormField,
  WebsitePage,
  WebsiteSite,
  WebsiteSubmission,
  websiteShutro,
} from './module.js';
export { type PublicPage, pageHtml } from './render.js';
export { type SitesOptions, SUBMITTED } from './routes.js';

/** Sites with explicit options (tests: no cache). */
export function websiteModule(options: SitesOptions = {}): ReturnType<typeof defineModule> {
  return defineModule({
    shutro: websiteShutro,
    kosh: '^0.1.0',
    hooks: { demo: websiteDemo },
    depends: [contacts, messaging],
    app: {
      code: 'sites',
      label: 'Sites',
      icon: 'sites',
      sequence: 42,
      category: 'Website',
      summary: 'Website pages from blocks, forms that create records, a public API',
    },
    accessLevels: {
      editor: { label: 'Editor (pages, submissions)', groups: ['website.editor'] },
      manager: {
        label: 'Manager (sites, forms, everything)',
        groups: ['website.manager'],
        implies: ['editor'],
      },
    },
    events: [{ topic: SUBMITTED, model: 'website.submission', label: 'Website form submitted' }],
    routes: (context: ModuleContext) => registerSitesRoutes(context, options),
    actions: {
      'sites.action_pages': action(WebsitePage, {
        label: 'Pages',
        views: ['list', 'form'],
      }),
      'sites.action_forms': action(WebsiteForm, { label: 'Forms', views: ['list', 'form'] }),
      'sites.action_submissions': action(WebsiteSubmission, {
        label: 'Submissions',
        views: ['list', 'form'],
        defaultFilters: ['received'],
      }),
      'sites.action_sites': action(WebsiteSite, { label: 'Sites', views: ['list', 'form'] }),
    },
    menus: [
      { id: 'sites.root', label: 'Sites', app: 'sites' },
      {
        id: 'sites.pages',
        parent: 'sites.root',
        label: 'Pages',
        action: 'sites.action_pages',
        sequence: 1,
      },
      {
        id: 'sites.submissions',
        parent: 'sites.root',
        label: 'Submissions',
        action: 'sites.action_submissions',
        sequence: 2,
      },
      {
        id: 'sites.forms',
        parent: 'sites.root',
        label: 'Forms',
        action: 'sites.action_forms',
        sequence: 3,
      },
      {
        id: 'sites.sites',
        parent: 'sites.root',
        label: 'Sites',
        action: 'sites.action_sites',
        sequence: 4,
      },
    ],
    views: {
      'website.page.list': list(WebsitePage, {
        columns: [
          'title',
          'site',
          'path',
          { field: 'lang', widget: 'badge' },
          'inMenu',
          { field: 'state', widget: 'badge' },
          'publishedAt',
        ],
        inlineEdit: ['title', 'inMenu'],
      }),
      'website.page.form': form(WebsitePage, (k) => ({
        header: {
          statusbar: 'state',
          buttons: [
            k.button('publish', { primary: true, label: 'Publish' }),
            k.button('unpublish', { label: 'Unpublish' }),
          ],
        },
        sheet: [
          k.group('main', ['title', 'site', 'path', 'lang', 'translationOf', 'inMenu', 'sequence']),
          k.group('seo', ['description'], { columns: 1 }),
          k.lines('blocks', [
            'kind',
            { field: 'title', id: 'block_title' },
            'body',
            'imageUrl',
            'buttonLabel',
            'buttonUrl',
            'form',
          ]),
          k.component('preview', 'sites.Preview'),
        ],
        chatter: true,
      })),
      'website.form.list': list(WebsiteForm, { columns: ['name', 'key', 'target'] }),
      'website.form.form': form(WebsiteForm, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['name', 'key', 'target']),
          k.lines('fields', [
            { field: 'name', id: 'input_name' },
            { field: 'label', id: 'input_label' },
            'kind',
            'required',
            'targetField',
          ]),
          k.group('after', ['successMessage'], { columns: 1 }),
        ],
      })),
      'website.submission.list': list(WebsiteSubmission, {
        columns: ['id', 'form', 'site', 'resName', 'resModel', { field: 'state', widget: 'badge' }],
      }),
      'website.submission.form': form(WebsiteSubmission, (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['form', 'site', 'state', 'resModel', 'resId', 'resName']),
          k.group('sent', ['data'], { columns: 1 }),
        ],
      })),
      'website.site.list': list(WebsiteSite, {
        columns: ['name', 'key', 'domain', { field: 'lang', widget: 'badge' }],
      }),
      'website.site.form': form(WebsiteSite, (k) => ({
        header: { buttons: [] },
        sheet: [k.group('main', ['name', 'key', 'domain', 'lang'])],
      })),
    },
    search: {
      'website.page': search(WebsitePage, {
        fields: ['title', 'path', 'description'],
        filters: {
          published: { label: 'Published', domain: { state: 'published' }, group: 'state' },
          draft: { label: 'Draft', domain: { state: 'draft' }, group: 'state' },
        },
        groupBy: ['site', 'lang', 'state'],
      }),
      'website.submission': search(WebsiteSubmission, {
        fields: ['resName'],
        filters: {
          received: { label: 'Received', domain: { state: 'received' }, group: 'state' },
          spam: { label: 'Spam', domain: { state: 'spam' }, group: 'state' },
        },
        groupBy: ['form', 'site', 'state'],
      }),
      'website.form': search(WebsiteForm, { fields: ['name', 'key'] }),
      'website.site': search(WebsiteSite, { fields: ['name', 'key', 'domain'] }),
    },
  });
}

/** Sites: public reads kept 30 seconds per server. */
export const website: ReturnType<typeof defineModule> = websiteModule();
