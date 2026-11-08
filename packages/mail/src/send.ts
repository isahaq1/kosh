/**
 * Sending documents (RFC 0029 §3.3). Modules declare email templates (`mailTemplates`) and the documents sent from
 * their form (`sendable`: the template and the partner field). The Send dialog asks for the composition — the
 * partner's address, the template's subject and body filled in the partner's language, the PDF named — and sends
 * it, edited or not: the PDF is rendered and stored on the record, the message posted on its chatter with it, and
 * the email queued in `mail.outgoing` and sent by an outbox subscriber, so a failed send never undoes the record.
 */
import { chatterContext, postMessage } from '@kosh/messaging';
import type { KoshModule, SendableSpec } from '@kosh/modules-sdk';
import {
  type DocumentData,
  documentFields,
  fillText,
  loadDocumentData,
  renderDocument,
} from '@kosh/reporting';
import { HttpProblem, type ModuleContext, publicApiModels } from '@kosh/server';
import { type Env, orm } from '@kosh/server/orm';
import { openAttachment, saveAttachment, storageOf } from '@kosh/storage';
import { escapeHtml, layout, type Mailer } from './index.js';

const { defineModel, f } = orm;

type Row = Record<string, unknown>;

/** An email template (RFC 0029 §3.3): installed from manifests by key, edited by Email managers. */
const MailTemplate = defineModel('mail.template', {
  label: 'Email template',
  archivable: true,
  order: ['targetModel asc', 'name asc'],
  access: {
    'base.user': ['read'],
    'mail.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    name: f.char({ required: true, translate: true, label: 'Template' }),
    targetModel: f.char({ required: true, index: true, label: 'Document' }),
    /** `module.key` of the manifest template it came from, so reinstalls do not duplicate it. */
    key: f.char({ index: 'unique' }),
    subject: f.char({ required: true, translate: true, size: 998, label: 'Subject' }),
    body: f.text({
      required: true,
      translate: true,
      label: 'Body',
      help: 'Plain text with {{field}} placeholders (name, partner.name, amountTotal, company.name); a blank line starts a paragraph.',
    }),
    document: f.char({
      label: 'Attach the document',
      help: 'The document template sent as a PDF, as module.key (accounting.invoice); empty: no attachment.',
    }),
  },
});

/** An email sent from a record (RFC 0029 §3.3): queued with the record, sent by the outbox subscriber. */
const MailOutgoing = defineModel('mail.outgoing', {
  label: 'Sent email',
  order: ['id desc'],
  access: { 'mail.manager': ['read'] },
  indexes: [{ fields: ['resModel', 'resId'] }, { fields: ['state'] }],
  fields: {
    resModel: f.char({ required: true, label: 'Document' }),
    resId: f.integer({ required: true, label: 'Record' }),
    to: f.text({ required: true, label: 'To' }),
    cc: f.text({ label: 'Cc' }),
    subject: f.char({ required: true, size: 998, label: 'Subject' }),
    text: f.text({ label: 'Text' }),
    html: f.text({ label: 'HTML' }),
    attachments: f.many2many('storage.attachment', {
      relation: 'mail_outgoing_attachment_rel',
      label: 'Attachments',
    }),
    state: f.selection(
      { queued: 'Queued', sent: 'Sent', failed: 'Failed' },
      {
        required: true,
        default: 'queued',
        label: 'Status',
        help: 'Queued until the mail server took it; failed with the reason when it refused.',
      },
    ),
    error: f.text({ label: 'Error' }),
    providerId: f.char({ size: 998, label: 'Message id' }),
    sentAt: f.datetime({ label: 'Sent' }),
    author: f.many2one('res.users', { ondelete: 'set null', label: 'Sent by' }),
    message: f.many2one('mail.message', { ondelete: 'set null', label: 'Chatter message' }),
  },
});

/** The models of sending documents, added to the mail module's. */
export const SEND_MODELS: readonly unknown[] = [MailTemplate, MailOutgoing];

