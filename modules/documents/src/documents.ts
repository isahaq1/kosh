/**
 * Documents' logic (RFC 0024 §2.8): versions — each upload a stored file of the document, the latest its current
 * one —; one search over the documents and every record's attachments a user may read; share links that serve a
 * document or a folder's documents until they expire (and with the password, when set); and requests whose link
 * takes the file into the request's folder, once.
 */
import { randomBytes } from 'node:crypto';
import { layout, type Mailer } from '@kosh/mail';
import { digest, HttpProblem, hashPassword, verifyPassword } from '@kosh/server';
import { type Id, orm } from '@kosh/server/orm';
import { type Storage, saveAttachment } from '@kosh/storage';
import type { Env } from './.kosh/bindings.js';

const DOCS = new Set(['documents.document']);
const DAY = 86_400_000;
/** A date as `YYYY-MM-DD` (date-only values from PostgreSQL may read as local midnights). */
const dayOf = (v: unknown): string => {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
};

const notFound = (what: string): HttpProblem =>
  new HttpProblem(404, 'not-found', 'Not found', `There is no ${what}.`);

/** A new secret for a link: given once; only its digest is kept. */
export const newToken = (): string => randomBytes(24).toString('base64url');

/**
 * Stores `data` as the document's new version (the document read as the user first, so their rules apply); the
 * document's file, type, size and count of versions follow.
 */
export async function addVersion(
  env: Env,
  storage: Storage,
  id: number,
  file: { readonly name: string; readonly mime?: string | undefined; readonly data: Uint8Array },
): Promise<{ id: number; versions: number }> {
  const [doc] = await (
    await env.model('documents.document').search({
      where: { id: orm.asId(id, 'documents.document') },
      limit: 1,
    })
  ).load({});
  if (doc === undefined) throw notFound(`document ${id}`);
  return env.asSuperuser({ reason: 'document version' }, async (su) => {
    const saved = await saveAttachment(su as never, storage, DOCS, {
      model: 'documents.document',
      id: doc.id,
      name: file.name,
      mime: file.mime,
      data: file.data,
    });
    // The count of its files (thumbnails aside): every upload is one.
    const att = su.model('storage.attachment' as never) as unknown as {
      search(q: unknown): Promise<{ length: number }>;
    };
    const versions = (
      await att.search({
        where: { resModel: 'documents.document', resId: doc.id, variantOf: null },
      })
    ).length;
    await su
      .model('documents.document')
      .browse([doc.id])
      .write({ attachment: saved.id as never, mime: saved.mime, size: saved.size, versions });
    await su.flush();
    return { id: saved.id, versions };
  });
}

/** The versions of a document the user may read, newest first. */
export async function versionsOf(
  env: Env,
  id: number,
): Promise<
  { id: number; name: string; mime: string; size: number; at: string; by: number | null }[]
> {
  const [doc] = await (
    await env.model('documents.document').search({
      where: { id: orm.asId(id, 'documents.document') },
      limit: 1,
    })
  ).load({});
  if (doc === undefined) throw notFound(`document ${id}`);
  return env.asSuperuser({ reason: 'document versions' }, async (su) => {
    type Row = {
      id: number;
      name: string;
      mime: string;
      size: number;
      createdAt: Date;
      createdBy: { id: number } | null;
    };
    const att = su.model('storage.attachment' as never) as unknown as {
      search(q: unknown): Promise<{ load(f: unknown): Promise<Row[]> }>;
    };
    const rows = await (
      await att.search({
        where: { resModel: 'documents.document', resId: doc.id, variantOf: null },
        order: ['id desc'],
      })
    ).load({});
    return [...rows].map((r) => ({
      id: r.id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      at: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      by: r.createdBy?.id ?? null,
    }));
  });
}

/**
 * One search: the documents whose name matches, and the attachments of any record whose name matches — each kept
 * only when the user may read its record.
 */
