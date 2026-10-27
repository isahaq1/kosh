/**
 * Portal access (RFC 0015 §5.1–5.2).
 *
 * In the back-office, for holders of `portal.manager` (and administrators):
 * - `GET    /api/v1/portal/access?partner=…`         the contact's portal users (active or not, activated or not)
 * - `POST   /api/v1/portal/access`                   `{ partner }`: a portal user for the contact, and an invitation
 * - `POST   /api/v1/portal/access/:user/invitation`  a new invitation (the earlier ones stop working)
 * - `DELETE /api/v1/portal/access/:user`             revoke: the user is archived and their sessions end
 *
 * In the portal:
 * - `POST /api/portal/v1/activate`                   `{ token, password }`: the invited contact chooses a password;
 *                                                      their login comes back
 * - `GET  /api/portal/v1/me`                         who is signed in, for which contact and company
 *
 * Invitations are single use, valid 7 days and stored as SHA-256 digests; the link goes by email when a mailer is
 * configured, and back to the inviter either way. Every step is audited.
 */
import { createHash, randomBytes } from 'node:crypto';
import { layout, type Mailer } from '@kosh/mail';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';

type Row = Record<string, unknown>;
interface Records {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly unknown[]): Promise<Records>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;

/** How long an invitation works. */
export const INVITATION_DAYS = 7;
/** The group of portal users. */
export const PORTAL_USER = 'portal.user';

export interface PortalRoutesOptions {
  /** Where the portal app is served: activation links point there. */
  readonly portalUrl: string;
  /** Sends the invitations; without one, the inviter passes the link on. */
  readonly mailer?: Mailer | undefined;
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const idOf = (value: unknown, what: string): number => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new HttpProblem(400, 'invalid-id', 'Invalid id', `${what} is a positive integer.`);
  return id;
};

