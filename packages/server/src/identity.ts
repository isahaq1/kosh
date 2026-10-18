/**
 * Who a request acts as (RFC 0002 §6.2). An {@link Authenticator} turns a request into an identity (sessions and 2FA
 * come with the auth step); headers may then narrow it: `X-Company` (current company), `X-Companies` (allowed
 * companies, a subset), `Accept-Language` and `X-Timezone`. Without an identity a route answers 401.
 */
import type { FastifyRequest } from 'fastify';
import { HttpProblem } from './errors.js';

/** The verified identity of a request. */
export interface RequestIdentity {
  readonly user: number;
  /** Default current company. */
  readonly company: number;
  /** Companies the user may work in. */
  readonly companies: readonly number[];
  /** Shutro group codes for these companies. */
  readonly groups: readonly string[];
  readonly lang?: string;
  readonly tz?: string;
}

/** Resolves a request's identity, or `null` when it is not authenticated. */
export type Authenticator = (request: FastifyRequest) => Promise<RequestIdentity | null>;

/** The default: nobody is authenticated (secure by default until an auth method is configured). */
export const denyAll: Authenticator = async () => null;

const LANG = /^([a-z]{2,3})[-_]([A-Za-z]{2})$/;

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function ids(text: string, what: string): number[] {
  return text.split(',').map((part) => {
    const n = Number(part.trim());
    if (!Number.isSafeInteger(n) || n <= 0)
      throw new HttpProblem(
        400,
        'invalid-header',
        'Invalid header',
        `${what} must be company ids, got ${JSON.stringify(text)}.`,
      );
    return n;
  });
}

/** The first `ll-CC` of `Accept-Language`, as a Shutro language code (`bn-BD` → `bn_BD`). */
export function languageOf(accept: string | undefined): string | undefined {
  for (const part of (accept ?? '').split(',')) {
    const m = LANG.exec(part.split(';')[0]?.trim() ?? '');
    if (m !== null) return `${m[1]}_${m[2]?.toUpperCase()}`;
  }
  return undefined;
}

/** What a request runs as in Shutro (`shutro.run` options). */
export interface RequestRunOptions {
  readonly user: number;
  readonly company: number;
  readonly companies: readonly number[];
  readonly groups: readonly string[];
  readonly lang?: string;
  readonly tz?: string;
  readonly readOnly: boolean;
}

/** The Shutro run options of a request: the identity narrowed by its headers. @throws {HttpProblem} */
export function runOptionsOf(
  request: FastifyRequest,
  identity: RequestIdentity,
): RequestRunOptions {
  const companiesHeader = header(request, 'x-companies');
  const companyHeader = header(request, 'x-company');
  const companies =
    companiesHeader === undefined ? [...identity.companies] : ids(companiesHeader, 'X-Companies');
  const outside = companies.filter((c) => !identity.companies.includes(c));
  if (outside.length > 0)
    throw new HttpProblem(
      403,
      'company-not-allowed',
      'Company not allowed',
      `Company ${outside.join(', ')} is not allowed for this user.`,
    );
  const company =
    companyHeader === undefined ? identity.company : (ids(companyHeader, 'X-Company')[0] as number);
  if (!companies.includes(company))
    throw new HttpProblem(
      403,
      'company-not-allowed',
      'Company not allowed',
      `Company ${company} is not among the selected companies.`,
    );
  const lang = languageOf(header(request, 'accept-language')) ?? identity.lang;
  const tz = header(request, 'x-timezone') ?? identity.tz;
  return {
    user: identity.user,
    company,
    companies,
    groups: [...identity.groups],
    ...(lang === undefined ? {} : { lang }),
    ...(tz === undefined ? {} : { tz }),
    readOnly: request.method === 'GET' || request.method === 'HEAD',
  };
}