export async function searchAll(
  env: Env,
  q: string,
  canRead: (model: string, id: number) => Promise<boolean>,
): Promise<{
  documents: { id: number; name: string; folder: string; mime: string | null }[];
  attachments: { id: number; name: string; model: string; record: number; mime: string }[];
}> {
  const text = q.trim().slice(0, 100);
  if (text === '') return { documents: [], attachments: [] };
  const docs = await (
    await env.model('documents.document').search({
      where: { name: { ilike: `%${text}%` } },
      limit: 50,
    })
  ).load({ folder: true });
  type Row = { id: number; name: string; mime: string; resModel: string; resId: number };
  const found = await env.asSuperuser({ reason: 'document search' }, async (su) => {
    const att = su.model('storage.attachment' as never) as unknown as {
      search(q: unknown): Promise<{ load(f: unknown): Promise<Row[]> }>;
    };
    return [
      ...(await (
        await att.search({
          where: {
            name: { ilike: `%${text}%` },
            variantOf: null,
            resModel: { ne: 'documents.document' },
          },
          order: ['id desc'],
          limit: 100,
        })
      ).load({})),
    ];
  });
  const attachments: { id: number; name: string; model: string; record: number; mime: string }[] =
    [];
  for (const a of found) {
    if (attachments.length >= 50) break;
    if (await canRead(a.resModel, a.resId))
      attachments.push({
        id: a.id,
        name: a.name,
        model: a.resModel,
        record: a.resId,
        mime: a.mime,
      });
  }
  return {
    documents: [...docs].map((d) => ({
      id: d.id,
      name: d.name,
      folder: d.folder.fullName ?? d.folder.name,
      mime: d.mime,
    })),
    attachments,
  };
}

/** A share link of a document or a folder the user may read, for `days` (1 to 90), with an optional password. */
export async function makeShare(
  env: Env,
  input: { document?: number; folder?: number; days?: number; password?: string },
): Promise<{ token: string; expiresAt: string }> {
  const days = input.days ?? 7;
  if (!Number.isSafeInteger(days) || days < 1 || days > 90)
    throw new HttpProblem(400, 'invalid-input', 'Invalid expiry', 'From 1 to 90 days.');
  if (input.document !== undefined) {
    const found = await env
      .model('documents.document')
      .search({ where: { id: orm.asId(input.document, 'documents.document') }, limit: 1 });
    if (found.length === 0) throw notFound(`document ${input.document}`);
  } else if (input.folder !== undefined) {
    const found = await env
      .model('documents.folder')
      .search({ where: { id: orm.asId(input.folder, 'documents.folder') }, limit: 1 });
    if (found.length === 0) throw notFound(`folder ${input.folder}`);
  } else throw new HttpProblem(400, 'invalid-input', 'Nothing to share', 'A document or a folder.');
  const password = input.password ?? '';
  if (password !== '' && password.length < 6)
    throw new HttpProblem(400, 'invalid-input', 'Short password', 'At least 6 characters.');
  const token = newToken();
  const expiresAt = new Date(Date.now() + days * DAY);
  await env.model('documents.share').create([
    {
      ...(input.document === undefined ? {} : { document: input.document as never }),
      ...(input.folder === undefined ? {} : { folder: input.folder as never }),
      tokenHash: digest(token),
      passwordHash: password === '' ? null : await hashPassword(password),
      expiresAt,
    },
  ]);
  await env.flush();
  return { token, expiresAt: expiresAt.toISOString() };
}

/**
 * What a share link opens (as the system): its document, or its folder's documents, while it has not expired or
 * been revoked, and with its password when it has one. @throws 404 for an unknown, expired or revoked link, 401
 * for a missing or wrong password
 */
export async function openShare(
  env: Env,
  token: string,
  password: string,
): Promise<{
  share: number;
  documents: {
    id: number;
    name: string;
    mime: string | null;
    size: number | null;
    attachment: number | null;
  }[];
}> {
  if (token === '' || token.length > 100) throw notFound('such link');
  const [share] = await (
    await env.model('documents.share').search({ where: { tokenHash: digest(token) }, limit: 1 })
  ).load({ document: true, folder: true });
  if (share === undefined || share.revoked || share.expiresAt.getTime() < Date.now())
    throw notFound('such link (it may have expired)');
  if (share.passwordHash !== null && !(await verifyPassword(password, share.passwordHash)))
    throw new HttpProblem(401, 'password', 'Password', 'This link needs its password.');
  const docs =
    share.document !== null
      ? await env.model('documents.document').browse([share.document.id]).load({})
      : await (
          await env.model('documents.document').search({
            where: { folder: share.folder?.id as Id<'documents.folder'> },
            order: ['name asc'],
          })
        ).load({});
  return {
    share: share.id,
    documents: [...docs].map((d) => ({
      id: d.id,
      name: d.name,
      mime: d.mime,
      size: d.size,
      attachment: d.attachment?.id ?? null,
    })),
  };
}

/** The storage key of an attachment (as the system). */
export async function keyOf(env: Env, attachment: number): Promise<string | null> {
  const att = env.model('storage.attachment' as never) as unknown as {
    browse(ids: number[]): { load(f: unknown): Promise<{ key: string }[]> };
  };
  const [a] = [...(await att.browse([attachment]).load(['key']))];
  return a?.key ?? null;
}

