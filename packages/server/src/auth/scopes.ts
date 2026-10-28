/**
 * API key scopes (RFC 0017 §5.1): they narrow what a key's user may do, never widen it. `*` is everything the user
 * may do; `read:<app>` reads an app's models and routes; `write:<app>` also changes them (it implies read). A route
 * belongs to an app when the app's module registered it, or when it serves one of the app's models; a route of no
 * app needs `*`. Keys cannot manage credentials (sign-in, 2FA, passwords, keys): those need a session.
 */
import { HttpProblem } from '../errors.js';

export type Access = 'read' | 'write';

const SCOPE = /^(\*|(read|write):[a-z][a-z0-9_]*)$/;

/** The scopes in `text` (space or comma separated), checked against the installed apps. */
export function parseScopes(
  input: string | readonly string[],
  apps: ReadonlySet<string>,
): string[] {
  const list = (typeof input === 'string' ? input.split(/[\s,]+/) : [...input])
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (list.length === 0)
    throw new HttpProblem(
      400,
      'invalid-scopes',
      'Invalid scopes',
      'Give at least one scope: *, read:<app> or write:<app>.',
    );
  for (const scope of list) {
    if (!SCOPE.test(scope))
      throw new HttpProblem(
        400,
        'invalid-scopes',
        'Invalid scopes',
        `"${scope}" is not a scope: *, read:<app> or write:<app>.`,
      );
    const app = scope.split(':')[1];
    if (app !== undefined && !apps.has(app))
      throw new HttpProblem(
        400,
        'invalid-scopes',
        'Invalid scopes',
        `"${app}" is not an installed app.`,
      );
  }
  return [...new Set(list)].sort();
}

/** Whether `scopes` allow `access` to `app` (`null`: a route of no app, which needs `*`). */
export function scopesAllow(
  scopes: readonly string[],
  app: string | null,
  access: Access,
): boolean {
  if (scopes.includes('*')) return true;
  if (app === null) return false;
  return scopes.includes(`write:${app}`) || (access === 'read' && scopes.includes(`read:${app}`));
}

/** The access a request method needs. */
export const accessOf = (method: string): Access =>
  method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'write';

/** Credential routes an API key may still use (who am I). */
const KEY_AUTH_ROUTES = new Set(['GET /api/v1/auth/me']);

/**
 * Refuses a request an API key's scopes do not cover. `route` is the route's pattern (`/api/v1/models/:model`),
 * `app` the app it belongs to, or null.
 */
export function enforceScopes(
  scopes: readonly string[],
  method: string,
  route: string,
  app: string | null,
): void {
  if (route.startsWith('/api/v1/auth/') && !KEY_AUTH_ROUTES.has(`${method} ${route}`))
    throw new HttpProblem(
      403,
      'api-key-not-allowed',
      'Not with an API key',
      'Signing in, two-factor, passwords and API keys are managed with a session, not an API key.',
    );
  if (KEY_AUTH_ROUTES.has(`${method} ${route}`)) return;
  const access = accessOf(method);
  if (!scopesAllow(scopes, app, access))
    throw new HttpProblem(
      403,
      'scope',
      'Outside the API key’s scopes',
      app === null
        ? 'This route belongs to no app: it needs a key with the * scope.'
        : `This needs the ${access === 'read' ? `read:${app} or write:${app}` : `write:${app}`} scope.`,
      'Create a key with the scope it needs.',
    );
}
