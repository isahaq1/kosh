/**
 * Sign's logic (RFC 0024 §2.8). Sending checks the template (its PDF, a signer for every role of its fields), keeps
 * the PDF's hash and asks the signers — the first in order, or all at once — each by email with a link of their
 * own. A signer asks for a one-time code by email (10 minutes, five tries), fills in their fields and signs (or
 * refuses, with why); the next signer is then asked. Once the last one signed the PDF is sealed with pdf-lib: each
 * value stamped where its field is, a certificate page added (who, their email and role, when, from which address,
 * the hash of the PDF that was sent), and the result stored — on the request, in Documents (Signed documents), and on
 * the record it was signed from — with its own hash.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Readable } from 'node:stream';
import { addVersion } from '@kosh/documents';
import { layout, type Mailer } from '@kosh/mail';
import { digest, HttpProblem } from '@kosh/server';
import { type Id, orm } from '@kosh/server/orm';
import { type Storage, saveAttachment } from '@kosh/storage';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { Env } from './.kosh/bindings.js';

const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const MAX_IMAGE = 300 * 1024;
const PNG = 'data:image/png;base64,';

const invalid = (field: string, detail: string): HttpProblem =>
  new HttpProblem(422, 'invalid-input', `Invalid ${field}`, detail);
const notFound = (): HttpProblem =>
  new HttpProblem(404, 'not-found', 'Not found', 'There is no signature waiting for this link.');
export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
/** Bytes are digested with the link: a code is never valid for another signer. */
const codeDigest = (signer: number, code: string): string => digest(`${signer}:${code}`);

let config: {
  mailer: Mailer | undefined;
  apiUrl: string;
  /** The file store, asked for when a PDF is read or written (a server may have none). */
  storage: (() => Storage) | null;
} = {
  mailer: undefined,
  apiUrl: 'http://localhost:3000',
  storage: null,
};
export function configureSign(next: Partial<typeof config>): void {
  config = { ...config, ...next };
}
const storageNow = (): Storage => {
  if (config.storage === null)
    throw new HttpProblem(503, 'no-storage', 'File storage unavailable', 'Files are not set up.');
  return config.storage();
};

function mail(
  env: Env,
  to: string,
  subject: string,
  paragraphs: string[],
  action?: { label: string; url: string },
) {
  const mailer = config.mailer;
  if (mailer === undefined) return;
  const body = layout({ title: subject, paragraphs, ...(action === undefined ? {} : { action }) });
  env.afterCommit(async () => {
    await mailer.send({ to, subject, html: body.html, text: body.text }).catch(() => undefined);
  });
}

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return new Uint8Array(Buffer.concat(chunks));
}

type Att = { id: number; key: string; name: string };
const attachments = (env: Env) =>
  env.model('storage.attachment' as never) as unknown as {
    browse(ids: number[]): { load(f: unknown): Promise<Att[]> };
  };

/** A template's PDF, as bytes. */
export async function templatePdf(env: Env, template: number): Promise<Uint8Array> {
  const [t] = await env
    .model('sign.template')
    .browse([template as never])
    .load({});
  if (t?.attachment === null || t?.attachment === undefined)
    throw invalid('template', 'The template has no PDF yet.');
  const [a] = [...(await attachments(env).browse([t.attachment.id]).load(['key']))];
  if (a === undefined) throw invalid('template', 'The template’s PDF is missing.');
  return readAll(await storageNow().read(a.key));
}

/** Stores a PDF as the template's (as the system, the template read by the caller): its page count follows. */
export async function setTemplatePdf(
  env: Env,
  template: number,
  file: { name: string; data: Uint8Array },
): Promise<{ pages: number }> {
  let pages: number;
  try {
    pages = (await PDFDocument.load(file.data)).getPageCount();
  } catch {
    throw invalid('file', 'This is not a PDF that can be read.');
  }
  const saved = await saveAttachment(env as never, storageNow(), new Set(['sign.template']), {
    model: 'sign.template',
    id: template,
    name: file.name,
    mime: 'application/pdf',
    data: file.data,
  });
  await env
    .model('sign.template')
    .browse([template as never])
    .write({ attachment: saved.id as never, pages });
  await env.flush();
  return { pages };
}

