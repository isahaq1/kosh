/**
 * Idempotency keys (RFC 0002 §6.4, CLAUDE.md robustness): an `Idempotency-Key` header on an unsafe request stores the
 * key and, in the same transaction, the response. A retry with the same key replays the stored response instead of
 * acting twice; the same key with a different request is refused; a failed request stores nothing (the transaction
 * rolls back), so its retry runs again. Keys are per user.
 */
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { HttpProblem } from '../errors.js';
import type { Driver, Env } from '../orm.js';

export const IDEMPOTENCY_TABLE = 'kosh_idempotency';

/** Statements creating the idempotency table (run at server start). */
export function idempotencyTableStatements(): readonly {
  readonly text: string;
  readonly params: readonly [];
}[] {
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS ${IDEMPOTENCY_TABLE} ("user_id" bigint NOT NULL, "key" text NOT NULL, "fingerprint" text NOT NULL, "status" integer, "response" jsonb, "created_at" timestamp with time zone NOT NULL DEFAULT now(), PRIMARY KEY ("user_id", "key"))`,
      params: [],
    },
    {
      // Responses stored before 2026-10-27 as a JSON string holding the body (encoded twice): the object again.
      text: `UPDATE ${IDEMPOTENCY_TABLE} SET response = (response #>> '{}')::jsonb WHERE jsonb_typeof(response) = 'string' AND left(response #>> '{}', 1) IN ('{', '[')`,
      params: [],
    },
  ];
}

/** A handler's result: status and JSON body. */
export interface Outcome {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Set when the stored response of an earlier request is replayed. */
  readonly replayed?: boolean;
}

const KEY = /^[\w.:-]{1,128}$/;

/**
 * Runs `compute` at most once per idempotency key (in the request's transaction `env`). Without a key it just runs.
 * @throws {HttpProblem} 400 for a malformed key, 409 while the first request with the key is still running,
 * 422 when the key was used for a different request.
 */
export async function idempotent(
  request: FastifyRequest,
  env: Env,
  driver: Driver,
  compute: () => Promise<Outcome>,
): Promise<Outcome> {
  const header = request.headers['idempotency-key'];
  if (header === undefined) return compute();
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || !KEY.test(key))
    throw new HttpProblem(
      400,
      'invalid-idempotency-key',
      'Invalid idempotency key',
      'Idempotency-Key must be 1–128 characters of letters, digits, _ . : -.',
    );
  const fingerprint = createHash('sha256')
    .update(
      `${request.method} ${request.url.split('?')[0] ?? ''} ${JSON.stringify(request.body ?? null)}`,
    )
    .digest('hex');
  const claimed = await env.sql<{
    key: string;
  }>`INSERT INTO kosh_idempotency (user_id, key, fingerprint) VALUES (${env.uid}, ${key}, ${fingerprint}) ON CONFLICT DO NOTHING RETURNING key`;
  if (claimed.length === 0) {
    // Another request with this key committed (this one waited on it): read it with a fresh snapshot.
    const [row] = await driver.query<{
      fingerprint: string;
      status: number | null;
      response: unknown;
    }>({
      text: 'SELECT fingerprint, status, response FROM kosh_idempotency WHERE user_id = $1 AND key = $2',
      params: [env.uid, key],
    });
    if (row === undefined || row.status === null)
      throw new HttpProblem(
        409,
        'idempotency-in-progress',
        'Request in progress',
        `A request with Idempotency-Key ${key} is still running.`,
        'Retry shortly.',
      );
    if (row.fingerprint !== fingerprint)
      throw new HttpProblem(
        422,
        'idempotency-key-reused',
        'Idempotency key reused',
        `Idempotency-Key ${key} was used for a different request.`,
        'Use a new key for each distinct request.',
      );
    return { status: row.status, body: row.response, replayed: true };
  }
  const outcome = await compute();
  await env.sql`UPDATE kosh_idempotency SET status = ${outcome.status}, response = ${outcome.body ?? null}::jsonb WHERE user_id = ${env.uid} AND key = ${key}`;
  return outcome;
}
