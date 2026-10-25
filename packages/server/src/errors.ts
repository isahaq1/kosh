/**
 * Server errors and their HTTP form: RFC 9457 problem details with stable `type` codes (RFC 0002 §6.4). Shutro's typed
 * errors map to statuses here; the full mapping grows with the generated endpoints (step 3).
 */
import { orm, pg } from './orm.js';

/** A server set up wrongly (modules, options). The message says what and how to fix it. */
export class ServerConfigError extends Error {
  readonly hint: string;
  constructor(problem: string, hint: string) {
    super(`${problem} ${hint}`);
    this.name = 'ServerConfigError';
    this.hint = hint;
  }
}

/** An RFC 9457 problem document. */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly hint?: string;
}

/** A request the server refuses before it reaches the ORM (authentication, headers). */
export class HttpProblem extends Error {
  readonly problem: Problem;
  constructor(status: number, type: string, title: string, detail: string, hint?: string) {
    super(detail);
    this.name = 'HttpProblem';
    this.problem = {
      type: `https://kosh.dev/problems/${type}`,
      title,
      status,
      detail,
      ...(hint === undefined ? {} : { hint }),
    };
  }
}

const SHUTRO_STATUS: Readonly<Record<string, number>> = {
  ACCESS: 403,
  MISSING_RECORD: 404,
  STALE_RECORD: 412,
  VALIDATION: 422,
  CONSTRAINT: 422,
  CONSTRAINT_VIOLATION: 422,
  INVALID_DOMAIN: 400,
  INVALID_IDENTITY: 400,
  COMPANY_NOT_ALLOWED: 403,
  CONCURRENT_UPDATE: 409,
  INVALID_TRANSITION: 409,
  TRANSITION_GUARD: 409,
};

/** The problem document for any error; unknown errors are 500 without internals (they are logged instead). */
export function problemOf(error: unknown): Problem {
  if (error instanceof HttpProblem) return error.problem;
  // A rule enforced in the database (`RAISE EXCEPTION ... ERRCODE 'P0001'`, e.g. a posted accounting entry): the
  // raised message is the user's answer, as for a constraint.
  if (error instanceof pg.DriverError && error.sqlState === 'P0001') {
    const raised = (error.cause as { message?: unknown } | undefined)?.message;
    return {
      type: 'https://kosh.dev/problems/database-rule',
      title: 'Refused by a database rule',
      status: 422,
      detail: typeof raised === 'string' ? raised : error.message,
    };
  }
  if (error instanceof orm.ShutroError) {
    const status = SHUTRO_STATUS[error.code] ?? 500;
    if (status !== 500)
      return {
        type: `https://kosh.dev/problems/${error.code.toLowerCase().replaceAll('_', '-')}`,
        title: error.name,
        status,
        detail: error.message,
        hint: error.hint,
      };
  }
  const fastify = error as { statusCode?: unknown; code?: unknown; message?: unknown };
  if (
    typeof fastify.statusCode === 'number' &&
    fastify.statusCode >= 400 &&
    fastify.statusCode < 500
  )
    return {
      type: `https://kosh.dev/problems/${String(fastify.code ?? 'bad-request')
        .toLowerCase()
        .replaceAll('_', '-')}`,
      title: 'Bad request',
      status: fastify.statusCode,
      detail: String(fastify.message ?? 'The request is invalid.'),
    };
  return {
    type: 'https://kosh.dev/problems/internal',
    title: 'Internal error',
    status: 500,
    detail: 'The server failed to handle the request; the error is logged with the request id.',
  };
}
