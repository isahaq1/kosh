/**
 * The data layer of Sign (RFC 0024 §2.8): templates — a PDF with fields for each signer's role (signature, initials,
 * date, text, checkbox), placed on a page as fractions of its width and height —; requests made from a template,
 * often from a record (a quotation, a contract), with their signers in order or all at once; and each signer's link
 * and one-time code (only hashes kept), what they filled in, when and from where. Once the last signer is done the
 * PDF is sealed — the values stamped in, a certificate page added, its hash before and after kept — and stored.
 */
import { contactsShutro } from '@kosh/contacts';
import { documentsShutro } from '@kosh/documents';
import { messagingShutro } from '@kosh/messaging';
import { orm } from '@kosh/server/orm';
import { check, defineModel, defineModule, type Env, f, records } from './.kosh/bindings.js';
import { beforeSend } from './sign.js';

const ALL = ['read', 'write', 'create', 'unlink'] as const;

export const FIELD_KINDS = {
  signature: 'Signature',
  initials: 'Initials',
  date: 'Date signed',
  text: 'Text',
  checkbox: 'Checkbox',
} as const;

export const SignTemplate = defineModel('sign.template', {
  label: 'Signing template',
  recName: 'name',
  order: ['name asc'],
  archivable: true,
  companyScoped: { required: true },
  tracking: ['name', 'attachment'],
  access: { 'sign.user': ['read'], 'sign.manager': [...ALL, 'export'] },
  fields: {
    name: f.char({ required: true }),
    /** The PDF (an attachment of the template). */
    attachment: f.many2one('storage.attachment', { ondelete: 'set null', label: 'PDF' }),
    pages: f.integer({ label: 'Pages' }),
    fields: f.one2many('sign.template.field', 'template', { label: 'Fields' }),
    description: f.text(),
  },
});

export const SignTemplateField = defineModel('sign.template.field', {
  label: 'Signing field',
  order: ['page asc', 'y asc', 'x asc', 'id asc'],
  access: { 'sign.user': ['read'], 'sign.manager': ALL },
  fields: {
    template: f.many2one('sign.template', { required: true, ondelete: 'cascade' }),
    /** Whose it is: "Customer", "Company". */
    role: f.char({ required: true }),
    kind: f.selection(FIELD_KINDS, { required: true, default: 'signature' }),
    label: f.char(),
    page: f.integer({ required: true, default: 1 }),
    /** From the page's top-left corner, as fractions of its width and height (0 to 1). */
    x: f.decimal({ scale: 4, required: true, default: '0.1' }),
    y: f.decimal({ scale: 4, required: true, default: '0.8' }),
    width: f.decimal({ scale: 4, required: true, default: '0.3' }),
    height: f.decimal({ scale: 4, required: true, default: '0.06' }),
    required: f.boolean({ default: true }),
  },
  sqlConstraints: {
    placed: {
      check: orm.sql`page >= 1 AND x >= 0 AND y >= 0 AND width > 0 AND height > 0 AND x + width <= 1 AND y + height <= 1`,
      message: 'A field is on a page, inside it.',
    },
  },
});

export const SignRequest = defineModel('sign.request', {
  label: 'Signing request',
  recName: 'name',
  order: ['id desc'],
  companyScoped: { required: true },
  tracking: ['state'],
  access: { 'sign.user': ['read', 'write', 'create'], 'sign.manager': [...ALL, 'export'] },
  fields: {
    name: f.char({ required: true }),
    template: f.many2one('sign.template', { required: true, ondelete: 'restrict' }),
    /** The record it is signed from (its signed PDF is attached to it). */
    resModel: f.char({ label: 'For (model)' }),
    resId: f.integer({ label: 'For (record)' }),
    ordered: f.boolean({ default: true, label: 'Signers in order' }),
    signers: f.one2many('sign.signer', 'request'),
    message: f.text(),
    /** The SHA-256 of the template's PDF when the request was sent, and of the sealed one. */
    hashBefore: f.char({ label: 'Hash before' }),
    hashAfter: f.char({ label: 'Hash after' }),
    sealed: f.many2one('storage.attachment', { ondelete: 'set null', label: 'Signed PDF' }),
    document: f.many2one('documents.document', { ondelete: 'set null', label: 'Document' }),
    completedAt: f.datetime({ label: 'Completed at' }),
    refusal: f.text({ label: 'Why it was refused' }),
    state: f.state({
      states: {
        draft: 'Draft',
        sent: 'Out for signature',
        signed: 'Signed',
        refused: 'Refused',
        cancel: 'Cancelled',
      },
      initial: 'draft',
      transitions: {
        /** Checks the template and asks the signers (the first in order, or all). */
        send: {
          from: ['draft'],
          to: 'sent',
          before: records('sign.request', async (requests): Promise<void> => {
            await beforeSend(requests.env as unknown as Env, requests.ids);
          }),
        },
        complete: {
          from: ['sent'],
          to: 'signed',
          after: records('sign.request', async (requests): Promise<void> => {
            for (const id of requests.ids) await requests.env.emit('sign.request.signed', { id });
          }),
        },
        refuse: { from: ['sent'], to: 'refused' },
        cancel: { from: ['draft', 'sent'], to: 'cancel' },
      },
    }),
  },
});

export const SignSigner = defineModel('sign.signer', {
  label: 'Signer',
  order: ['sequence asc', 'id asc'],
  access: { 'sign.user': ['read', 'write', 'create'], 'sign.manager': ALL },
  fields: {
    request: f.many2one('sign.request', { required: true, ondelete: 'cascade' }),
    role: f.char({ required: true }),
    name: f.char({ required: true }),
    email: f.char({ required: true }),
    partner: f.many2one('res.partner', { ondelete: 'set null' }),
    sequence: f.integer({ required: true, default: 10 }),
    state: f.selection(
      { waiting: 'Waiting', sent: 'Asked', signed: 'Signed', refused: 'Refused' },
      { required: true, default: 'waiting' },
    ),
    tokenHash: f.char({ index: true, label: 'Link (hash)' }),
    codeHash: f.char({ label: 'Code (hash)' }),
    codeExpiresAt: f.datetime({ label: 'Code expires' }),
    codeAttempts: f.integer({ required: true, default: 0 }),
    /** What they filled in, by field id (a signature as a PNG data URL). */
    values: f.json({ label: 'Values' }),
    sentAt: f.datetime({ label: 'Asked at' }),
    signedAt: f.datetime({ label: 'Signed at' }),
    ip: f.char({ label: 'IP address' }),
    userAgent: f.char({ label: 'Browser' }),
  },
  constraints: {
    email: {
      ...check('sign.signer', ['email'], async (signers) =>
        signers.filter((s) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)).map((s) => s.id),
      ),
      message: 'A signer has an email address.',
    },
  },
});

export const signShutro = defineModule({
  name: 'sign',
  version: '0.1.0',
  depends: [contactsShutro, messagingShutro, documentsShutro],
  groups: [
    orm.defineGroup({ code: 'sign.user', label: 'Sign user', implies: ['contacts.user'] }),
    orm.defineGroup({ code: 'sign.manager', label: 'Sign manager', implies: ['sign.user'] }),
  ],
  models: [SignTemplate, SignTemplateField, SignRequest, SignSigner],
});