export function registerPortalRoutes(context: ModuleContext, options: PortalRoutesOptions): void {
  const { app } = context;
  const auth = context.auth;
  if (auth === undefined) return; // no sign-in without base

  const manager = (env: Env) => {
    if (!env.administrator && !env.groups.has('portal.manager'))
      throw new HttpProblem(
        403,
        'access',
        'Portal access managers only',
        'Granting portal access needs the Portal access level.',
      );
  };
  const portalOnly = (env: Env) => {
    if (!env.groups.has(PORTAL_USER) || env.groups.has('base.user'))
      throw new HttpProblem(403, 'portal-only', 'Portal users only', 'This is the portal’s API.');
  };

  /** A new invitation for `user` (earlier unused ones are expired); its link. */
  const invite = async (su: Env, user: number, by: number) => {
    const pending = await ref(su, 'portal.invitation').search({
      where: { user, usedAt: null },
    });
    if (pending.length > 0) await pending.write({ expiresAt: new Date() });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86_400_000);
    await ref(su, 'portal.invitation').create([
      { user, tokenHash: digest(token), expiresAt, invitedBy: by },
    ]);
    const url = `${options.portalUrl.replace(/\/$/, '')}/activate?token=${token}`;
    return { url, expiresAt };
  };
  /** Emails the invitation once the transaction commits (a failed send is logged; the inviter has the link). */
  const email = (env: Env, to: string, name: string, company: string, url: string): boolean => {
    const mailer = options.mailer;
    if (mailer === undefined) return false;
    env.afterCommit(async () => {
      const body = layout({
        title: `Your access to ${company}`,
        paragraphs: [
          `Hello ${name},`,
          `${company} invites you to its portal: your quotations, orders and invoices in one place.`,
          `The link works for ${INVITATION_DAYS} days.`,
        ],
        action: { label: 'Choose your password', url },
      });
      await mailer
        .send({ to, subject: `Your access to ${company}`, ...body })
        .catch((error: unknown) => app.log.error({ err: error }, 'portal invitation not sent'));
    });
    return true;
  };
  const companyName = async (su: Env, company: number) => {
    const [row] = (await ref(su, 'res.company').browse([company]).load(['name'])).read(['name']);
    return String(row?.['name'] ?? '');
  };

  app.get('/api/v1/portal/access', async (request) => {
    const partner = idOf((request.query as Row | undefined)?.['partner'], 'partner');
    return request.env(
      async (env) => {
        manager(env);
        const visible = await ref(env, 'res.partner').search({ where: { id: partner }, limit: 1 });
        if (visible.length === 0)
          throw new HttpProblem(404, 'not-found', 'No such contact', `No contact #${partner}.`);
        return env.asSuperuser({ reason: 'portal access' }, async (su) => {
          const keys = ['login', 'active'];
          // Revoked (archived) users too.
          const users = await ref(su.withFlags({ activeTest: false }), 'res.users').search({
            where: { portalPartner: partner },
          });
          const rows = (await users.load(keys)).read(keys);
          const out = [];
          for (const row of rows) {
            const id = row['id'] as number;
            const invitations = await ref(su, 'portal.invitation').search({ where: { user: id } });
            const sent = (await invitations.load(['usedAt', 'expiresAt'])).read([
              'usedAt',
              'expiresAt',
            ]);
            const open = sent
              .filter(
                (i) =>
                  i['usedAt'] === null && new Date(String(i['expiresAt'])).getTime() > Date.now(),
              )
              .map((i) => String(i['expiresAt']));
            out.push({
              id,
              login: String(row['login']),
              active: row['active'] === true,
              activated: sent.some((i) => i['usedAt'] !== null),
              invitationExpiresAt: open[0] ?? null,
            });
          }
          return { users: out };
        });
      },
      { write: true },
    );
  });

  app.post('/api/v1/portal/access', async (request, reply) => {
    const partner = idOf((request.body as Row | undefined)?.['partner'], 'partner');
    const granted = await request.env(
      async (env) => {
        manager(env);
        const found = await ref(env, 'res.partner').search({ where: { id: partner }, limit: 1 });
        const [contact] = (await found.load(['name', 'email'])).read(['name', 'email']);
        if (contact === undefined)
          throw new HttpProblem(404, 'not-found', 'No such contact', `No contact #${partner}.`);
        const login = String(contact['email'] ?? '')
          .trim()
          .toLowerCase();
        if (login === '')
          throw new HttpProblem(
            422,
            'no-email',
            'No email address',
            'The contact needs an email address: it is their login and where the invitation goes.',
          );
        const name = String(contact['name']);
        return env.asSuperuser({ reason: 'portal access' }, async (su) => {
          const all = su.withFlags({ activeTest: false });
          const taken = await ref(all, 'res.users').search({ where: { login }, limit: 1 });
          const [existing] = (await taken.load(['active', 'portalPartner'])).read([
            'active',
            'portalPartner',
          ]);
          let user: number;
          if (existing !== undefined) {
            // This contact's revoked portal user comes back; any other user keeps the login.
            if (existing['portalPartner'] !== partner || existing['active'] === true)
              throw new HttpProblem(
                409,
                'login-taken',
                'Already a user',
                `A user with the login ${login} exists already.`,
                'Send the invitation again, or use another email for this contact.',
              );
            user = existing['id'] as number;
            await taken.write({ active: true });
            await auth.setPassword(su, user, randomBytes(32).toString('base64url'));
          } else {
            const created = await ref(su, 'res.users').create([
              {
                login,
                name,
                email: login,
                company: env.companyId,
                companies: { set: [env.companyId] },
                portalPartner: partner,
              },
            ]);
            user = created.ids[0] as number;
            // No usable password until the invitation is used.
            await auth.setPassword(su, user, randomBytes(32).toString('base64url'));
            await ref(su, 'auth.user_group').create([{ user, group: PORTAL_USER }]);
          }
          const { url, expiresAt } = await invite(su, user, env.uid);
          await audit(env, {
            kind: 'portal.invited',
            summary: `Portal access granted to ${name} (${login}).`,
            targetModel: 'res.users',
            targetId: user,
            details: { partner },
            ip: request.ip,
          });
          const emailed = email(env, login, name, await companyName(su, env.companyId), url);
          return { user, login, activationUrl: url, expiresAt: expiresAt.toISOString(), emailed };
        });
      },
      { write: true },
    );
    return reply.code(201).send(granted);
  });

  /** The portal user `id`, if it is a portal user the caller may manage (their contact is readable). */
  const portalUser = async (env: Env, su: Env, id: number) => {
    const keys = ['login', 'name', 'portalPartner', 'active'];
    const [row] = (await ref(su, 'res.users').browse([id]).load(keys)).read(keys);
    const partner = row?.['portalPartner'];
    if (row === undefined || typeof partner !== 'number')
      throw new HttpProblem(404, 'not-found', 'No such portal user', `No portal user #${id}.`);
    const visible = await ref(env, 'res.partner').search({ where: { id: partner }, limit: 1 });
    if (visible.length === 0)
      throw new HttpProblem(404, 'not-found', 'No such portal user', `No portal user #${id}.`);
    return {
      login: String(row['login']),
      name: String(row['name']),
      active: row['active'] === true,
    };
  };

  app.post('/api/v1/portal/access/:user/invitation', async (request, reply) => {
    const id = idOf((request.params as Row)['user'], 'user');
    const sent = await request.env(
      async (env) => {
        manager(env);
        return env.asSuperuser({ reason: 'portal access' }, async (su) => {
          const user = await portalUser(env, su, id);
          if (!user.active)
            throw new HttpProblem(409, 'revoked', 'Access revoked', 'Grant access again first.');
          const { url, expiresAt } = await invite(su, id, env.uid);
          await audit(env, {
            kind: 'portal.invited',
            summary: `Portal invitation sent again to ${user.name} (${user.login}).`,
            targetModel: 'res.users',
            targetId: id,
            ip: request.ip,
          });
          const emailed = email(
            env,
            user.login,
            user.name,
            await companyName(su, env.companyId),
            url,
          );
          return { activationUrl: url, expiresAt: expiresAt.toISOString(), emailed };
        });
      },
      { write: true },
    );
    return reply.code(201).send(sent);
  });

  app.delete('/api/v1/portal/access/:user', async (request, reply) => {
    const id = idOf((request.params as Row)['user'], 'user');
    await request.env(
      async (env) => {
        manager(env);
        await env.asSuperuser({ reason: 'portal access' }, async (su) => {
          const user = await portalUser(env, su, id);
          await ref(su, 'res.users').browse([id]).write({ active: false });
          const sessions = await ref(su, 'auth.session').search({
            where: { user: id, revoked: false },
          });
          if (sessions.length > 0) await sessions.write({ revoked: true });
          const pending = await ref(su, 'portal.invitation').search({
            where: { user: id, usedAt: null },
          });
          if (pending.length > 0) await pending.write({ expiresAt: new Date() });
          await audit(env, {
            kind: 'portal.revoked',
            summary: `Portal access revoked for ${user.name} (${user.login}).`,
            targetModel: 'res.users',
            targetId: id,
            ip: request.ip,
          });
        });
      },
      { write: true },
    );
    return reply.code(204).send();
  });

  app.post('/api/portal/v1/activate', { config: { auth: false } }, async (request, reply) => {
    const body = (request.body ?? {}) as Row;
    const token = typeof body['token'] === 'string' ? body['token'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const invalid = () =>
      new HttpProblem(
        410,
        'invitation-invalid',
        'This link no longer works',
        'The invitation was used, replaced or has expired.',
        'Ask for a new invitation.',
      );
    if (token === '') throw invalid();
    const login = await context.shutro.bootstrap({ reason: 'portal activation' }, async (su) => {
      const found = await ref(su, 'portal.invitation').search({
        where: { tokenHash: digest(token) },
        limit: 1,
      });
      const [row] = (await found.load(['user', 'expiresAt', 'usedAt'])).read([
        'user',
        'expiresAt',
        'usedAt',
      ]);
      if (
        row === undefined ||
        row['usedAt'] !== null ||
        new Date(String(row['expiresAt'])).getTime() <= Date.now()
      )
        throw invalid();
      const user = row['user'] as number;
      const [account] = (
        await ref(su, 'res.users').browse([user]).load(['active', 'company', 'login'])
      ).read(['active', 'company', 'login']);
      if (account?.['active'] !== true) throw invalid();
      await auth.setPassword(su, user, password);
      await found.write({ usedAt: new Date() });
      await audit(su, {
        kind: 'portal.activated',
        summary: 'A portal user chose their password.',
        actor: user,
        company: (account['company'] as number | null) ?? null,
        targetModel: 'res.users',
        targetId: user,
        ip: request.ip,
      });
      return String(account['login']);
    });
    // The login: the portal signs the user in with the password they just chose.
    return reply.send({ login });
  });

  app.get('/api/portal/v1/me', async (request) =>
    request.env(
      async (env) => {
        portalOnly(env);
        return env.asSuperuser({ reason: 'portal me' }, async (su) => {
          const keys = ['login', 'name', 'portalPartner', 'company', 'lang'];
          const [user] = (await ref(su, 'res.users').browse([env.uid]).load(keys)).read(keys);
          const partnerId = user?.['portalPartner'];
          const [partner] =
            typeof partnerId === 'number'
              ? (await ref(su, 'res.partner').browse([partnerId]).load(['name', 'parent'])).read([
                  'name',
                  'parent',
                ])
              : [];
          return {
            user: env.uid,
            login: String(user?.['login'] ?? ''),
            name: String(user?.['name'] ?? ''),
            lang: String(user?.['lang'] ?? 'en_US'),
            partner:
              partner === undefined ? null : { id: partner['id'], name: String(partner['name']) },
            company: { id: env.companyId, name: await companyName(su, env.companyId) },
          };
        });
      },
      { write: true },
    ),
  );
}
