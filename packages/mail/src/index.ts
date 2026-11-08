/**
 * @packageDocumentation
 * `@kosh/mail` (RFC 0006 §5.4): outbound email. A {@link Mailer} sends one message; {@link createSmtpMailer} is the
 * SMTP implementation (nodemailer: the one dependency, for SMTP with STARTTLS and authentication), and
 * {@link mailerFromEnv} reads `SMTP_URL` and `MAIL_FROM`. In development, `SMTP_URL=smtp://localhost:1025` points at
 * Mailpit (`pnpm dev:services`, inbox on http://localhost:8025). Inbound email (RFC 0006 part 7): replies to
 * notification emails post on the record (`inbound/`), through the provider's webhook; the Kosh module `mail`
 * serves the routes and the quarantine page for messages that match no one.
 */
import { chatterContext, messaging } from '@kosh/messaging';
import { defineModule } from '@kosh/modules-sdk';
import { base, HttpProblem, type ModuleContext } from '@kosh/server';
import { type Storage, storage, storageOf } from '@kosh/storage';
import { form, list } from '@kosh/views';
import nodemailer from 'nodemailer';
import {
  type ImapConfig,
  type InboundContext,
  imapConfigFromEnv,
  registerInboundRoutes,
  startPoller,
} from './inbound/index.js';
import { mailShutro } from './inbound/models.js';
import { installMailTemplates, sendEngine } from './send.js';

export {
  type BatchResult,
  type Composition,
  installMailTemplates,
  type SendEngine,
  sendablesOf,
} from './send.js';

import { type InboundConfig, inboundConfigFromEnv } from './inbound/token.js';

export * from './inbound/index.js';

/** One outbound message. */
export interface OutboundMail {
  readonly to: string;
  readonly subject: string;
  /** The plain-text part (every message has one). */
  readonly text: string;
  readonly html: string;
  readonly replyTo?: string;
  /** Copies (RFC 0029 §3.3). */
  readonly cc?: readonly string[];
  /** Files sent with it: a document's PDF. */
  readonly attachments?: readonly {
    readonly filename: string;
    readonly content: Uint8Array;
    readonly contentType: string;
  }[];
}

/** Sends messages; the provider's id of each, when it gives one. */
export interface Mailer {
  readonly name: string;
  readonly from: string;
  send(mail: OutboundMail): Promise<{ readonly id: string | null }>;
}

/** The SMTP mailer: `url` is `smtp://user:pass@host:port` (or `smtps://` for implicit TLS). */
export function createSmtpMailer(options: { readonly url: string; readonly from: string }): Mailer {
  const transport = nodemailer.createTransport(options.url);
  return {
    name: 'smtp',
    from: options.from,
    async send(mail) {
      const info = await transport.sendMail({
        from: options.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
        ...(mail.cc === undefined || mail.cc.length === 0 ? {} : { cc: [...mail.cc] }),
        ...(mail.attachments === undefined
          ? {}
          : {
              attachments: mail.attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.from(a.content),
                contentType: a.contentType,
              })),
            }),
      });
      return { id: typeof info.messageId === 'string' ? info.messageId : null };
    },
  };
}

/** A mailer from the environment (`SMTP_URL`, `MAIL_FROM`), or none when email is not configured. */
export function mailerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Mailer | undefined {
  const url = env['SMTP_URL'];
  if (url === undefined || url === '') return undefined;
  return createSmtpMailer({ url, from: env['MAIL_FROM'] ?? 'Shutro ERP <shutro-erp@localhost>' });
}

/** A mailer that keeps what it is given (tests, dry runs). */
export function createMemoryMailer(): Mailer & { readonly sent: OutboundMail[] } {
  const sent: OutboundMail[] = [];
  return {
    name: 'memory',
    from: 'Shutro ERP <shutro-erp@localhost>',
    sent,
    async send(mail) {
      sent.push(mail);
      return { id: `memory-${sent.length}` };
    },
  };
}

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * A plain, readable HTML email: a title, paragraphs, an optional button. Inline styles only (mail clients), a
 * `dir` for right-to-left languages, and nothing that needs images or scripts.
 */
