/**
 * The data layer of Contacts (Shutro): companies and people, customers and vendors, with their addresses. Shared
 * across companies unless a company is set. Sales and Purchase build on it.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { storageShutro } from '@kosh/storage';
import { check, defineModel, defineModule, f } from './.kosh/bindings.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

export const ResPartner = defineModel('res.partner', {
  label: 'Contact',
  archivable: true,
  companyScoped: { required: false },
  order: ['name asc'],
  access: {
    'contacts.user': ['read', 'write', 'create'],
    'contacts.manager': ALL,
  },
  tracking: ['name', 'email', 'phone', 'taxId'],
  fields: {
    name: f.char({ required: true }),
    /** A photo or logo: an attachment of the contact (RFC 0022 §3.3), with its 256 px thumbnail. */
    image: f.many2one('storage.attachment', { ondelete: 'set null', label: 'Photo' }),
    isCompany: f.boolean({ default: false, label: 'Is a company' }),
    /** The company a person works for. */
    parent: f.many2one('res.partner', { ondelete: 'set null', label: 'Company' }),
    contacts: f.one2many('res.partner', 'parent'),
    email: f.char(),
    phone: f.char(),
    mobile: f.char(),
    website: f.char(),
    street: f.char(),
    city: f.char(),
    zip: f.char({ label: 'Postal code' }),
    /** ISO 3166 country code (BD, IN, US, ...). */
    country: f.char({ size: 2 }),
    /** State or province (ISO 3166-2: IN-MH, US-CA): the place of supply of taxes split by state. */
    state: f.char({ size: 6, label: 'State / province' }),
    /** VAT / BIN / tax identification number. */
    taxId: f.char({ label: 'Tax ID' }),
    isCustomer: f.boolean({ default: false, label: 'Customer' }),
    isVendor: f.boolean({ default: false, label: 'Vendor' }),
    /** Preferred currency for quotations, orders and invoices. */
    currency: f.many2one('res.currency'),
    notes: f.text(),
  },
  constraints: {
    emailFormat: {
      ...check('res.partner', ['email'], (partners) =>
        partners.filter((p) => p.email !== null && !EMAIL.test(p.email)),
      ),
      message: 'An email address must look like name@example.com.',
    },
  },
});

export const contactsShutro = defineModule({
  name: 'contacts',
  version: '0.2.0',
  depends: [baseShutro, storageShutro],
  groups: [
    orm.defineGroup({ code: 'contacts.user', label: 'Contacts user', implies: ['base.user'] }),
    orm.defineGroup({
      code: 'contacts.manager',
      label: 'Contacts manager',
      implies: ['contacts.user'],
    }),
  ],
  models: [ResPartner],
});