/** Asks a signer: a new link of their own, by email. */
async function ask(env: Env, signer: number): Promise<void> {
  const [s] = await env
    .model('sign.signer')
    .browse([signer as never])
    .load({ request: { company: true } });
  if (s === undefined) return;
  const token = randomBytes(24).toString('base64url');
  await env
    .model('sign.signer')
    .browse([s.id])
    .write({ tokenHash: digest(token), state: 'sent', sentAt: new Date() });
  const company = (s.request.company as { name?: string }).name ?? '';
  mail(
    env,
    s.email,
    `${company} asks you to sign ${s.request.name}`,
    [
      `${s.name}, ${company} asks you to sign ${s.request.name}${s.request.message === null ? '.' : `: ${s.request.message}`}`,
      'The link is yours alone; a code sent to this address confirms it is you.',
    ],
    { label: 'Review and sign', url: `${config.apiUrl}/api/v1/public/sign/${token}` },
  );
}

/**
 * As requests are sent: the template has its PDF and a signer for every role of its fields; the PDF's hash is
 * kept; the first signer (in order) or all of them are asked.
 */
export async function beforeSend(env: Env, ids: readonly number[]): Promise<void> {
  for (const r of await env
    .model('sign.request')
    .browse(ids as never)
    .load({ template: { fields: true }, signers: true })) {
    const roles = new Set([...r.template.fields].map((f) => f.role));
    const signers = [...r.signers].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
    if (signers.length === 0) throw invalid('signers', 'Add who signs.');
    const missing = [...roles].filter((role) => !signers.some((s) => s.role === role));
    if (missing.length > 0)
      throw invalid(
        'signers',
        `Nobody signs as ${missing.join(', ')}: add a signer for each role.`,
      );
    const pdf = await templatePdf(env, r.template.id);
    await env
      .model('sign.request')
      .browse([r.id])
      .write({ hashBefore: sha256(pdf) });
    for (const s of r.ordered ? signers.slice(0, 1) : signers) await ask(env, s.id);
  }
}

/** The signer a link belongs to, while they are asked and the request is out for signature. */
export async function signerOf(
  env: Env,
  token: string,
): Promise<{
  id: number;
  name: string;
  role: string;
  request: { id: number; name: string; company: string; message: string | null };
  fields: { id: number; kind: string; label: string | null; page: number; required: boolean }[];
} | null> {
  if (token === '' || token.length > 100) return null;
  const [s] = await (
    await env
      .model('sign.signer')
      .search({ where: { tokenHash: digest(token), state: 'sent' }, limit: 1 })
  ).load({ request: { template: { fields: true }, company: true } });
  if (s === undefined || s.request.state !== 'sent') return null;
  return {
    id: s.id,
    name: s.name,
    role: s.role,
    request: {
      id: s.request.id,
      name: s.request.name,
      company: (s.request.company as { name?: string }).name ?? '',
      message: s.request.message,
    },
    fields: [...s.request.template.fields]
      .filter((f) => f.role === s.role)
      .map((f) => ({ id: f.id, kind: f.kind, label: f.label, page: f.page, required: f.required })),
  };
}

/** A one-time code by email to the link's signer (a new one replaces the last). */
export async function sendCode(env: Env, token: string): Promise<void> {
  const s = await signerOf(env, token);
  if (s === null) throw notFound();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await env
    .model('sign.signer')
    .browse([s.id as never])
    .write({
      codeHash: codeDigest(s.id, code),
      codeExpiresAt: new Date(Date.now() + CODE_MINUTES * 60_000),
      codeAttempts: 0,
    });
  const [row] = await env
    .model('sign.signer')
    .browse([s.id as never])
    .load({});
  mail(env, row?.email ?? '', `Your code to sign ${s.request.name}: ${code}`, [
    `Your code is ${code}. It works for ${CODE_MINUTES} minutes.`,
    'If you did not ask for it, ignore this email.',
  ]);
  await env.flush();
}