export function layout(input: {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly url: string };
  /** Groups of lines under a linked heading (a digest: one per record). */
  readonly sections?: readonly {
    readonly heading: string;
    readonly url: string;
    readonly lines: readonly string[];
  }[];
  readonly footer?: string;
  readonly lang?: string;
  readonly dir?: 'ltr' | 'rtl';
}): { readonly html: string; readonly text: string } {
  const sections = (input.sections ?? [])
    .map(
      (s) =>
        `<h2 style="margin:20px 0 6px;font-size:15px"><a href="${escapeHtml(s.url)}" style="color:#1d4ed8;text-decoration:none">${escapeHtml(s.heading)}</a></h2>` +
        `<ul style="margin:0;padding-inline-start:20px;line-height:1.5">${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    )
    .join('\n    ');
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="${e(input.lang ?? 'en')}" dir="${input.dir ?? 'ltr'}">
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 16px;font-size:18px">${e(input.title)}</h1>
    ${input.paragraphs.map((p) => `<p style="margin:0 0 12px;line-height:1.5">${e(p)}</p>`).join('\n    ')}
    ${sections}
    ${
      input.action === undefined
        ? ''
        : `<p style="margin:20px 0 0"><a href="${e(input.action.url)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">${e(input.action.label)}</a></p>`
    }
    ${input.footer === undefined ? '' : `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${e(input.footer)}</p>`}
  </div>
</body>
</html>
`;
  const text = [
    input.title,
    '',
    ...input.paragraphs,
    ...(input.sections ?? []).flatMap((s) => [
      '',
      `${s.heading} (${s.url})`,
      ...s.lines.map((l) => `- ${l}`),
    ]),
    ...(input.action === undefined ? [] : ['', `${input.action.label}: ${input.action.url}`]),
    ...(input.footer === undefined ? [] : ['', input.footer]),
  ].join('\n');
  return { html, text };
}

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/mail',
  rfc: 'RFC 0006',
});

/** Options of {@link mailModule}: explicit settings (tests, installations wiring their own). */
export interface MailOptions {
  /** The reply address settings; default: `MAIL_INBOUND_SECRET`, `MAIL_INBOUND_DOMAIN`, `MAIL_INBOUND_ALIAS`. */
  readonly inbound?: InboundConfig | undefined;
  /** The webhook's shared secret; default `MAIL_INBOUND_WEBHOOK_SECRET`. Without one the webhook answers 404. */
  readonly webhookSecret?: string | undefined;
  /** The mailbox to poll; default `IMAP_URL`. Without one, no poller runs. */
  readonly imap?: ImapConfig | undefined;
  /** Start the poller and the sender (default: unless `KOSH_SCHEDULES=off`). */
  readonly workers?: boolean | undefined;
  /** The mailer documents are sent with (RFC 0029 §3.3); default: `SMTP_URL`. `null`: none. */
  readonly mailer?: Mailer | null | undefined;
}

/** The store attachments go to, or none when the installation has no file storage. */
function storageOrNone(app: object): Storage | undefined {
  try {
    return storageOf(app);
  } catch {
    return undefined;
  }
}

