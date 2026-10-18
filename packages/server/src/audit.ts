/**
 * The security audit log (`audit.event`, CLAUDE.md: logins, permission changes, exports and sensitive actions),
 * written in the caller's transaction so an event exists exactly when the change it records does.
 */
import type { Env } from './orm.js';
import { orm } from './orm.js';

/** One audit event. */
export interface AuditInput {
  /** Dotted kind: `auth.login`, `auth.login_failed`, `admin.session`, `security.role`, `data.export`, ... */
  readonly kind: string;
  readonly summary: string;
  /** Default: the environment's user (none for system scopes). */
  readonly actor?: number | null;
  readonly company?: number | null;
  readonly targetModel?: string;
  readonly targetId?: number;
  readonly details?: unknown;
  readonly ip?: string;
}

/** Writes an audit event in `env`'s transaction. */
export async function audit(env: Env, input: AuditInput): Promise<void> {
  const actor =
    input.actor === undefined ? (env.uid === orm.SYSTEM_UID ? null : env.uid) : input.actor;
  const row = {
    kind: input.kind,
    summary: input.summary.slice(0, 500),
    actor,
    company:
      input.company === undefined
        ? env.uid === orm.SYSTEM_UID
          ? null
          : env.companyId
        : input.company,
    ...(input.targetModel === undefined ? {} : { targetModel: input.targetModel }),
    ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.ip === undefined ? {} : { ip: input.ip }),
  };
  const write = (e: Env) =>
    (
      e.model('audit.event' as never) as unknown as { create(rows: unknown[]): Promise<unknown> }
    ).create([row]);
  // Internal users may append events; anyone else (e.g. a user without groups) appends through a system scope.
  if (env.su || env.access.can('audit.event' as never, 'create')) await write(env);
  else await env.asSuperuser({ reason: `audit ${input.kind}` }, write);
}
