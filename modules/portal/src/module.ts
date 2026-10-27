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
  models: [PortalInvitation],
  extensions: [UserPortalPartner, PartnerPortalUsers],
});