/** The mail module with explicit settings. */
export function mailModule(options: MailOptions = {}): ReturnType<typeof defineModule> {
  return defineModule({
    shutro: mailShutro,
    kosh: '^0.1.0',
    depends: [base, messaging, storage],
    app: {
      code: 'mail',
      label: 'Email',
      icon: 'mail',
      sequence: 950,
      category: 'Administration',
      summary:
        'Documents sent with their PDF, email templates, and replies posted on records or quarantined',
    },
    accessLevels: {
      manager: { label: 'Email manager (the inbound log)', groups: ['mail.manager'] },
    },
    actions: {
      'mail.action_inbound': { type: 'client', page: 'mail.Inbound', label: 'Inbound email' },
      'mail.action_templates': {
        model: 'mail.template',
        label: 'Email templates',
        views: ['list', 'form'],
      },
      'mail.action_outgoing': { model: 'mail.outgoing', label: 'Sent', views: ['list', 'form'] },
    },
    menus: [
      { id: 'mail.root', label: 'Email', app: 'mail' },
      { id: 'mail.inbound', parent: 'mail.root', label: 'Inbound', action: 'mail.action_inbound' },
      {
        id: 'mail.outgoing',
        parent: 'mail.root',
        label: 'Sent',
        action: 'mail.action_outgoing',
        sequence: 2,
      },
      {
        id: 'mail.templates',
        parent: 'mail.root',
        label: 'Email templates',
        action: 'mail.action_templates',
        sequence: 3,
      },
    ],
    views: {
      'mail.template.list': list('mail.template', {
        columns: ['name', 'targetModel', 'subject', 'document'],
      }),
      'mail.template.form': form('mail.template', (k) => ({
        header: { buttons: [] },
        sheet: [
          k.group('main', ['name', 'targetModel', 'subject', 'body', 'document'], {
            columns: 1,
            description:
              'Placeholders like {{name}} or {{partner.name}} are filled from the document; each language keeps its own text.',
          }),
        ],
      })),
      'mail.outgoing.list': list('mail.outgoing', {
        columns: ['createdAt', 'to', 'subject', 'resModel', 'author', 'state'],
      }),
      'mail.outgoing.form': form('mail.outgoing', (k) => ({
        header: { buttons: [], statusbar: 'state' },
        sheet: [
          k.group('main', ['to', 'cc', 'subject', 'resModel', 'resId', 'author', 'sentAt']),
          k.group('content', ['text', 'attachments', 'error', 'providerId'], { columns: 1 }),
        ],
      })),
    },
    search: {
      'mail.template': {
        fields: ['name', 'targetModel', 'subject'],
      },
      'mail.outgoing': {
        fields: ['to', 'subject'],
        filters: {
          failed: { label: 'Failed', domain: { state: 'failed' }, group: 'state' },
          queued: { label: 'Queued', domain: { state: 'queued' }, group: 'state' },
        },
        groupBy: ['state', 'resModel'],
      },
    },
    privateModels: ['mail.inbound_message'],
    hooks: {
      defaults: async (env, modules) =>
        `${await installMailTemplates(env as never, modules)} email template(s) installed`,
    },
    routes: (context: ModuleContext) => {
      const inbound: InboundContext = {
        shutro: context.shutro,
        driver: context.driver,
        registry: context.registry,
        auth: context.auth,
        storage: storageOrNone(context.app),
        config: options.inbound ?? inboundConfigFromEnv(),
        chatter: chatterContext(context),
      };
      registerInboundRoutes(context, inbound, {
        webhookSecret: options.webhookSecret ?? process.env['MAIL_INBOUND_WEBHOOK_SECRET'],
      });
      // Sending documents (RFC 0029 §3.3).
      const outbound =
        options.mailer === undefined ? mailerFromEnv() : (options.mailer ?? undefined);
      const engine = sendEngine(context, () => outbound);
      const target = (params: unknown) => {
        const p = params as { model?: unknown; id?: unknown };
        const id = Number(p.id);
        if (typeof p.model !== 'string' || !Number.isSafeInteger(id) || id <= 0)
          throw new HttpProblem(400, 'invalid-path', 'Invalid record', 'A model and a record id.');
        return { model: p.model, id };
      };
      context.app.get('/api/v1/mail/sendable', async () => ({
        models: [...engine.sendables.keys()],
        mailer: outbound !== undefined,
      }));
      context.app.get('/api/v1/mail/compose/:model/:id', async (request) => {
        const { model, id } = target(request.params);
        return request.env((env) => engine.compose(env as never, model, id));
      });
      context.app.post('/api/v1/mail/send/:model/:id', async (request) => {
        const { model, id } = target(request.params);
        return request.env(
          (env) => engine.send(env as never, model, id, (request.body ?? {}) as never),
          { write: true },
        );
      });
      context.app.post('/api/v1/mail/send-many/:model', async (request) => {
        const model = (request.params as { model?: unknown }).model;
        const ids = (request.body as { ids?: unknown } | null)?.ids;
        if (
          typeof model !== 'string' ||
          !Array.isArray(ids) ||
          !ids.every((i) => Number.isSafeInteger(i) && (i as number) > 0)
        )
          throw new HttpProblem(400, 'invalid-body', 'Invalid batch', '{ ids: [record ids] }.');
        return request.env((env) => engine.sendMany(env as never, model, ids as number[]), {
          write: true,
        });
      });
      // Background work is off in the CLI (kosh init, migrate), like the schedules.
      if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
      // Documents sent by themselves (`autoSend`): as the user whose change emitted the event.
      for (const [model, spec] of engine.sendables) {
        if (spec.autoSend === undefined) continue;
        const worker = context.shutro.subscribe(
          `mail.auto.${model}`,
          spec.autoSend.topic,
          async (event, env) => {
            const id = Number((event.payload as { id?: unknown } | null)?.id);
            if (!Number.isSafeInteger(id)) return;
            try {
              await engine.autoSend(env as never, model, id);
            } catch (error) {
              // A document that cannot be sent (no template, no storage) is logged, never retried forever.
              context.app.log.warn({ err: error, model, id }, 'automatic email not sent');
            }
          },
          { pollMs: 2000 },
        );
        worker.start();
        context.app.addHook('onClose', async () => {
          await worker.stop();
        });
      }
      const sender = context.shutro.subscribe(
        'mail.send',
        'mail.outgoing.queued',
        async (event, env) => {
          const id = Number((event.payload as { outgoing?: unknown } | null)?.outgoing);
          if (!Number.isSafeInteger(id)) return;
          await (env as never as Parameters<typeof engine.deliver>[0]).asSuperuser(
            { reason: 'email sent from a record' },
            (su) => engine.deliver(su, id),
          );
        },
        { pollMs: 2000 },
      );
      sender.start();
      context.app.addHook('onClose', async () => {
        await sender.stop();
      });
      const imap = options.imap ?? imapConfigFromEnv();
      if (imap === undefined) return;
      const poller = startPoller(inbound, imap, {
        pollMs: Number(process.env['MAIL_INBOUND_POLL_MS'] ?? 30_000),
        log: (message, error) => context.app.log.warn({ err: error }, message),
      });
      context.app.addHook('onClose', async () => {
        await poller.stop();
      });
    },
  });
}

/** The mail module: a technical module every installation has (the Email app shows for its managers only). */
export const mail: ReturnType<typeof defineModule> = mailModule();
