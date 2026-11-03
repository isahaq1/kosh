/**
 * Documents' demo data (RFC 0008 §5.8): the company's folders — Contracts and Suppliers open to everyone with
 * Documents, HR kept to its members —, two tags, and a request to a supplier for their trade licence.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import { idByName } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['documents.manager'] } as const;

export async function documentsDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const folders = await env
      .model('documents.folder')
      .create([{ name: 'Contracts' }, { name: 'Suppliers' }, { name: 'HR', restricted: true }]);
    await env.model('documents.tag').create([{ name: 'Signed' }, { name: 'To review' }]);
    const supplier = (await idByName(env as never, 'res.partner', 'Padma Cement')) as
      | number
      | undefined;
    await env.model('documents.request').create([
      {
        name: 'Your trade licence (2026)',
        folder: folders.ids[1] as never,
        partner: (supplier ?? null) as never,
        email: 'accounts@padmacement.example',
        message: 'A scan or a photo is fine.',
      },
    ]);
  });
  return 'Documents: 3 folders (HR for its members), 2 tags, a request to a supplier.';
}