/** The sendable documents of the loaded modules, by model. */
export function sendablesOf(modules: readonly KoshModule[]): Map<string, SendableSpec> {
  const out = new Map<string, SendableSpec>();
  for (const m of modules) for (const s of m.sendable ?? []) out.set(s.model, s);
  return out;
}

/** Installs the manifests' email templates that do not exist yet (by `module.key`). */
export async function installMailTemplates(
  env: Env,
  modules: readonly KoshModule[],
): Promise<number> {
  let created = 0;
  const model = env.withFlags({ activeTest: false }).model('mail.template' as never) as unknown as {
    search(q: unknown): Promise<{ length: number }>;
    create(rows: unknown[]): Promise<unknown>;
  };
  for (const m of modules)
    for (const spec of m.mailTemplates ?? []) {
      const key = `${m.name}.${spec.key}`;
      if ((await model.search({ where: { key } })).length > 0) continue;
      const translations = Object.entries(spec.translations ?? {});
      await model.create([
        {
          name: spec.name,
          targetModel: spec.model,
          key,
          subject: {
            en_US: spec.subject,
            ...Object.fromEntries(translations.map(([l, t]) => [l, t.subject])),
          },
          body: {
            en_US: spec.body,
            ...Object.fromEntries(translations.map(([l, t]) => [l, t.body])),
          },
          ...(spec.document === undefined ? {} : { document: spec.document }),
        },
      ]);
      created++;
    }
  return created;
}

const LANGS: Readonly<Record<string, string>> = { en: 'en_US', bn: 'bn_BD' };

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** A list of addresses from the body: each checked, at most 20. */
function addresses(value: unknown, what: string): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;]/)
      : value === undefined || value === null
        ? []
        : null;
  if (list === null) throw bad(`${what} is a list of email addresses.`);
  const out = list.map((a) => String(a).trim()).filter((a) => a !== '');
  if (out.length > 20) throw bad(`At most 20 addresses in ${what}.`);
  const wrong = out.find((a) => !EMAIL.test(a));
  if (wrong !== undefined) throw bad(`${wrong} is not an email address.`);
  return out;
}

const bad = (detail: string) => new HttpProblem(400, 'invalid-body', 'Invalid email', detail);

const ref = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    browse(ids: readonly number[]): Rows;
    search(q: unknown): Promise<Rows>;
    create(rows: unknown[]): Promise<{ ids: readonly number[] }>;
  };
type Rows = {
  readonly ids: readonly number[];
  readonly length: number;
  load(spec: unknown): Promise<Rows>;
  read(keys: readonly string[]): Row[];
  write(values: unknown): Promise<void>;
};

/** What the Send dialog shows, filled in the partner's language. */
export interface Composition {
  readonly to: readonly { readonly name: string; readonly email: string | null }[];
  readonly subject: string;
  readonly body: string;
  /** The PDF that goes with it, or none. */
  readonly attachment: string | null;
  readonly lang: string;
  /** Emails sent from this record so far, and the last one's date. */
  readonly sent: number;
  readonly lastSentAt: string | null;
}

/** The send engine of one server. */
export interface SendEngine {
  readonly sendables: ReadonlyMap<string, SendableSpec>;
  compose(env: Env, model: string, id: number): Promise<Composition>;
  send(
    env: Env,
    model: string,
    id: number,
    input: { to?: unknown; cc?: unknown; subject?: unknown; body?: unknown; attach?: unknown },
  ): Promise<{ outgoing: number; message: number; attachment: number | null }>;
  deliver(su: Env, outgoing: number): Promise<void>;
  /** Sends each record as its template says, to its partner; the ones that cannot be sent are said why. */
  sendMany(env: Env, model: string, ids: readonly number[]): Promise<BatchResult>;
  /** Sends a record by itself (an `autoSend` event) when its partner asked for it; whether it was sent. */
  autoSend(env: Env, model: string, id: number): Promise<boolean>;
}

/** What a batch send did. */
export interface BatchResult {
  readonly sent: number;
  readonly skipped: readonly { readonly id: number; readonly reason: string }[];
}

