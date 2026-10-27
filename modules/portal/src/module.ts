/**
 * The data layer of the portal (RFC 0015 §5.1–5.2): portal users are `res.users` holding only `portal.user` (never
 * `base.user`), each linked to one partner; invitations are one-time activation tokens, kept as SHA-256 digests.
 */
import { contactsShutro } from '@kosh/contacts';
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { defineModel, defineModule, extendModel, f } from './.kosh/bindings.js';

/** The partner a portal user acts for. Internal users have none. */
export const UserPortalPartner = extendModel('res.users', {
  fields: {
    portalPartner: f.many2one('res.partner', { ondelete: 'set null', label: 'Portal contact' }),
  },
});

/** The portal users of a contact (one, in practice): who the invitations went to. */
export const PartnerPortalUsers = extendModel('res.partner', {
  fields: {
    portalUsers: f.one2many('res.users', 'portalPartner', { label: 'Portal users' }),
  },
});

/** A one-time link that lets an invited contact choose a password. Private: read through the portal routes. */
export const PortalInvitation = defineModel('portal.invitation', {
  label: 'Portal invitation',
  order: ['id desc'],
  access: {},
  fields: {
    user: f.many2one('res.users', { required: true, ondelete: 'cascade' }),
    tokenHash: f.char({ required: true, index: 'unique' }),
    expiresAt: f.datetime({ required: true }),
    usedAt: f.datetime(),
    invitedBy: f.many2one('res.users', { ondelete: 'set null' }),
  },
});

/**
 * A signature given in the portal (RFC 0015 §5.3): who signed which document, under which name, the drawn image,
 * when, from where, and the hash of what they saw. Private: written by the portal routes, read by staff.
 */
export const PortalSignature = defineModel('portal.signature', {
  label: 'Portal signature',
  order: ['id desc'],
  companyScoped: { required: true },
  access: { 'base.user': ['read'] },
  fields: {
    resModel: f.char({ required: true, label: 'Model' }),
    resId: f.integer({ required: true, label: 'Record' }),
    action: f.char({ required: true, size: 40 }),
    user: f.many2one('res.users', { required: true, ondelete: 'restrict' }),
    signedName: f.char({ required: true, size: 200, label: 'Name' }),
    image: f.binary({ label: 'Signature' }),
    /** SHA-256 of the declared fields and lines the user saw. */
    documentHash: f.char({ required: true, size: 64 }),
    ip: f.char({ size: 64 }),
  },
});

/** A document announced to its customer by email (RFC 0015 §5.7): once per record and document type. */
export const PortalAnnouncement = defineModel('portal.announcement', {
  label: 'Portal announcement',
  access: {},
  fields: {
    resModel: f.char({ required: true, label: 'Model' }),
    resId: f.integer({ required: true, label: 'Record' }),
    document: f.char({ required: true, size: 64 }),
    recipients: f.integer({ required: true, default: 0 }),
  },
  sqlConstraints: {
    once: { unique: ['resModel', 'resId', 'document'], message: 'A document is announced once.' },
  },
});

export const portalShutro = defineModule({
  name: 'portal',
  version: '0.1.0',
  depends: [baseShutro, contactsShutro],
  groups: [
    // Never implies base.user: holders are outside the company (the server keeps them to the portal).
    orm.defineGroup({ code: 'portal.user', label: 'Portal user' }),
    orm.defineGroup({
      code: 'portal.manager',
      label: 'Portal access manager',
      implies: ['contacts.user'],
    }),
  ],
  models: [PortalInvitation, PortalSignature, PortalAnnouncement],
  extensions: [UserPortalPartner, PartnerPortalUsers],
});
