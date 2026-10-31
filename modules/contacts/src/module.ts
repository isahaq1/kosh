/**
 * The data layer of Contacts (Shutro): companies and people, customers and vendors, with their addresses. Shared
 * across companies unless a company is set. Sales and Purchase build on it.
 */
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { storageShutro } from '@kosh/storage';
import { check, defineModel, defineModule, type Env, extendModel, f } from './.kosh/bindings.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** A tag on contacts (RFC 0022 step 2): shared by every company, kept by Contacts managers. */
export const ResPartnerTag = defineModel('res.partner.tag', {
  label: 'Contact tag',
  recName: 'name',
  order: ['name asc'],
  access: {
    'contacts.user': ['read'],
    'contacts.manager': ['read', 'write', 'create', 'unlink'],
  },
  fields: {
    name: f.char({ required: true }),
  },
  sqlConstraints: {
    oneName: { unique: ['name'], message: 'A tag with this name exists.' },
  },
});

/** The company's contact settings (RFC 0020): what a contact needs before it is saved. */
export const CompanyContacts = extendModel('res.company', {
  fields: {
    contactTaxIdRequired: f.boolean({ default: false, label: 'Customers need a tax ID' }),
    contactUniqueEmail: f.boolean({ default: false, label: 'One contact per email address' }),
  },
});

/** The current company's contact settings. */
async function contactSettings(
  env: Env,
): Promise<{ taxIdRequired: boolean; uniqueEmail: boolean }> {
  const [company] = (
    await env
      .model('res.company')
      .browse([env.companyId])
      .load(['contactTaxIdRequired', 'contactUniqueEmail'])
  ).read(['contactTaxIdRequired', 'contactUniqueEmail']);
  return {
    taxIdRequired: company?.['contactTaxIdRequired'] === true,
    uniqueEmail: company?.['contactUniqueEmail'] === true,
  };
}

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
    tags: f.many2many('res.partner.tag', { label: 'Tags' }),
    /** Where the contact is on a map (decimal degrees); filled by hand for now. */
    latitude: f.decimal({ scale: 6, help: 'Decimal degrees, e.g. 23.8103 for Dhaka' }),
    longitude: f.decimal({ scale: 6, help: 'Decimal degrees, e.g. 90.4125 for Dhaka' }),
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
    // The company's settings (App settings › Contacts): a customer's tax ID, one contact per email.
    taxIdOfCustomers: {
      ...check('res.partner', ['isCustomer', 'taxId'], async (partners) => {
        const { taxIdRequired } = await contactSettings(partners.env as unknown as Env);
        if (!taxIdRequired) return [];
        return partners.filter((p) => p.isCustomer && (p.taxId === null || p.taxId.trim() === ''));
      }),
      message: 'Customers need a tax ID in this company (App settings › Contacts).',
    },
    oneContactPerEmail: {
      ...check('res.partner', ['email'], async (partners) => {
        const env = partners.env as unknown as Env;
        const { uniqueEmail } = await contactSettings(env);
        if (!uniqueEmail) return [];
        const refused = [];
        for (const p of partners) {
          if (p.email === null || p.email === '') continue;
          const others = await env
            .model('res.partner')
            .search({ where: { email: p.email, id: { ne: p.id } } });
          if (others.length > 0) refused.push(p);
        }
        return refused;
      }),
      message:
        'Another contact has this email address (App settings › Contacts: one contact per email).',
    },
  },
});

export const contactsShutro = defineModule({
  name: 'contacts',
  version: '0.3.0',
  depends: [baseShutro, storageShutro],
  groups: [
    orm.defineGroup({
      code: 'contacts.user',
      label: 'Contacts user',
      // Photos are attachments (RFC 0022 §3.3).
      implies: ['base.user', 'storage.user'],
    }),
    orm.defineGroup({
      code: 'contacts.manager',
      label: 'Contacts manager',
      implies: ['contacts.user'],
    }),
  ],
  models: [ResPartnerTag, ResPartner],
  extensions: [CompanyContacts],
});
