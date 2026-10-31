/**
 * The data layer of the Sites ↔ Pipeline bridge (RFC 0021): website forms may create deals. A deal from a form comes
 * from the website, in the first stage, for no salesperson yet (so every Pipeline user sees it), named after the
 * enquiry unless the form fills the name.
 */
import { crmShutro } from '@kosh/crm';
import { orm } from '@kosh/server/orm';
import { websiteShutro } from '@kosh/website';
import { defineModule, type Env, extendModel, type Records } from './.kosh/bindings.js';

export const FormDeals = extendModel('website.form', {
  overrides: {
    targets: async function (this: unknown, next: () => Promise<string[]>): Promise<string[]> {
      return [...(await next()), 'crm.deal'];
    },
    submissionValues: async function (
      this: unknown,
      next: (target: string) => Promise<Record<string, unknown>>,
      target: string,
    ): Promise<Record<string, unknown>> {
      const values = await next(target);
      if (target !== 'crm.deal') return values;
      const env = (this as Records<'website.form'>).env as unknown as Env;
      const [stage] = (
        await env.model('crm.stage').search({ order: ['sequence asc', 'id asc'], limit: 1 })
      ).ids;
      return {
        ...values,
        name: 'Website enquiry',
        source: 'website',
        salesperson: null,
        ...(stage === undefined ? {} : { stage }),
      };
    },
  },
});

export const websiteCrmShutro = defineModule({
  name: 'website_crm',
  version: '0.1.0',
  depends: [websiteShutro, crmShutro],
  groups: [
    orm.defineGroup({
      code: 'website_crm.user',
      label: 'Website deals',
      implies: ['website.editor'],
    }),
  ],
  models: [],
  extensions: [FormDeals],
});
