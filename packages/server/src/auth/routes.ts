/**
 * Authentication routes (`/api/v1/auth/*`). Sign-in is public but limited per IP and login (brute force);
 * everything else needs a session.
 *
 * - `POST /api/v1/auth/login`         `{ login, password }` → `{ token, csrfToken, twoFactorRequired }` + cookie
 * - `POST /api/v1/auth/logout`        revokes the session, clears the cookie
 * - `GET  /api/v1/auth/me`            the signed-in user
 * - `POST /api/v1/auth/2fa/setup`     `{ secret, otpauthUri }` (pending until enabled)
 * - `POST /api/v1/auth/2fa/enable`    `{ code }` → `{ recoveryCodes }`
 * - `POST /api/v1/auth/2fa/verify`    `{ code }` (TOTP or recovery code) completes a pending sign-in
 * - `POST /api/v1/auth/2fa/disable`   `{ password, code }`
 * - `POST /api/v1/auth/password`      `{ current, next }`; other sessions are revoked
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpProblem } from '../errors.js';
import type { AuthService } from './service.js';

function text(request: FastifyRequest, key: string): string {
  const body = request.body as Record<string, unknown> | null | undefined;
  const value = typeof body === 'object' && body !== null ? body[key] : undefined;
  if (typeof value !== 'string' || value === '' || value.length > 1024)
    throw new HttpProblem(400, 'invalid-body', 'Invalid body', `'${key}' is required (a string).`);
  return value;
}

/** Registers the routes; `loginLimit` attempts per 15 minutes per IP and login (default 10). */
export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  options: { readonly loginLimit?: number } = {},
): void {
  const limited = options.loginLimit !== 0;
  app.post(
    '/api/v1/auth/login',
    {
      config: {
        auth: false,
        ...(limited
          ? {
              rateLimit: {
                hook: 'preHandler' as const, // after body parsing: the key includes the login
                max: options.loginLimit ?? 10,
                timeWindow: '15 minutes',
                keyGenerator: (request: FastifyRequest) => {
                  const login = (request.body as { login?: unknown } | undefined)?.login;
                  return `login:${request.ip}:${typeof login === 'string' ? login.toLowerCase() : ''}`;
                },
              },
            }
          : {}),
      },
    },
    async (request, reply) => {
      const result = await auth.login(request, text(request, 'login'), text(request, 'password'));
      reply.header('set-cookie', auth.cookie(result.token));
      return result;
    },
  );

  app.post('/api/v1/auth/logout', { config: { auth: false } }, async (request, reply) => {
    const session = await auth.requireSession(request, { allowPending: true });
    await auth.logout(session);
    reply.header('set-cookie', auth.cookie(null));
    return { ok: true };
  });

  app.get('/api/v1/auth/me', { config: { auth: false } }, async (request) =>
    auth.me(await auth.requireSession(request)),
  );

  app.post('/api/v1/auth/2fa/setup', { config: { auth: false } }, async (request) =>
    auth.setupTwoFactor(await auth.requireSession(request)),
  );

  app.post('/api/v1/auth/2fa/enable', { config: { auth: false } }, async (request) =>
    auth.enableTwoFactor(await auth.requireSession(request), text(request, 'code')),
  );

  app.post('/api/v1/auth/2fa/verify', { config: { auth: false } }, async (request) => {
    await auth.verifyTwoFactor(
      await auth.requireSession(request, { allowPending: true }),
      text(request, 'code'),
    );
    return { ok: true };
  });

  app.post('/api/v1/auth/2fa/disable', { config: { auth: false } }, async (request) => {
    await auth.disableTwoFactor(
      await auth.requireSession(request),
      text(request, 'password'),
      text(request, 'code'),
    );
    return { ok: true };
  });

  app.post('/api/v1/auth/password', { config: { auth: false } }, async (request) => {
    await auth.changePassword(
      await auth.requireSession(request),
      text(request, 'current'),
      text(request, 'next'),
    );
    return { ok: true };
  });
}