/** Who sends the requests and where their links point: set by the module. */
let config: { mailer: Mailer | undefined; apiUrl: string } = {
  mailer: undefined,
  apiUrl: 'http://localhost:3000',
};
export function configureRequests(next: { mailer: Mailer | undefined; apiUrl: string }): void {
  config = next;
}

/** As requests are sent: a new link each (only its digest kept), by email after the commit. */
export async function announceRequests(env: Env, ids: readonly number[]): Promise<void> {
  for (const r of await env
    .model('documents.request')
    .browse(ids as never)
    .load({ company: true })) {
    const token = newToken();
    await env
      .model('documents.request')
      .browse([r.id])
      .write({ tokenHash: digest(token), sentAt: new Date() });
    const due = r.dueDate === null ? null : dayOf(r.dueDate);
    mail(env, config.mailer, r.email, {
      title: `${r.company.name} asks you for a document`,
      paragraphs: [
        `${r.company.name} asks you for: ${r.name}.`,
        ...(r.message === null || r.message === '' ? [] : [r.message]),
        ...(due === null ? [] : [`Please send it by ${due}.`]),
      ],
      action: {
        label: 'Upload it',
        url: `${config.apiUrl}/api/v1/public/documents/requests/${token}`,
      },
    });
  }
}

function mail(
  env: Env,
  mailer: Mailer | undefined,
  to: string,
  content: { title: string; paragraphs: string[]; action: { label: string; url: string } },
): void {
  if (mailer === undefined) return;
  const body = layout(content);
  env.afterCommit(async () => {
    await mailer
      .send({ to, subject: content.title, html: body.html, text: body.text })
      .catch(() => undefined);
  });
}

/**
 * Reminds the sent requests that are late (past their due date, or a week after they were sent), once each: a new
 * link (the old one stops).
 */
export async function remindRequests(env: Env, now: Date = new Date()): Promise<number> {
  const { mailer, apiUrl } = config;
  const found = await (
    await env.model('documents.request').search({
      where: { state: 'sent', remindedAt: { isNull: true } } as never,
    })
  ).load({ company: true });
  let reminded = 0;
  for (const r of found) {
    const due =
      r.dueDate !== null
        ? new Date(`${dayOf(r.dueDate)}T23:59:59Z`)
        : new Date((r.sentAt?.getTime() ?? now.getTime()) + 7 * DAY);
    if (due.getTime() > now.getTime()) continue;
    const token = newToken();
    await env
      .model('documents.request')
      .browse([r.id])
      .write({ tokenHash: digest(token), remindedAt: now });
    mail(env, mailer, r.email, {
      title: `Reminder: ${r.company.name} is waiting for ${r.name}`,
      paragraphs: [`${r.company.name} is still waiting for: ${r.name}.`],
      action: { label: 'Upload it', url: `${apiUrl}/api/v1/public/documents/requests/${token}` },
    });
    reminded += 1;
  }
  await env.flush();
  return reminded;
}

/** The open request of a link (as the system), or null. */
export async function requestOf(
  env: Env,
  token: string,
): Promise<{ id: number; name: string; company: string; message: string | null } | null> {
  if (token === '' || token.length > 100) return null;
  const [r] = await (
    await env
      .model('documents.request')
      .search({ where: { tokenHash: digest(token), state: 'sent' }, limit: 1 })
  ).load({ company: true });
  return r === undefined
    ? null
    : { id: r.id, name: r.name, company: r.company.name, message: r.message };
}

/** Takes a request's file (as the system): a document in its folder with the file, the request received, once. */
export async function fulfil(
  env: Env,
  storage: Storage,
  token: string,
  file: { readonly name: string; readonly mime?: string | undefined; readonly data: Uint8Array },
): Promise<{ document: number }> {
  const open = await requestOf(env, token);
  if (open === null) throw notFound('open request for this link (it may be answered already)');
  const [r] = await env
    .model('documents.request')
    .browse([open.id as never])
    .load({ folder: true, partner: true, company: true });
  if (r === undefined) throw notFound('request');
  const made = await env.model('documents.document').create([
    {
      name: `${r.name} — ${r.partner?.name ?? r.email}`,
      folder: r.folder.id,
      company: r.company.id,
      owner: (r.createdBy as { id: number } | null)?.id ?? null,
      request: r.id,
    } as never,
  ]);
  const id = made.ids[0] as number;
  await env.flush();
  await addVersion(env, storage, id, file);
  const one = env.model('documents.request').browse([r.id]);
  await one.write({ document: id as never, tokenHash: null });
  await one.receive();
  await env.emit('documents.request.received', { id: r.id });
  await env.flush();
  return { document: id };
}
