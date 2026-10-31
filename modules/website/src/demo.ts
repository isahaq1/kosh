/**
 * Sites' demo data (RFC 0008 §5.8): the company's site with a published home page (a hero, a text, the contact form),
 * its Bangla translation, an About page, and a contact form that makes contacts.
 */
import type { DemoContext } from '@kosh/modules-sdk';
import type { Env } from './.kosh/bindings.js';

const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['website.manager'] } as const;

export async function websiteDemo(ctx: DemoContext): Promise<string> {
  await ctx.as(DINA, async (raw) => {
    const env = raw as Env;
    const [site] = (
      await env
        .model('website.site')
        .create([{ name: 'Padma Traders', key: 'padma', domain: 'www.padma.example', lang: 'en' }])
    ).ids;
    if (site === undefined) return;
    const [contact] = (
      await env.model('website.form').create([
        {
          name: 'Contact us',
          key: 'contact',
          target: 'res.partner',
          successMessage: 'Thank you — we will call you back within a working day.',
          fields: {
            create: [
              {
                name: 'name',
                label: 'Your name',
                kind: 'text',
                required: true,
                targetField: 'name',
              },
              {
                name: 'email',
                label: 'Email',
                kind: 'email',
                required: true,
                targetField: 'email',
              },
              { name: 'phone', label: 'Phone', kind: 'phone', targetField: 'phone' },
              { name: 'company', label: 'Company', kind: 'text', targetField: 'notes' },
            ],
          },
        },
      ])
    ).ids;
    const pages = await env.model('website.page').create([
      {
        site,
        path: '/',
        lang: 'en',
        title: 'Padma Traders',
        description: 'Rice, lentils and edible oil, wholesale across Bangladesh since 1998.',
        sequence: 1,
        blocks: {
          create: [
            {
              sequence: 1,
              kind: 'hero',
              title: 'Wholesale staples, delivered on time',
              body: 'Rice, lentils and edible oil for shops and restaurants across Bangladesh.',
              buttonLabel: 'Talk to us',
              buttonUrl: '/#contact',
            },
            {
              sequence: 2,
              kind: 'text',
              title: 'Why buyers stay with us',
              body: 'Fixed prices for the month, delivery in 48 hours in Dhaka, and credit terms for regular customers.',
            },
            {
              sequence: 3,
              kind: 'form',
              title: 'Ask for a price list',
              buttonLabel: 'Send',
              ...(contact === undefined ? {} : { form: contact }),
            },
          ],
        },
      },
      {
        site,
        path: '/about',
        lang: 'en',
        title: 'About us',
        sequence: 2,
        blocks: {
          create: [
            {
              kind: 'text',
              title: 'A family business',
              body: 'Founded in Narayanganj in 1998, we now supply over 600 shops.',
            },
          ],
        },
      },
    ]);
    const [home] = pages.ids;
    if (home === undefined) return;
    await env.model('website.page').create([
      {
        site,
        path: '/',
        lang: 'bn',
        title: 'পদ্মা ট্রেডার্স',
        translationOf: home,
        sequence: 1,
        blocks: {
          create: [
            {
              kind: 'hero',
              title: 'পাইকারি নিত্যপণ্য, সময়মতো পৌঁছে দিই',
              body: 'সারা বাংলাদেশের দোকান ও রেস্তোরাঁর জন্য চাল, ডাল ও ভোজ্য তেল।',
            },
          ],
        },
      },
    ]);
    const all = await env.model('website.page').search({ where: { site } });
    await all.publish();
  });
  return 'Sites: a site with 3 pages (one in Bangla) and a contact form';
}