/** A wrong or expired code: counted (the count commits), then answered with 401 by the route. */
export class WrongCode extends Error {}

/** Checks the code of the link's signer. @throws 429 after five wrong tries; {@link WrongCode} for a wrong one */
async function checkCode(env: Env, signer: number, code: string): Promise<void> {
  const [s] = await env
    .model('sign.signer')
    .browse([signer as never])
    .load({});
  if (s === undefined) throw notFound();
  if (s.codeAttempts >= MAX_TRIES)
    throw new HttpProblem(429, 'too-many-tries', 'Too many tries', 'Ask for a new code.');
  const ok =
    s.codeHash !== null &&
    s.codeExpiresAt !== null &&
    s.codeExpiresAt.getTime() > Date.now() &&
    s.codeHash === codeDigest(s.id, code.trim());
  if (!ok) {
    await env
      .model('sign.signer')
      .browse([s.id])
      .write({ codeAttempts: s.codeAttempts + 1 });
    await env.flush();
    throw new WrongCode();
  }
}

/** Checks what a signer filled in against their fields; the date is the server's. */
function cleanValues(
  fields: { id: number; kind: string; label: string | null; required: boolean }[],
  values: Record<string, unknown>,
  today: string,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of fields) {
    const raw = values[String(f.id)];
    const what = f.label ?? f.kind;
    if (f.kind === 'date') {
      out[String(f.id)] = today;
      continue;
    }
    if (f.kind === 'checkbox') {
      if (raw !== undefined && typeof raw !== 'boolean') throw invalid(what, 'is ticked or not.');
      if (f.required && raw !== true) throw invalid(what, 'must be ticked.');
      out[String(f.id)] = raw === true;
      continue;
    }
    if (raw === undefined || raw === null || raw === '') {
      if (f.required) throw invalid(what, 'is required.');
      continue;
    }
    if (typeof raw !== 'string') throw invalid(what, 'is text or a drawn signature.');
    if (f.kind === 'signature' || f.kind === 'initials') {
      if (!raw.startsWith(PNG) || raw.length > (MAX_IMAGE * 4) / 3 + PNG.length)
        throw invalid(what, 'is a drawn signature (a PNG of up to 300 KB).');
    } else if (raw.length > 200) throw invalid(what, 'is at most 200 characters.');
    out[String(f.id)] = raw;
  }
  return out;
}

/**
 * Signs for the link's signer with their code: their values kept with when and from where; the next signer asked
 * (in order), or — the last — the PDF sealed and the request completed.
 */
export async function signWith(
  env: Env,
  token: string,
  input: { code: string; values: Record<string, unknown>; ip: string; userAgent: string },
): Promise<{ completed: boolean }> {
  const s = await signerOf(env, token);
  if (s === null) throw notFound();
  await checkCode(env, s.id, input.code);
  const values = cleanValues(s.fields, input.values, env.today());
  await env
    .model('sign.signer')
    .browse([s.id as never])
    .write({
      values,
      state: 'signed',
      signedAt: new Date(),
      ip: input.ip.slice(0, 64),
      userAgent: input.userAgent.slice(0, 200),
      tokenHash: null,
      codeHash: null,
    });
  await env.flush();
  const [r] = await env
    .model('sign.request')
    .browse([s.request.id as never])
    .load({ signers: true });
  if (r === undefined) throw notFound();
  const waiting = [...r.signers]
    .filter((x) => x.state === 'waiting')
    .sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  if ([...r.signers].every((x) => x.state === 'signed')) {
    await seal(env, r.id);
    return { completed: true };
  }
  if (r.ordered && waiting[0] !== undefined) await ask(env, waiting[0].id);
  await env.flush();
  return { completed: false };
}

