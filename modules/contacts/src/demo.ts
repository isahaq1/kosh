/** Demo data of Contacts (RFC 0008 §5.8): Bangladeshi companies, customers and vendors, and the people there. */
import type { DemoContext } from '@kosh/modules-sdk';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';

/** The demo user who keeps the address book: the manager of every demo app. */
export const DINA = { login: 'dina', name: 'Dina Rahman', groups: ['contacts.manager'] } as const;

const COMPANIES = [
  {
    name: 'Bengal Steel Ltd',
    city: 'Chattogram',
    isCustomer: true,
    isVendor: true,
    email: 'orders@bengalsteel.example',
    phone: '+880 31 710000',
  },
  { name: 'Acme Trading', city: 'Dhaka', isCustomer: true, email: 'hello@acme.example' },
  { name: 'Padma Cement', city: 'Narayanganj', isVendor: true, email: 'sales@padmacement.example' },
  { name: 'Meghna Electronics', city: 'Dhaka', isCustomer: true, isVendor: true },
  { name: 'Sylhet Tea Estates', city: 'Sylhet', isCustomer: true },
  { name: 'Khulna Shipyard', city: 'Khulna', isCustomer: true },
  { name: 'Rajshahi Textiles', city: 'Rajshahi', isVendor: true },
  { name: 'Dhaka Power Services', city: 'Dhaka', isVendor: true },
] as const;

const PEOPLE = [
  { name: 'Farhana Akter', company: 'Bengal Steel Ltd', email: 'farhana@bengalsteel.example' },
  { name: 'Tanvir Hossain', company: 'Acme Trading', phone: '+880 1711 000001' },
  { name: 'Nusrat Jahan', company: 'Meghna Electronics' },
] as const;

export async function contactsDemo(context: DemoContext): Promise<string> {
  return context.as(DINA, async (raw) => {
    const env = raw as Env;
    const partners = env.model('res.partner');
    const companies = await partners.create(
      COMPANIES.map((c) => ({ ...c, isCompany: true, country: 'BD' })),
    );
    const byName = new Map(COMPANIES.map((c, i) => [c.name, companies.ids[i] as number]));
    await partners.create(
      PEOPLE.map(({ company, ...p }) => ({
        ...p,
        parent: orm.asId(byName.get(company) as number, 'res.partner'),
      })),
    );
    return `${COMPANIES.length} companies and ${PEOPLE.length} people`;
  });
}
