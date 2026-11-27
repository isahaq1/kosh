/**
 * The data layer of Campaigns (RFC 0038, step 3): **mailing lists** with their subscribers, the company's
 * **never-email list**, and **campaigns** — an email sent to lists and to the contacts that carry a tag, with an
 * optional second subject for half of them — whose every message is a **delivery**: sent, opened, clicked,
 * unsubscribed.
 *
 * The server decides who is written to: an address once per campaign, never one that unsubscribed or stands on
 * the never-email list. Every message carries its way out. Sending is done in the background, a batch at a time.
 */
import { createHash, randomBytes } from 'node:crypto';
import { contactsShutro } from '@kosh/contacts';
import { messagingShutro } from '@kosh/messaging';
import { emitting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import {
  check,
  compute,
  defineModel,
  defineModule,
  type Env,
  f,
  records,
} from './.kosh/bindings.js';
import {
  type Composed,
  compose,
  composeText,
  emailKey,
  linksOf,
  type MailLanguage,
  percent,
  phoneKey,
  variantOf,
} from './render.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink'] as const;
/** Fields the server maintains: written by its own code and by Administrators only. */
const SYSTEM = ['base.admin'] as const;
const LANGUAGES = { en: 'English', bn: 'বাংলা' } as const;

/** The job that sends a campaign's next batch, and the one that starts a scheduled campaign. */
export const SEND_JOB = 'marketing.send';
export const START_JOB = 'marketing.start';
/** Messages per batch: one transaction, then the next. */
export const SEND_BATCH = 200;

export const CHANNELS = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' } as const;
export type Channel = keyof typeof CHANNELS;

/** What this server can send through — a mailer with its public address, a text provider —: set when it starts. */
let transportReady: Readonly<Record<Channel, boolean>> = {
  email: false,
  sms: false,
  whatsapp: false,
};
export const setCampaignTransport = (ready: Readonly<Record<Channel, boolean>>): void => {
  transportReady = ready;
};

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const MarketingList = defineModel('marketing.list', {
  label: 'Mailing list',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  access: { 'marketing.user': READ, 'marketing.manager': [...ALL, 'export', 'import'] },
  fields: {
    name: f.char({ required: true }),
    description: f.text({
      label: 'What it is for',
      help: 'What people on this list agreed to receive.',
    }),
    subscribers: f.one2many('marketing.subscriber', 'list', { label: 'Subscribers' }),
  },
  sqlConstraints: {
    name: { unique: ['company', 'name'], message: 'Another list has this name.' },
  },
});

const ADDRESS = 'Write an email address: name@example.com.';

export const MarketingSubscriber = defineModel('marketing.subscriber', {
  label: 'Subscriber',
  recName: 'email',
  order: ['email asc'],
  companyScoped: { required: true },
  access: {
    'marketing.user': ['read', 'write', 'create'],
    'marketing.manager': [...ALL, 'export', 'import'],
  },
  fields: {
    list: f.many2one('marketing.list', { required: true, ondelete: 'cascade', index: true }),
    email: f.char({ required: true, size: 254, label: 'Email' }),
    /** The address as it is compared: trimmed, lower case. */
    key: f.char({
      store: true,
      index: true,
      ...compute('marketing.subscriber', 'key', ['email'], (subscribers) => {
        for (const s of subscribers) s.key = emailKey(s.email) ?? '';
      }),
    }),
    name: f.char({ label: 'Name' }),
    phone: f.char({ label: 'Phone' }),
    partner: f.many2one('res.partner', { ondelete: 'set null', index: true, label: 'Contact' }),
    language: f.selection(LANGUAGES, {
      required: true,
      default: 'en',
      label: 'Language',
      help: 'The language of the words the server adds to a message: why it came, and how to unsubscribe.',
    }),
    state: f.selection(
      { subscribed: 'Subscribed', unsubscribed: 'Unsubscribed', bounced: 'Bounced' },
      {
        required: true,
        default: 'subscribed',
        label: 'Status',
        help: 'Only subscribed addresses are written to. Unsubscribed: they asked out. Bounced: the address does not take mail.',
      },
    ),
    unsubscribedAt: f.datetime({ label: 'Unsubscribed at', groups: { write: [...SYSTEM] } }),
    note: f.char(),
  },
  sqlConstraints: {
    once: { unique: ['list', 'key'], message: 'This address is on the list already.' },
  },
  constraints: {
    address: {
      ...check('marketing.subscriber', ['email'], (subscribers) =>
        [...subscribers].filter((s) => emailKey(s.email) === null).map((s) => s.id),
      ),
      message: ADDRESS,
    },
  },
});