/** The send engine of one server: the sendable documents, the models' metadata, the mailer. */
export function sendEngine(context: ModuleContext, mailer: () => Mailer | undefined): SendEngine {
  const apiModels = publicApiModels(context.registry);
  const fields = documentFields(apiModels);
  const modules = context.registry.loaded.modules;
  const sendables = sendablesOf(modules);
  const chatter = chatterContext(context);
  const served = new Set(apiModels.keys());
  const reporting = modules.some((m) => m.name === 'reporting');

  /** The record as the caller, matching the document's `when`; refused otherwise. */
  const sendable = async (env: Env, model: string, id: number) => {
    const spec = sendables.get(model);
    if (spec === undefined)
      throw new HttpProblem(404, 'not-sendable', 'Not sent by email', `${model} is not sendable.`);
    const found = await ref(env, model).search({
      where: { id, ...(spec.when ?? {}) },
      limit: 1,
    });
    if (found.length === 0) {
      const exists = (await ref(env, model).search({ where: { id }, limit: 1 })).length > 0;
      if (!exists) throw new HttpProblem(404, 'missing-record', 'Not found', 'No such record.');
      throw new HttpProblem(
        409,
        'not-ready',
        'Not ready to send',
        'This document cannot be sent in its state.',
      );
    }
    return spec;
  };

  const templateOf = async (env: Env, key: string) => {
    const [row] = (
      await (await ref(env, 'mail.template').search({ where: { key }, limit: 1 })).load([])
    ).read(['id', 'subject', 'body', 'document']);
    if (row === undefined)
      throw new HttpProblem(
        409,
        'no-template',
        'No email template',
        `The template ${key} is missing or archived: run the apps' defaults, or restore it.`,
      );
    return row;
  };

  /** The partner's name, address and language. */
  const partnerOf = async (env: Env, spec: SendableSpec, model: string, id: number) => {
    const [record] = (await ref(env, model).browse([id]).load([spec.partner])).read([spec.partner]);
    const value = record?.[spec.partner] as { id?: number } | number | null | undefined;
    const partnerId = typeof value === 'number' ? value : (value?.id ?? null);
    if (partnerId === null) return null;
    const hasLang = apiModels.get('res.partner')?.fields.some((f) => f.key === 'lang') === true;
    const keys = ['name', 'email', ...(hasLang ? ['lang'] : [])];
    const [p] = (await ref(env, 'res.partner').browse([partnerId]).load(keys)).read(keys);
    return p === undefined
      ? null
      : {
          name: String(p['name'] ?? ''),
          email: (p['email'] as string | null) ?? null,
          lang: (p['lang'] as string | null | undefined) ?? null,
        };
  };

  /** The subject and body filled for the record, in `lang`. */
  const fill = async (env: Env, model: string, id: number, subject: string, body: string) => {
    const layout = {
      paper: 'A4',
      blocks: [{ kind: 'text', id: 'mail', text: `${subject}\n${body}` }],
    } as never;
    const data = await loadDocumentData(env as never, model, [id], layout, fields);
    const lang = env.lang.replace('_', '-');
    const doc: DocumentData = {
      model,
      record: data.records[0] ?? {},
      company: data.company,
      user: data.user,
      now: new Date(),
      locale: lang,
      tz: env.tz,
    };
    return { subject: fillText(doc, fields, subject), body: fillText(doc, fields, body) };
  };

  /** The partner's language (`bn`, `en`, or a full code like `bn_BD`) as the environment's. */
  const languageOf = (env: Env, lang: string | null) => {
    const full = lang === null || lang === '' ? null : (LANGS[lang] ?? lang);
    try {
      return full === null ? env : env.withLang(full);
    } catch {
      return env;
    }
  };

  async function compose(env: Env, model: string, id: number): Promise<Composition> {
    const spec = await sendable(env, model, id);
    const partner = await partnerOf(env, spec, model, id);
    const local = languageOf(env, partner?.lang ?? null);
    const template = await templateOf(local, spec.template);
    const filled = await fill(
      local,
      model,
      id,
      String(template['subject'] ?? ''),
      String(template['body'] ?? ''),
    );
    const document = (template['document'] as string | null) ?? null;
    // How often it was sent: counted directly (the caller reads the record; the log itself is for Email managers).
    const [sent] = await env.sql<{ count: number; last: Date | null }>`
      SELECT count(*)::int AS count, max(created_at) AS last FROM mail_outgoing
      WHERE res_model = ${model} AND res_id = ${id} AND state <> 'failed'`;
    return {
      to: partner === null ? [] : [{ name: partner.name, email: partner.email }],
      ...filled,
      attachment: document !== null && reporting ? `${await nameOf(env, model, id)}.pdf` : null,
      lang: local.lang,
      sent: sent?.count ?? 0,
      lastSentAt: sent?.last instanceof Date ? sent.last.toISOString() : null,
    };
  }

  const nameOf = async (env: Env, model: string, id: number) => {
    const [row] = (await ref(env, model).browse([id]).load(['displayName'])).read(['displayName']);
    return String(row?.['displayName'] ?? `${model}-${id}`).replace(/[\\/:*?"<>|]+/g, '-');
  };

  async function send(
    env: Env,
    model: string,
    id: number,
    input: { to?: unknown; cc?: unknown; subject?: unknown; body?: unknown; attach?: unknown },
  ): Promise<{ outgoing: number; message: number; attachment: number | null }> {
    const spec = await sendable(env, model, id);
    if (mailer() === undefined)
      throw new HttpProblem(
        409,
        'no-mailer',
        'No email set up',
        'Set SMTP_URL to send documents by email.',
      );
    const to = addresses(input.to, 'to');
    const cc = addresses(input.cc, 'cc');
    if (to.length === 0) throw bad('Name at least one recipient.');
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (subject === '' || subject.length > 998) throw bad('The subject is 1 to 998 characters.');
    if (body.length > 50_000) throw bad('The body is at most 50,000 characters.');
    const template = await templateOf(env, spec.template);
    const documentKey = (template['document'] as string | null) ?? null;
    let attachment: number | null = null;
    if (input.attach !== false && documentKey !== null && reporting) {
      const [doc] = (
        await (
          await ref(env, 'report.template').search({ where: { key: documentKey }, limit: 1 })
        ).load([])
      ).read(['id', 'name', 'layout', 'scope']);
      const apiModel = apiModels.get(model);
      if (doc !== undefined && apiModel !== undefined) {
        const rendered = await renderDocument(
          env as never,
          apiModel,
          doc as never,
          fields,
          { ids: [id] },
          'pdf',
        );
        const saved = await saveAttachment(env as never, storageOf(context.app), served, {
          model,
          id,
          name: `${await nameOf(env, model, id)}.pdf`,
          mime: 'application/pdf',
          data: rendered.content,
        });
        attachment = saved.id;
      }
    }
    const posted = await postMessage(env as never, chatter, model, id, {
      kind: 'comment',
      text: `${subject}\n\n${body}`,
      attachments: attachment === null ? [] : [attachment],
    });
    const paragraphs = body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const mail = layout({ title: subject, paragraphs, lang: env.lang.slice(0, 2) });
    const outgoing = await env.asSuperuser({ reason: 'email queued from a record' }, async (su) => {
      const made = await ref(su, 'mail.outgoing').create([
        {
          resModel: model,
          resId: id,
          to: to.join(', '),
          cc: cc.length === 0 ? null : cc.join(', '),
          subject,
          text: body,
          html: mail.html,
          attachments: { set: attachment === null ? [] : [attachment] },
          author: env.uid,
          message: posted.id,
        },
      ]);
      return made.ids[0] as number;
    });
    await env.emit('mail.outgoing.queued', { outgoing, model, id });
    return { outgoing, message: posted.id, attachment };
  }

  /** Sends one queued email, as the system (the outbox subscriber). Sent once: a sent row is left alone. */
  async function deliver(su: Env, outgoing: number): Promise<void> {
    const [row] = (
      await ref(su, 'mail.outgoing').browse([outgoing]).load({ attachments: true })
    ).read(['to', 'cc', 'subject', 'text', 'html', 'state', 'attachments']);
    const m = mailer();
    if (row === undefined || row['state'] !== 'queued' || m === undefined) return;
    try {
      const files = [];
      for (const a of (row['attachments'] ?? []) as readonly ({ id: number } | number)[]) {
        const opened = await openAttachment(
          su as never,
          storageOf(context.app),
          served,
          typeof a === 'number' ? a : a.id,
        );
        const chunks: Buffer[] = [];
        for await (const chunk of opened.body) chunks.push(Buffer.from(chunk as Uint8Array));
        files.push({
          filename: opened.info.name,
          content: Buffer.concat(chunks),
          contentType: opened.info.mime,
        });
      }
      const cc = String(row['cc'] ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a !== '');
      const result = await m.send({
        to: String(row['to']),
        ...(cc.length === 0 ? {} : { cc }),
        subject: String(row['subject']),
        text: String(row['text'] ?? ''),
        html: String(row['html'] ?? escapeHtml(String(row['text'] ?? ''))),
        ...(files.length === 0 ? {} : { attachments: files }),
      });
      await ref(su, 'mail.outgoing')
        .browse([outgoing])
        .write({ state: 'sent', sentAt: new Date(), providerId: result.id });
    } catch (error) {
      await ref(su, 'mail.outgoing')
        .browse([outgoing])
        .write({
          state: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }

  /** The composition sent as it is, to the partner's address; refused (before any write) when it cannot be. */
  async function sendComposed(env: Env, model: string, id: number) {
    const c = await compose(env, model, id);
    const to = c.to.map((r) => r.email).filter((e): e is string => e !== null && e !== '');
    if (to.length === 0)
      throw new HttpProblem(
        409,
        'no-address',
        'No email address',
        `${c.to[0]?.name ?? 'The partner'} has no email address.`,
      );
    return send(env, model, id, { to, subject: c.subject, body: c.body });
  }

  async function sendMany(env: Env, model: string, ids: readonly number[]): Promise<BatchResult> {
    if (ids.length === 0 || ids.length > 100)
      throw new HttpProblem(400, 'invalid-body', 'Invalid batch', 'Send 1 to 100 records at once.');
    let sent = 0;
    const skipped: { id: number; reason: string }[] = [];
    for (const id of ids)
      try {
        await sendComposed(env, model, id);
        sent++;
      } catch (error) {
        // Refusals happen before anything is written (the record, its state, its address): the batch goes on.
        if (!(error instanceof HttpProblem) || error.problem.status >= 500) throw error;
        skipped.push({ id, reason: error.problem.detail ?? error.problem.title });
      }
    return { sent, skipped };
  }

  async function autoSend(env: Env, model: string, id: number): Promise<boolean> {
    const spec = sendables.get(model);
    if (spec?.autoSend === undefined || mailer() === undefined) return false;
    const found = await ref(env, model).search({ where: { id, ...(spec.when ?? {}) }, limit: 1 });
    if (found.length === 0) return false;
    const [record] = (await ref(env, model).browse([id]).load([spec.partner])).read([spec.partner]);
    const value = record?.[spec.partner] as { id?: number } | number | null | undefined;
    const partner = typeof value === 'number' ? value : (value?.id ?? null);
    if (partner === null) return false;
    const flag = spec.autoSend.flag;
    const [p] = (await ref(env, 'res.partner').browse([partner]).load([flag, 'email'])).read([
      flag,
      'email',
    ]);
    if (p?.[flag] !== true || typeof p['email'] !== 'string' || p['email'] === '') return false;
    await sendComposed(env, model, id);
    return true;
  }

  return { sendables, compose, send, deliver, sendMany, autoSend };
}