/** Refuses for the link's signer, with their code and why: the request is refused, the others told. */
export async function refuseWith(
  env: Env,
  token: string,
  input: { code: string; reason: string },
): Promise<void> {
  const s = await signerOf(env, token);
  if (s === null) throw notFound();
  await checkCode(env, s.id, input.code);
  const reason = input.reason.trim().slice(0, 1000);
  if (reason === '') throw invalid('reason', 'Say why you refuse.');
  await env
    .model('sign.signer')
    .browse([s.id as never])
    .write({ state: 'refused', tokenHash: null, codeHash: null });
  const request = env.model('sign.request').browse([s.request.id as never]);
  await request.write({ refusal: `${s.name}: ${reason}` });
  await request.refuse();
  for (const other of await (
    await env.model('sign.signer').search({ where: { request: s.request.id as never } })
  ).load({}))
    if (other.id !== s.id && other.state === 'sent')
      await env
        .model('sign.signer')
        .browse([other.id])
        .write({ state: 'waiting', tokenHash: null });
  await env.flush();
}

/** Where a field goes on its page, in PDF units (origin bottom-left). */
const place = (
  page: { getWidth(): number; getHeight(): number },
  f: {
    x: { toNumber(): number };
    y: { toNumber(): number };
    width: { toNumber(): number };
    height: { toNumber(): number };
  },
) => {
  const W = page.getWidth();
  const H = page.getHeight();
  const w = f.width.toNumber() * W;
  const h = f.height.toNumber() * H;
  return { x: f.x.toNumber() * W, y: H - f.y.toNumber() * H - h, w, h };
};