export const MarketingSuppression = defineModel('marketing.suppression', {
  label: 'Never-email address',
  recName: 'email',
  order: ['email asc'],
  companyScoped: { required: true },
  access: { 'marketing.user': READ, 'marketing.manager': [...ALL, 'export', 'import'] },
  fields: {
    email: f.char({ size: 254, label: 'Email' }),
    phone: f.char({
      size: 32,
      label: 'Phone',
      help: 'With its country code: +8801711000001. No text campaign writes to it.',
    }),
    key: f.char({
      store: true,
      index: true,
      ...compute('marketing.suppression', 'key', ['email', 'phone'], (rows) => {
        for (const r of rows) r.key = emailKey(r.email) ?? phoneKey(r.phone) ?? '';
      }),
    }),
    reason: f.selection(
      {
        unsubscribed: 'Unsubscribed',
        bounced: 'Bounced',
        complaint: 'Complained',
        manual: 'Added by hand',
      },
      {
        required: true,
        default: 'manual',
        label: 'Why',
        help: 'Why no campaign writes to this address. Unsubscribed: they asked out from a message.',
      },
    ),
    note: f.char(),
  },
  sqlConstraints: {
    once: {
      unique: ['company', 'key'],
      message: 'This address is on the never-email list already.',
    },
  },
  constraints: {
    address: {
      ...check('marketing.suppression', ['email', 'phone'], (rows) =>
        [...rows]
          .filter((r) => {
            const email = (r.email ?? '').trim();
            const phone = (r.phone ?? '').trim();
            // One of the two, and a real one.
            if ((email === '') === (phone === '')) return true;
            return email !== '' ? emailKey(email) === null : phoneKey(phone) === null;
          })
          .map((r) => r.id),
      ),
      message:
        'Write an email address (name@example.com) or a phone number with its country code (+8801711000001): one of the two.',
    },
  },
});

/** Whether a campaign has nothing to say: an email its subject and message, a text its text. */
const wordless = (c: {
  channel: string;
  subject: string | null;
  body: string | null;
  text: string | null;
}): boolean =>
  c.channel === 'email'
    ? (c.subject ?? '').trim() === '' || (c.body ?? '').trim() === ''
    : (c.text ?? '').trim() === '';

/** The campaigns among these that cannot go out: nothing to say, or nobody to write to. */
const notReady = records('marketing.campaign', async (campaigns) =>
  [...(await campaigns.load({ lists: true, tags: true }))]
    .filter((c) => wordless(c) || ([...c.lists].length === 0 && [...c.tags].length === 0))
    .map((c) => c.id),
);
/** The same, with no time to send at. */
const notSchedulable = records('marketing.campaign', async (campaigns) =>
  [...(await campaigns.load({ lists: true, tags: true }))]
    .filter(
      (c) =>
        c.scheduledAt === null ||
        wordless(c) ||
        ([...c.lists].length === 0 && [...c.tags].length === 0),
    )
    .map((c) => c.id),
);
const NOT_READY =
  'Not ready: an email needs a subject and a message, a text message its text, and both a mailing list or a contact tag to send to.';

const counter = (label: string, help?: string) =>
  f.integer({
    default: 0,
    label,
    groups: { write: [...SYSTEM] },
    ...(help === undefined ? {} : { help }),
  });

