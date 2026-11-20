/**
 * The data layer of the careers page (RFC 0034 §2.6), the bridge of Sites and Hiring: an **opening** may be shown
 * on the careers page of the company's site, with what a candidate should read and until when they may apply; an
 * **application** from the page is an applicant like any other — from the website, in the first stage, with the
 * letter and the CV attached —; and a **stage** may carry an email that goes to the candidate once, when they
 * reach it.
 */
import { hrShutro } from '@kosh/hr';
import { recruitmentShutro } from '@kosh/recruitment';
import { orm } from '@kosh/server/orm';
import { websiteShutro } from '@kosh/website';
import { defineModule, type Env, extendModel, f } from './.kosh/bindings.js';

/**
 * Fields the server maintains: written by its own code (as the system) and by Administrators only. An empty list
 * would mean *everyone* — Shutro reads no groups as no restriction.
 */
const SYSTEM = ['base.admin'] as const;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

export const OpeningCareers = extendModel('hiring.opening', {
  fields: {
    published: f.boolean({
      default: false,
      label: 'On the careers page',
      help: 'Shown on the company’s site while the opening is open, and until the closing date when it has one.',
    }),
    location: f.char({ label: 'Place of work' }),
    employment: f.char({
      label: 'Employment',
      help: 'As candidates should read it: full time, a one-year contract, an internship.',
    }),
    closingDate: f.date({
      label: 'Applications until',
      help: 'The last day the careers page takes applications; empty: until the opening is closed.',
    }),
  },
});

export const ApplicantCareers = extendModel('hiring.applicant', {
  fields: {
    cover: f.text({ label: 'Letter', help: 'What the candidate wrote with their application.' }),
    /** The last stage whose email went to the candidate. */
    mailedStage: f.many2one('hiring.stage', {
      ondelete: 'set null',
      label: 'Last stage emailed',
      groups: { write: [...SYSTEM] },
    }),
  },
});

export const StageMail = extendModel('hiring.stage', {
  fields: {
    mailSubject: f.char({
      label: 'Email subject',
      help: 'With a subject and a text, a candidate who reaches this stage is emailed once.',
    }),
    mailBody: f.text({
      label: 'Email text',
      help: 'It may use {{name}} (the candidate), {{opening}} and {{company}}. Empty lines separate paragraphs.',
    }),
  },
});

/** An opening as the careers page shows it. */
export interface PublicOpening {
  readonly id: number;
  readonly name: string;
  readonly department: string | null;
  readonly location: string | null;
  readonly employment: string | null;
  readonly closingDate: string | null;
  readonly description: string | null;
}

/** The openings of a company that are on its careers page today, by name. */
export async function publishedOpenings(su: Env, company: number): Promise<PublicOpening[]> {
  const today = iso(su.today());
  const found = await su
    .model('hiring.opening')
    .search({
      where: { company: company as never, published: true, state: 'open' } as never,
      order: ['name asc'],
    })
    .then((rows) => rows.load({ department: true }));
  return [...found]
    .filter((o) => o.closingDate === null || iso(o.closingDate) >= today)
    .map((o) => ({
      id: o.id as number,
      name: o.name,
      department: o.department?.name ?? null,
      location: o.location,
      employment: o.employment,
      closingDate: o.closingDate === null ? null : iso(o.closingDate),
      description: o.description,
    }));
}

export type Applied =
  | { readonly ok: true; readonly applicant: number }
  | { readonly ok: false; readonly why: 'closed' | 'duplicate' };

/**
 * Takes an application from the careers page (RFC 0034 §2.6): an applicant of the opening, from the website, in
 * the first stage. One application per email address and opening: a second one is not another applicant.
 */
export async function apply(
  su: Env,
  company: number,
  opening: number,
  from: {
    readonly name: string;
    readonly email: string;
    readonly phone: string | null;
    readonly cover: string | null;
  },
): Promise<Applied> {
  const open = (await publishedOpenings(su, company)).some((o) => o.id === opening);
  if (!open) return { ok: false, why: 'closed' };
  const again = await su.model('hiring.applicant').search({
    where: {
      opening: opening as never,
      email: { ilike: from.email.replace(/[%_\\]/g, '\\$&') },
    } as never,
    limit: 1,
  });
  if (again.length > 0) return { ok: false, why: 'duplicate' };
  const [first] = await su
    .model('hiring.stage')
    .search({ order: ['sequence asc', 'id asc'], limit: 1 });
  const made = await su.model('hiring.applicant').create([
    {
      name: from.name,
      email: from.email,
      phone: from.phone,
      cover: from.cover,
      opening,
      company,
      source: 'website',
      stage: first?.id ?? null,
    } as never,
  ]);
  await su.flush();
  return { ok: true, applicant: made.ids[0] as number };
}

/** An email to a candidate, ready to send. */
export interface StageEmail {
  readonly to: string;
  readonly subject: string;
  readonly paragraphs: readonly string[];
}

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{\s*(name|opening|company)\s*\}\}/g, (_, key: string) => values[key] ?? '');

/**
 * The email an applicant's stage owes them, if any: their stage has a subject and a text, and it is not the stage
 * they were last emailed for. Marks the stage as emailed — once per stage reached, also when they come back to it
 * after another.
 */
export async function takeStageEmail(su: Env, applicant: number): Promise<StageEmail | null> {
  const [a] = await su
    .model('hiring.applicant')
    .browse([applicant as never])
    .load({ stage: true, opening: true, company: true, mailedStage: true });
  if (a === undefined || a.stage === null || a.refused === true) return null;
  if (a.mailedStage !== null && a.mailedStage.id === a.stage.id) return null;
  const subject = (a.stage.mailSubject ?? '').trim();
  const body = (a.stage.mailBody ?? '').trim();
  // The stage is remembered also without a template: coming back to an earlier stage emails again.
  await su
    .model('hiring.applicant')
    .browse([a.id])
    .write({ mailedStage: a.stage.id } as never);
  await su.flush();
  if (subject === '' || body === '' || a.email.trim() === '') return null;
  const values = { name: a.name, opening: a.opening.name, company: a.company.name };
  return {
    to: a.email.trim(),
    subject: fill(subject, values),
    paragraphs: fill(body, values)
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p !== ''),
  };
}

export const websiteHiringShutro = defineModule({
  name: 'website_hiring',
  version: '0.1.0',
  depends: [websiteShutro, recruitmentShutro, hrShutro],
  groups: [
    orm.defineGroup({
      code: 'website_hiring.user',
      label: 'Careers page',
      implies: ['hiring.user'],
    }),
  ],
  models: [],
  extensions: [OpeningCareers, ApplicantCareers, StageMail],
});