/** Seals a completed request: the values stamped, the certificate page added, the result stored three times. */
async function seal(env: Env, id: number): Promise<void> {
  const [r] = await env
    .model('sign.request')
    .browse([id as never])
    .load({ template: { fields: true }, signers: true, company: true });
  if (r === undefined) return;
  const source = await templatePdf(env, r.template.id);
  const pdf = await PDFDocument.load(source);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const signers = [...r.signers].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  for (const s of signers) {
    const values = (s.values ?? {}) as Record<string, string | boolean>;
    for (const f of [...r.template.fields].filter((x) => x.role === s.role)) {
      const value = values[String(f.id)];
      if (value === undefined || value === false || f.page > pdf.getPageCount()) continue;
      const page = pdf.getPage(f.page - 1);
      const at = place(page, f);
      if ((f.kind === 'signature' || f.kind === 'initials') && typeof value === 'string') {
        const image = await pdf.embedPng(Buffer.from(value.slice(PNG.length), 'base64'));
        const scale = Math.min(at.w / image.width, at.h / image.height);
        page.drawImage(image, {
          x: at.x,
          y: at.y,
          width: image.width * scale,
          height: image.height * scale,
        });
      } else {
        const text = value === true ? 'X' : String(value);
        const size = Math.max(6, Math.min(at.h * 0.7, 14));
        page.drawText(text.replace(/[^\x20-\x7e]/g, '?'), {
          x: at.x + 2,
          y: at.y + at.h * 0.25,
          size,
          font,
        });
      }
    }
  }
  // The certificate: who signed, when, from where, and the hash of what was sent.
  const cert = pdf.addPage();
  const line = (text: string, y: number, size = 10, f = font) =>
    cert.drawText(text.replace(/[^\x20-\x7e]/g, '?'), {
      x: 50,
      y,
      size,
      font: f,
      color: rgb(0.1, 0.1, 0.1),
    });
  let y = cert.getHeight() - 60;
  line('Certificate of signature', y, 16, bold);
  y -= 26;
  line(`Document: ${r.name}`, y);
  y -= 16;
  line(`Company: ${(r.company as { name?: string }).name ?? ''}`, y);
  y -= 16;
  line(`SHA-256 of the document sent: ${r.hashBefore ?? ''}`, y, 8);
  y -= 24;
  for (const s of signers) {
    line(`${s.name} <${s.email}> — ${s.role}`, y, 11, bold);
    y -= 15;
    line(`Signed at ${s.signedAt?.toISOString() ?? ''} from ${s.ip ?? 'unknown'}`, y);
    y -= 13;
    line(`Confirmed with a one-time code sent to ${s.email}`, y, 9);
    y -= 22;
  }
  const bytes = await pdf.save();
  const hashAfter = sha256(bytes);
  const name = `${r.name} (signed).pdf`;
  const storage = storageNow();
  const saved = await saveAttachment(env as never, storage, new Set(['sign.request']), {
    model: 'sign.request',
    id: r.id,
    name,
    mime: 'application/pdf',
    data: bytes,
  });
  // In Documents, in Signed documents.
  const [folder] = (
    await env.model('documents.folder').search({
      where: { name: 'Signed documents', company: r.company.id } as never,
      limit: 1,
    })
  ).ids;
  const folderId =
    folder ??
    ((
      await env
        .model('documents.folder')
        .create([{ name: 'Signed documents', company: r.company.id, owner: null }])
    ).ids[0] as Id<'documents.folder'>);
  const doc = await env.model('documents.document').create([
    {
      name,
      folder: folderId,
      company: r.company.id,
      owner: null,
      ...(r.resModel === null ? {} : { resModel: r.resModel, resId: r.resId }),
    } as never,
  ]);
  await env.flush();
  await addVersion(env, storage, doc.ids[0] as number, {
    name,
    mime: 'application/pdf',
    data: bytes,
  });
  // On the record it was signed from.
  if (r.resModel !== null && r.resId !== null)
    await saveAttachment(env as never, storage, new Set([r.resModel]), {
      model: r.resModel,
      id: r.resId,
      name,
      mime: 'application/pdf',
      data: bytes,
    }).catch(() => undefined);
  const request = env.model('sign.request').browse([r.id]);
  await request.write({
    sealed: saved.id as never,
    document: doc.ids[0] as never,
    hashAfter,
    completedAt: new Date(),
  });
  await request.complete();
  for (const s of signers)
    mail(env, s.email, `${r.name} is signed`, [
      `${r.name} is signed by everyone. ${(r.company as { name?: string }).name ?? ''} keeps the signed copy.`,
      `Its SHA-256: ${hashAfter}.`,
    ]);
  await env.flush();
}

/** Makes a request from a template for a record (or none), with its signers; a draft, to send. */
export async function requestFrom(
  env: Env,
  input: {
    template: number;
    name?: string;
    model?: string;
    id?: number;
    ordered?: boolean;
    message?: string;
    signers: { role: string; name: string; email: string; partner?: number }[];
  },
): Promise<number> {
  const [t] = await (
    await env
      .model('sign.template')
      .search({ where: { id: orm.asId(input.template, 'sign.template') }, limit: 1 })
  ).load({});
  if (t === undefined) throw invalid('template', 'Choose a template.');
  if (input.signers.length === 0 || input.signers.length > 20)
    throw invalid('signers', 'From 1 to 20 signers.');
  const made = await env.model('sign.request').create([
    {
      name: input.name ?? t.name,
      template: t.id,
      ordered: input.ordered ?? true,
      message: input.message ?? null,
      ...(input.model === undefined ? {} : { resModel: input.model, resId: input.id ?? null }),
      signers: {
        create: input.signers.map((s, i) => ({
          role: s.role,
          name: s.name,
          email: s.email,
          partner: s.partner ?? null,
          sequence: (i + 1) * 10,
        })),
      },
    } as never,
  ]);
  await env.flush();
  return made.ids[0] as number;
}