export const MarketingCampaign = defineModel('marketing.campaign', {
  label: 'Campaign',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state', 'subject', 'subjectB', 'scheduledAt'],
  access: {
    'marketing.user': ['read', 'write', 'create'],
    'marketing.manager': [...ALL, 'export'],
  },
  fields: {
    name: f.char({ required: true, label: 'Name', help: 'For you: recipients do not see it.' }),
    channel: f.selection(CHANNELS, {
      required: true,
      default: 'email',
      label: 'Sent by',
      help: 'Email, or a text message to phone numbers: SMS or WhatsApp, through the text provider of the server.',
    }),
    text: f.text({
      label: 'Text message',
      help: 'What an SMS or WhatsApp campaign says. {{name}} and {{first_name}} are filled per person. Keep it short: a long SMS is billed as several.',
    }),
    countryCode: f.char({
      size: 5,
      label: 'Country code for local numbers',
      help: 'Numbers written without one (01711…) take it in place of their leading zero: +880. Empty: such numbers are left out.',
    }),
    stopLink: f.boolean({
      default: true,
      label: 'Add the way to unsubscribe',
      help: 'Ends a text message with a link that takes the number off. Email always has it.',
    }),
    subject: f.char({
      label: 'Subject',
      help: 'What recipients read first. {{name}}, {{first_name}} and {{email}} are filled per person; {{first_name|friend}} says what to write when the name is not known.',
    }),
    subjectB: f.char({
      label: 'Subject B',
      help: 'A second subject to try: every other recipient gets it, and the figures show which was opened more.',
    }),
    preheader: f.char({
      label: 'Preview text',
      help: 'The line a mail client shows after the subject.',
    }),
    body: f.html({
      label: 'Message',
      help: 'Links are counted when clicked. The way to unsubscribe is added by the server to every message.',
    }),
    lists: f.many2many('marketing.list', {
      relation: 'marketing_campaign_list',
      label: 'To the lists',
    }),
    tags: f.many2many('res.partner.tag', {
      relation: 'marketing_campaign_tag',
      label: 'To contacts tagged',
      help: 'The contacts you may see that carry one of these tags and have an email address — a phone number for a text campaign.',
    }),
    replyTo: f.char({
      label: 'Replies to',
      help: 'Where a reply goes; empty: the sender’s address.',
    }),
    scheduledAt: f.datetime({ label: 'Send at' }),
    startedAt: f.datetime({ label: 'Started at', groups: { write: [...SYSTEM] } }),
    sentAt: f.datetime({ label: 'Finished at', groups: { write: [...SYSTEM] } }),
    recipients: counter('Recipients', 'Addresses the campaign writes to, each once.'),
    skipped: counter(
      'Left out',
      'Addresses on the never-email list, and addresses that are not addresses.',
    ),
    sent: counter('Sent'),
    failed: counter('Not sent', 'Messages the mail server refused.'),
    opened: counter('Opened', 'Recipients who opened it, each once.'),
    clicked: counter('Clicked', 'Recipients who followed a link, each once.'),
    unsubscribed: counter('Unsubscribed'),
    bounced: counter(
      'Bounced',
      'Messages that went out and came back: the address did not take them.',
    ),
    sentA: counter('Sent with A'),
    openedA: counter('Opened with A'),
    clickedA: counter('Clicked with A'),
    sentB: counter('Sent with B'),
    openedB: counter('Opened with B'),
    clickedB: counter('Clicked with B'),
    openRate: f.decimal({
      scale: 1,
      label: 'Opened %',
      help: 'Recipients who opened it, of those it was sent to. Mail clients that hide pictures are not counted.',
      ...compute('marketing.campaign', 'openRate', ['opened', 'sent'], (campaigns) => {
        for (const c of campaigns) {
          const rate = percent(c.opened ?? 0, c.sent ?? 0);
          c.openRate = orm.toDecimal(rate ?? '0');
        }
      }),
    }),
    clickRate: f.decimal({
      scale: 1,
      label: 'Clicked %',
      help: 'Recipients who followed a link, of those it was sent to.',
      ...compute('marketing.campaign', 'clickRate', ['clicked', 'sent'], (campaigns) => {
        for (const c of campaigns) {
          const rate = percent(c.clicked ?? 0, c.sent ?? 0);
          c.clickRate = orm.toDecimal(rate ?? '0');
        }
      }),
    }),
    openRateA: f.decimal({
      scale: 1,
      label: 'Opened % with A',
      help: 'Of the recipients who got subject A.',
      ...compute('marketing.campaign', 'openRateA', ['openedA', 'sentA'], (campaigns) => {
        for (const c of campaigns) {
          const rate = percent(c.openedA ?? 0, c.sentA ?? 0);
          c.openRateA = orm.toDecimal(rate ?? '0');
        }
      }),
    }),
    openRateB: f.decimal({
      scale: 1,
      label: 'Opened % with B',
      help: 'Of the recipients who got subject B.',
      ...compute('marketing.campaign', 'openRateB', ['openedB', 'sentB'], (campaigns) => {
        for (const c of campaigns) {
          const rate = percent(c.openedB ?? 0, c.sentB ?? 0);
          c.openRateB = orm.toDecimal(rate ?? '0');
        }
      }),
    }),
    state: f.state({
      states: {
        draft: 'Draft',
        scheduled: 'Scheduled',
        sending: 'Sending',
        sent: 'Sent',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      help: 'Scheduled: it starts by itself at its time. Sending: the server writes to the recipients, a batch at a time. Sent: every message went out or was refused.',
      transitions: {
        schedule: {
          from: ['draft'],
          to: 'scheduled',
          requires: 'marketing.send',
          guard: notSchedulable,
          message: `Say when to send it (Send at). ${NOT_READY}`,
          // It starts as the person who scheduled it: the tagged contacts are the ones they may see.
          after: records('marketing.campaign', async (campaigns) => {
            const env = campaigns.env as unknown as Env;
            for (const c of await campaigns.load(['scheduledAt'])) {
              if (c.scheduledAt === null) continue;
              const at = new Date(c.scheduledAt as unknown as string | Date);
              await env.enqueue(
                START_JOB,
                { campaign: c.id, at: at.toISOString() },
                { key: `${START_JOB}:${c.id}:${at.toISOString()}`, runAt: at },
              );
            }
          }),
        },
        unschedule: { from: ['scheduled'], to: 'draft' },
        send: emitting('marketing.campaign.sending', {
          from: ['draft', 'scheduled'],
          to: 'sending',
          requires: 'marketing.send',
          guard: notReady,
          message: NOT_READY,
          before: records('marketing.campaign', async (campaigns): Promise<void> => {
            for (const c of await campaigns.load(['channel'])) {
              if (transportReady[c.channel]) continue;
              throw new orm.ValidationError(
                'marketing.campaign',
                ['state'],
                c.channel === 'email'
                  ? 'This server cannot send email yet.'
                  : `This server cannot send ${CHANNELS[c.channel]} messages yet.`,
                c.channel === 'email'
                  ? 'Set SMTP_URL and KOSH_BASE_URL (the address people reach the server at), then start it again.'
                  : 'Set the text provider (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and the sender number of the channel), then start it again.',
              );
            }
          }),
          after: records('marketing.campaign', async (campaigns) => {
            const env = campaigns.env as unknown as Env;
            await env.flush();
            for (const id of campaigns.ids) {
              await addressCampaign(env, id as number);
              await env.enqueue(SEND_JOB, { campaign: id }, { key: `${SEND_JOB}:${id}:0` });
            }
          }),
        }),
        // The server's own step: every message went out or was refused.
        done: emitting('marketing.campaign.sent', {
          from: ['sending'],
          to: 'sent',
          guard: records('marketing.campaign', async (campaigns): Promise<number[]> => {
            const env = campaigns.env as unknown as Env;
            const ids = campaigns.ids.map(Number);
            const busy = await env.sql<{ id: number }>`
              SELECT DISTINCT campaign_id AS id FROM marketing_delivery
               WHERE campaign_id = ANY(${ids}::bigint[]) AND state = 'queued'`;
            return busy.map((r) => Number(r.id));
          }),
          message: 'Messages are still waiting to be sent.',
        }),
        cancel: {
          from: ['draft', 'scheduled', 'sending'],
          to: 'cancel',
          requires: 'marketing.send',
          // What was not sent yet is not sent.
          after: records('marketing.campaign', async (campaigns) => {
            const env = campaigns.env as unknown as Env;
            await env.asSuperuser({ reason: 'campaign cancelled' }, async (su) => {
              const waiting = await su.model('marketing.delivery').search({
                where: { campaign: { in: [...campaigns.ids] }, state: 'queued' } as never,
              });
              if (waiting.length > 0)
                await waiting.write({ state: 'skipped', error: 'The campaign was cancelled.' });
              await su.flush();
              for (const id of campaigns.ids) await refreshStats(su, id as number);
            });
          }),
        },
      },
    }),
  },
  constraints: {
    // What went out is what the figures are about.
    lockedOnceStarted: {
      ...check(
        'marketing.campaign',
        ['channel', 'subject', 'subjectB', 'body', 'preheader', 'text', 'lists', 'tags'],
        async (campaigns) =>
          [...(await campaigns.load(['state']))]
            .filter((c) => c.state === 'sending' || c.state === 'sent')
            .map((c) => c.id),
      ),
      message: 'A campaign that has started is not rewritten: copy it to send something else.',
    },
  },
});

export const MarketingDelivery = defineModel('marketing.delivery', {
  label: 'Campaign message',
  recName: 'email',
  order: ['id desc'],
  companyScoped: { required: true },
  // Written by the server only: who a campaign wrote to, and what they did with it.
  access: { 'marketing.user': READ, 'marketing.manager': [...READ, 'export'] },
  fields: {
    campaign: f.many2one('marketing.campaign', {
      required: true,
      ondelete: 'cascade',
      index: true,
    }),
    email: f.char({ size: 254, index: true, label: 'Email' }),
    phone: f.char({ size: 32, index: true, label: 'Phone' }),
    name: f.char({ label: 'Name' }),
    language: f.selection(LANGUAGES, {
      required: true,
      default: 'en',
      label: 'Language',
      help: 'The language of the words the server added to the message.',
    }),
    subscriber: f.many2one('marketing.subscriber', { ondelete: 'set null', index: true }),
    partner: f.many2one('res.partner', { ondelete: 'set null', index: true, label: 'Contact' }),
    variant: f.selection(
      { a: 'A', b: 'B' },
      { required: true, default: 'a', label: 'Subject', help: 'Which of the two subjects it got.' },
    ),
    state: f.selection(
      {
        queued: 'Waiting',
        sent: 'Sent',
        bounced: 'Bounced',
        failed: 'Not sent',
        skipped: 'Left out',
      },
      {
        required: true,
        default: 'queued',
        label: 'Status',
        help: 'Left out: the address is on the never-email list, or the campaign was cancelled. Not sent: the mail server refused it. Bounced: it went out and came back.',
      },
    ),
    /** The mail server's id of the message: a bounce names it. */
    providerId: f.char({ index: true }),
    /** The hash of the secret in this recipient's links (the secret itself is only in their message). */
    tokenHash: f.char({ size: 64, index: true }),
    sentAt: f.datetime({ label: 'Sent at' }),
    openedAt: f.datetime({ label: 'Opened at' }),
    opens: f.integer({ default: 0, label: 'Opens' }),
    clickedAt: f.datetime({ label: 'Clicked at' }),
    clicks: f.integer({ default: 0, label: 'Clicks' }),
    unsubscribedAt: f.datetime({ label: 'Unsubscribed at' }),
    error: f.char({ label: 'Why not' }),
  },
});

export const MarketingLink = defineModel('marketing.link', {
  label: 'Campaign link',
  recName: 'url',
  order: ['campaign asc', 'position asc'],
  companyScoped: { required: true },
  access: { 'marketing.user': READ, 'marketing.manager': [...READ, 'export'] },
  fields: {
    campaign: f.many2one('marketing.campaign', {
      required: true,
      ondelete: 'cascade',
      index: true,
    }),
    position: f.integer({ required: true, label: 'No.' }),
    url: f.char({ required: true, size: 2000, label: 'Link' }),
    clicks: f.integer({ default: 0, label: 'Clicks' }),
  },
  sqlConstraints: {
    once: { unique: ['campaign', 'position'], message: 'A link has one place in its campaign.' },
  },
});

interface Person {
  readonly email: string | null;
  readonly phone: string | null;
  readonly key: string;
  readonly name: string;
  readonly language: MailLanguage;
  readonly subscriber: number | null;
  readonly partner: number | null;
}

/**
 * Decides who a campaign writes to and makes its messages: the subscribed addresses of its lists, then the
 * contacts — the ones the sender may see — that carry one of its tags; each address once; the never-email list
 * left out, on record. The body's links are numbered for counting.
 */
export async function addressCampaign(env: Env, id: number): Promise<void> {
  const [c] = await env
    .model('marketing.campaign')
    .browse([id] as never)
    .load({ lists: true, tags: true, company: true });
  if (c === undefined) return;
  const company = c.company.id;
  const byText = c.channel !== 'email';
  const people = new Map<string, Person>();
  let invalid = 0;
  const listIds = [...c.lists].map((l) => l.id as number);
  if (listIds.length > 0) {
    const rows = await env.sql<{
      id: number;
      email: string;
      key: string;
      phone: string | null;
      name: string | null;
      language: string;
      partner_id: number | null;
    }>`SELECT id, email, key, phone, name, language, partner_id FROM marketing_subscriber
        WHERE list_id = ANY(${listIds}::bigint[]) AND state = 'subscribed' ORDER BY id`;
    for (const r of rows) {
      // A text campaign knows a person by their number; a subscriber without one is not its to write to.
      const phone = byText ? phoneKey(r.phone, c.countryCode) : null;
      const key = byText ? (phone ?? '') : r.key;
      if (key === '') {
        if (!byText || (r.phone ?? '').trim() !== '') invalid += 1;
      } else if (!people.has(key))
        people.set(key, {
          email: r.email.trim(),
          phone,
          key,
          name: r.name ?? '',
          language: r.language === 'bn' ? 'bn' : 'en',
          subscriber: Number(r.id),
          partner: r.partner_id === null ? null : Number(r.partner_id),
        });
    }
  }
  const tagIds = [...c.tags].map((t) => t.id as number);
  if (tagIds.length > 0) {
    // As the sender: record rules decide which contacts are theirs to write to.
    const contacts = await env.model('res.partner').search({
      where: {
        tags: { any: { id: { in: tagIds } } },
        ...(byText ? {} : { email: { isNull: false } }),
      } as never,
      order: ['id asc'],
    });
    for (const p of await contacts.load(['name', 'email', 'lang', 'mobile', 'phone'])) {
      const written = byText ? (p.mobile ?? p.phone ?? '') : (p.email ?? '');
      const phone = byText ? phoneKey(written, c.countryCode) : null;
      const key = byText ? phone : emailKey(written);
      if (key === null) {
        if (written.trim() !== '') invalid += 1;
        continue;
      }
      if (!people.has(key))
        people.set(key, {
          email: (p.email ?? '').trim() === '' ? null : (p.email ?? '').trim(),
          phone,
          key,
          name: p.name,
          language: p.lang === 'bn' ? 'bn' : 'en',
          subscriber: null,
          partner: p.id as number,
        });
    }
  }
  await env.asSuperuser({ reason: 'campaign addressed' }, async (su) => {
    const never = new Set(
      (
        await su.sql<{ key: string }>`
          SELECT key FROM marketing_suppression WHERE company_id = ${company}`
      ).map((r) => r.key),
    );
    const hasB = !byText && (c.subjectB ?? '').trim() !== '';
    let position = 0;
    let skipped = invalid;
    const rows: Record<string, unknown>[] = [];
    for (const p of people.values()) {
      // Whoever said stop is left out, by the address or by the number.
      const out = never.has(p.key) || (byText && never.has(emailKey(p.email) ?? ''));
      if (out) skipped += 1;
      rows.push({
        campaign: id,
        company,
        email: p.email,
        phone: p.phone,
        name: p.name,
        language: p.language,
        subscriber: p.subscriber,
        partner: p.partner,
        variant: out ? 'a' : variantOf(position, hasB),
        state: out ? 'skipped' : 'queued',
        error: out ? 'On the never-email list.' : null,
      });
      if (!out) position += 1;
    }
    for (let i = 0; i < rows.length; i += 1000)
      await su.model('marketing.delivery').create(rows.slice(i, i + 1000) as never);
    const links = byText ? [] : linksOf(c.body ?? '');
    if (links.length > 0)
      await su
        .model('marketing.link')
        .create(links.map((url, n) => ({ campaign: id, company, position: n, url })) as never);
    await su
      .model('marketing.campaign')
      .browse([id] as never)
      .write({ recipients: position, skipped, startedAt: new Date() } as never);
    await su.flush();
  });
}

/** The campaign's figures counted again from its messages. */
export async function refreshStats(su: Env, id: number): Promise<void> {
  const [n] = await su.sql<Record<string, string | number>>`
    SELECT count(*) FILTER (WHERE state IN ('queued', 'sent', 'failed')) AS recipients,
           count(*) FILTER (WHERE state IN ('sent', 'bounced')) AS sent,
           count(*) FILTER (WHERE state = 'bounced') AS bounced,
           count(*) FILTER (WHERE state = 'failed') AS failed,
           count(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
           count(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
           count(*) FILTER (WHERE unsubscribed_at IS NOT NULL) AS unsubscribed,
           count(*) FILTER (WHERE state IN ('sent', 'bounced') AND variant = 'a') AS sent_a,
           count(*) FILTER (WHERE opened_at IS NOT NULL AND variant = 'a') AS opened_a,
           count(*) FILTER (WHERE clicked_at IS NOT NULL AND variant = 'a') AS clicked_a,
           count(*) FILTER (WHERE state IN ('sent', 'bounced') AND variant = 'b') AS sent_b,
           count(*) FILTER (WHERE opened_at IS NOT NULL AND variant = 'b') AS opened_b,
           count(*) FILTER (WHERE clicked_at IS NOT NULL AND variant = 'b') AS clicked_b
      FROM marketing_delivery WHERE campaign_id = ${id}`;
  const of = (key: string): number => Number(n?.[key] ?? 0);
  await su
    .model('marketing.campaign')
    .browse([id] as never)
    .write({
      recipients: of('recipients'),
      sent: of('sent'),
      failed: of('failed'),
      bounced: of('bounced'),
      opened: of('opened'),
      clicked: of('clicked'),
      unsubscribed: of('unsubscribed'),
      sentA: of('sent_a'),
      openedA: of('opened_a'),
      clickedA: of('clicked_a'),
      sentB: of('sent_b'),
      openedB: of('opened_b'),
      clickedB: of('clicked_b'),
    } as never);
  await su.flush();
}

/** A message ready to hand to the mailer, with the delivery it is. */
export interface Outgoing extends Composed {
  readonly delivery: number;
  readonly to: string;
  readonly replyTo: string | null;
}

/** A text message ready to hand to the text provider. */
export interface OutgoingText {
  readonly delivery: number;
  readonly channel: 'sms' | 'whatsapp';
  readonly to: string;
  readonly text: string;
}

/** The addresses a recipient's links use, from the secret in them. */
export const trackingOf = (base: string, token: string) => ({
  click: (n: number) => `${base}/api/v1/public/campaigns/c/${token}/${n}`,
  open: `${base}/api/v1/public/campaigns/o/${token}.gif`,
  unsubscribe: `${base}/api/v1/public/campaigns/u/${token}`,
});

/**
 * Takes the campaign's next batch: each waiting message gets its secret, is composed and marked sent — in this
 * transaction; the caller hands them to the mailer once it has committed. Returns the messages and whether more
 * wait. A campaign that is no longer sending gives nothing.
 */
export async function takeBatch(
  su: Env,
  id: number,
  base: string,
  size: number = SEND_BATCH,
): Promise<{ mails: Outgoing[]; texts: OutgoingText[]; more: boolean }> {
  const [c] = await su
    .model('marketing.campaign')
    .browse([id] as never)
    .load({ company: true });
  if (c === undefined || c.state !== 'sending') return { mails: [], texts: [], more: false };
  const waiting = await su.sql<{
    id: number;
    email: string | null;
    phone: string | null;
    name: string | null;
    language: string;
    variant: string;
  }>`SELECT id, email, phone, name, language, variant FROM marketing_delivery
      WHERE campaign_id = ${id} AND state = 'queued' ORDER BY id LIMIT ${size + 1}
      FOR UPDATE SKIP LOCKED`;
  const links = [
    ...(await su
      .model('marketing.link')
      .search({ where: { campaign: id } as never, order: ['position asc'] })),
  ].map((l) => l.url);
  const mails: Outgoing[] = [];
  const texts: OutgoingText[] = [];
  const now = new Date();
  for (const d of waiting.slice(0, size)) {
    const token = randomBytes(24).toString('base64url');
    const language = d.language === 'bn' ? 'bn' : 'en';
    const who = { name: d.name ?? '', email: d.email ?? '' };
    await su
      .model('marketing.delivery')
      .browse([Number(d.id)] as never)
      .write({ state: 'sent', sentAt: now, tokenHash: hashToken(token) } as never);
    if (c.channel !== 'email') {
      texts.push({
        delivery: Number(d.id),
        channel: c.channel,
        to: d.phone ?? '',
        text: composeText({
          text: c.text ?? '',
          who,
          // Without the server's public address there is no link to give.
          unsubscribe:
            c.stopLink === true && base !== '' ? trackingOf(base, token).unsubscribe : null,
          language,
        }),
      });
      continue;
    }
    const composed = compose({
      subject:
        d.variant === 'b' && (c.subjectB ?? '').trim() !== ''
          ? (c.subjectB ?? '')
          : (c.subject ?? ''),
      preheader: c.preheader,
      body: c.body ?? '',
      who,
      links,
      tracking: trackingOf(base, token),
      language,
      sender: c.company.name,
    });
    mails.push({ ...composed, delivery: Number(d.id), to: d.email ?? '', replyTo: c.replyTo });
  }
  await su.flush();
  const more = waiting.length > size;
  await refreshStats(su, id);
  if (!more) {
    await su
      .model('marketing.campaign')
      .browse([id] as never)
      .write({ sentAt: now } as never);
    await su
      .model('marketing.campaign')
      .browse([id] as never)
      .done();
  }
  return { mails, texts, more };
}

/** Messages the mail server refused: on record, and out of the figures of what was sent. */
export async function markFailed(
  su: Env,
  failures: readonly { readonly delivery: number; readonly error: string }[],
): Promise<void> {
  const campaigns = new Set<number>();
  for (const failure of failures) {
    const [d] = await su
      .model('marketing.delivery')
      .browse([failure.delivery] as never)
      .load({ campaign: true });
    if (d === undefined) continue;
    await su
      .model('marketing.delivery')
      .browse([failure.delivery] as never)
      .write({ state: 'failed', error: failure.error.slice(0, 250) } as never);
    campaigns.add(d.campaign.id as number);
  }
  await su.flush();
  for (const id of campaigns) await refreshStats(su, id);
}

interface Found {
  readonly id: number;
  readonly campaign: number;
  readonly company: number;
  readonly variant: 'a' | 'b';
}

const found = (row: Record<string, unknown> | undefined): Found | null =>
  row === undefined
    ? null
    : {
        id: Number(row['id']),
        campaign: Number(row['campaign_id']),
        company: Number(row['company_id']),
        variant: row['variant'] === 'b' ? 'b' : 'a',
      };

/** Counts an open of the message with this secret; the first one counts for the campaign. */
export async function recordOpen(su: Env, token: string): Promise<boolean> {
  const hash = hashToken(token);
  const [row] = await su.sql<Record<string, unknown>>`
    UPDATE marketing_delivery SET opens = opens + 1, opened_at = coalesce(opened_at, now())
     WHERE token_hash = ${hash} AND state = 'sent'
    RETURNING id, campaign_id, company_id, variant, (opens = 1) AS first`;
  const d = found(row);
  if (d === null) return false;
  if (row?.['first'] === true) await countFirst(su, d, 'opened');
  return true;
}

async function countFirst(su: Env, d: Found, what: 'opened' | 'clicked'): Promise<void> {
  if (what === 'opened') {
    await su.sql`UPDATE marketing_campaign SET opened = opened + 1,
        opened_a = opened_a + ${d.variant === 'a' ? 1 : 0},
        opened_b = opened_b + ${d.variant === 'b' ? 1 : 0} WHERE id = ${d.campaign}`;
    return;
  }
  await su.sql`UPDATE marketing_campaign SET clicked = clicked + 1,
      clicked_a = clicked_a + ${d.variant === 'a' ? 1 : 0},
      clicked_b = clicked_b + ${d.variant === 'b' ? 1 : 0} WHERE id = ${d.campaign}`;
}

/**
 * Counts a click on link `n` of the message with this secret and says where it leads — a link of the campaign,
 * never an address from the request. Who clicks has opened.
 */
export async function recordClick(su: Env, token: string, n: number): Promise<string | null> {
  const hash = hashToken(token);
  const [before] = await su.sql<Record<string, unknown>>`
    SELECT id, campaign_id, company_id, variant, opened_at, clicked_at FROM marketing_delivery
     WHERE token_hash = ${hash} AND state = 'sent' FOR UPDATE`;
  const d = found(before);
  if (d === null || !Number.isInteger(n) || n < 0) return null;
  const [link] = await su.sql<{ id: number; url: string }>`
    UPDATE marketing_link SET clicks = clicks + 1
     WHERE campaign_id = ${d.campaign} AND position = ${n} RETURNING id, url`;
  if (link === undefined) return null;
  await su.sql`UPDATE marketing_delivery SET clicks = clicks + 1,
      clicked_at = coalesce(clicked_at, now()), opened_at = coalesce(opened_at, now()),
      opens = greatest(opens, 1) WHERE id = ${d.id}`;
  if (before?.['clicked_at'] === null) await countFirst(su, d, 'clicked');
  if (before?.['opened_at'] === null) await countFirst(su, d, 'opened');
  return link.url;
}

/** Who a secret belongs to, for the unsubscribe page: the address, masked, and whether they are out already. */
export async function unsubscribeView(
  su: Env,
  token: string,
): Promise<{ email: string; language: MailLanguage; done: boolean; sender: string } | null> {
  const [row] = await su.sql<Record<string, unknown>>`
    SELECT d.email, d.phone, d.language, d.unsubscribed_at, c.name AS sender, m.channel
      FROM marketing_delivery d JOIN res_company c ON c.id = d.company_id
      JOIN marketing_campaign m ON m.id = d.campaign_id
     WHERE d.token_hash = ${hashToken(token)}`;
  if (row === undefined) return null;
  const email = String(row['email'] ?? '');
  const phone = String(row['phone'] ?? '');
  const at = email.indexOf('@');
  return {
    // Enough to recognise, not enough to learn it from a forwarded link.
    email:
      row['channel'] !== 'email' && phone !== ''
        ? `${phone.slice(0, 4)}…${phone.slice(-2)}`
        : `${email.slice(0, Math.min(2, at))}…${email.slice(at)}`,
    language: row['language'] === 'bn' ? 'bn' : 'en',
    done: row['unsubscribed_at'] !== null,
    sender: String(row['sender']),
  };
}

/** What the mail server called each message: a bounce will name it. */
export async function saveProviderIds(
  su: Env,
  sent: readonly { readonly delivery: number; readonly id: string }[],
): Promise<void> {
  if (sent.length === 0) return;
  const ids = sent.map((s) => s.delivery);
  const names = sent.map((s) => s.id);
  await su.sql`UPDATE marketing_delivery d SET provider_id = t.name
      FROM unnest(${ids}::bigint[], ${names}::text[]) AS t(id, name) WHERE d.id = t.id`;
}

/** The campaign messages a bounce answers, each with its company. */
export async function bouncedDeliveries(
  su: Env,
  messageIds: readonly string[],
): Promise<{ id: number; company: number }[]> {
  if (messageIds.length === 0) return [];
  const rows = await su.sql<{ id: number; company_id: number }>`
    SELECT id, company_id FROM marketing_delivery
     WHERE provider_id = ANY(${[...messageIds]}::text[]) AND state = 'sent'`;
  return rows.map((r) => ({ id: Number(r.id), company: Number(r.company_id) }));
}

/**
 * A message came back (in its company): it is *bounced*, out of nobody's figures of what was read. When the
 * address will never take mail (`permanent`), its subscriber is *bounced* and the address goes on the never-email
 * list; a full mailbox changes nothing else.
 */
export async function recordBounce(
  su: Env,
  delivery: number,
  permanent: boolean,
  note: string,
): Promise<void> {
  const [d] = await su
    .model('marketing.delivery')
    .browse([delivery] as never)
    .load({ subscriber: true, campaign: true, company: true });
  if (d === undefined || d.state !== 'sent') return;
  await su
    .model('marketing.delivery')
    .browse([delivery] as never)
    .write({ state: 'bounced', error: note.slice(0, 250) } as never);
  if (permanent) {
    if (d.subscriber !== null && d.subscriber.state === 'subscribed')
      await su
        .model('marketing.subscriber')
        .browse([d.subscriber.id] as never)
        .write({ state: 'bounced' } as never);
    const key = emailKey(d.email);
    if (key !== null) {
      const there = await su.model('marketing.suppression').search({
        where: { company: d.company.id, key } as never,
        limit: 1,
      });
      if (there.length === 0)
        await su.model('marketing.suppression').create([
          {
            company: d.company.id,
            email: key,
            reason: 'bounced',
            note: `From the campaign ${d.campaign.name}`,
          },
        ] as never);
    }
  }
  await su.flush();
  await refreshStats(su, d.campaign.id as number);
}

/** The company of the message with this secret: what is done about it is done in that company. */
export async function companyOfToken(su: Env, token: string): Promise<number | null> {
  const [row] = await su.sql<{ company_id: number }>`
    SELECT company_id FROM marketing_delivery WHERE token_hash = ${hashToken(token)}`;
  return row === undefined ? null : Number(row.company_id);
}

/**
 * Takes the recipient of this secret off: their subscription is ended, and their address goes on the company's
 * never-email list — no later campaign writes to it, whichever list or tag it comes from. Once.
 */
export async function unsubscribe(su: Env, token: string): Promise<boolean> {
  const [d] = await su
    .model('marketing.delivery')
    .search({ where: { tokenHash: hashToken(token) } as never, limit: 1 })
    .then((r) => r.load({ subscriber: true, campaign: true, company: true }));
  if (d === undefined) return false;
  if (d.unsubscribedAt !== null) return true;
  const now = new Date();
  await su
    .model('marketing.delivery')
    .browse([d.id] as never)
    .write({ unsubscribedAt: now } as never);
  if (d.subscriber !== null && d.subscriber.state === 'subscribed')
    await su
      .model('marketing.subscriber')
      .browse([d.subscriber.id] as never)
      .write({ state: 'unsubscribed', unsubscribedAt: now } as never);
  // The address the message went to: a number for a text, an email otherwise.
  const number = phoneKey(d.phone);
  const key = number ?? emailKey(d.email);
  if (key !== null) {
    const there = await su.model('marketing.suppression').search({
      where: { company: d.company.id, key } as never,
      limit: 1,
    });
    if (there.length === 0)
      await su.model('marketing.suppression').create([
        {
          company: d.company.id,
          ...(number === null ? { email: key } : { phone: key }),
          reason: 'unsubscribed',
          note: `From the campaign ${d.campaign.name}`,
        },
      ] as never);
  }
  await su.flush();
  await su.sql`UPDATE marketing_campaign SET unsubscribed = unsubscribed + 1
    WHERE id = ${d.campaign.id as number}`;
  await su.emit('marketing.delivery.unsubscribed', { id: d.id });
  return true;
}

export const marketingShutro = defineModule({
  name: 'marketing',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro],
  groups: [
    // A campaign is sent to contacts by their tags: who writes one sees the contacts.
    orm.defineGroup({
      code: 'marketing.user',
      label: 'Campaigns: write and follow',
      implies: ['contacts.user'],
    }),
    orm.defineGroup({
      code: 'marketing.manager',
      label: 'Campaigns manager',
      implies: ['marketing.user'],
    }),
  ],
  permissions: [
    orm.definePermission({
      code: 'marketing.send',
      label: 'Send, schedule and cancel campaigns',
      groups: ['marketing.manager'],
    }),
  ],
  models: [
    MarketingList,
    MarketingSubscriber,
    MarketingSuppression,
    MarketingCampaign,
    MarketingDelivery,
    MarketingLink,
  ],
});
