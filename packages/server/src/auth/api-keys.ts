/**
 * API keys and service accounts over HTTP (RFC 0017 §5.1). With a session only (a key cannot make keys):
 *
 * - `GET  /api/v1/auth/api-keys`              your keys (and every service account's, for administrators)
 * - `POST /api/v1/auth/api-keys`              `{ name, scopes, expiresInDays?, user? }` → the key and its secret, once
 * - `POST /api/v1/auth/api-keys/:id/revoke`   at once
 * - `POST /api/v1/auth/service-accounts`      `{ login, name, groups }` (administrators)
 * - `GET  /api/v1/auth/scopes`                the scopes a key may have: `*` and the installed apps'
 */
import type { FastifyInstance } from 'fastify';
import { HttpProblem } from '../errors.js';
import type { KoshRegistry } from '../registry.js';
import { parseScopes } from './scopes.js';
import type { AuthService } from './service.js';

const body = (request: { body: unknown }) =>
  typeof request.body === 'object' && request.body !== null
    ? (request.body as Record<string, unknown>)
    : {};

export function registerApiKeyRoutes(
  app: FastifyInstance,
  auth: AuthService,
  registry: KoshRegistry,
): void {
  const apps = () => new Set(registry.loaded.modules.map((m) => m.name));
  const config = { config: { auth: false } };

  app.get('/api/v1/auth/scopes', config, async (request) => {
    await auth.requireSession(request);
    return {
      scopes: [
        { scope: '*', label: 'Everything you may do' },
        ...registry.loaded.modules.flatMap((m) => [
          { scope: `read:${m.name}`, label: `Read ${m.name}` },
          { scope: `write:${m.name}`, label: `Read and change ${m.name}` },
        ]),
      ],
    };
  });

  app.get('/api/v1/auth/api-keys', config, async (request) => {
    const session = await auth.requireSession(request);
    return { keys: await auth.listApiKeys(session) };
  });

  app.post('/api/v1/auth/api-keys', config, async (request, reply) => {
    const session = await auth.requireSession(request);
    const input = body(request);
    const scopes = parseScopes(
      Array.isArray(input['scopes'])
        ? (input['scopes'] as string[]).map(String)
        : String(input['scopes'] ?? ''),
      apps(),
    );
    const user = input['user'] === undefined ? undefined : Number(input['user']);
    if (user !== undefined && !(Number.isInteger(user) && user > 0))
      throw new HttpProblem(400, 'invalid-body', 'Invalid body', 'user is a user id.');
    const days = input['expiresInDays'] === undefined ? undefined : Number(input['expiresInDays']);
    const created = await auth.createApiKey(
      session,
      {
        name: String(input['name'] ?? ''),
        scopes,
        ...(user === undefined ? {} : { user }),
        ...(days === undefined ? {} : { expiresInDays: days }),
      },
      request.ip,
    );
    return reply.status(201).send(created);
  });

  app.post('/api/v1/auth/api-keys/:id/revoke', config, async (request, reply) => {
    const session = await auth.requireSession(request);
    const id = Number((request.params as { id?: string }).id);
    if (!(Number.isInteger(id) && id > 0))
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The key id is a positive integer.');
    await auth.revokeApiKey(session, id, request.ip);
    return reply.status(204).send();
  });

  app.post('/api/v1/auth/service-accounts', config, async (request, reply) => {
    const session = await auth.requireSession(request);
    const input = body(request);
    const login = String(input['login'] ?? '').trim();
    const name = String(input['name'] ?? '').trim();
    if (!/^[A-Za-z0-9._@-]{3,64}$/.test(login) || name === '')
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid body',
        'login (3–64 letters, digits, . _ @ -) and name are required.',
      );
    const groups = Array.isArray(input['groups']) ? (input['groups'] as unknown[]).map(String) : [];
    const unknown = groups.filter((g) => !registry.registry.security.groups.has(g));
    if (unknown.length > 0)
      throw new HttpProblem(
        422,
        'invalid-groups',
        'Invalid roles',
        `Unknown roles: ${unknown.join(', ')}.`,
      );
    const created = await auth.createServiceAccount(session, { login, name, groups }, request.ip);
    return reply.status(201).send(created);
  });
}
