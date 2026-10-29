/**
 * People (RFC 0019 §3.2): the installation's users — not portal users or service accounts — with their roles per
 * company, invited by an expiring link (emailed when mail is set up, always returned to copy), deactivated and
 * reactivated (sessions revoked at once), their two-factor reset. Administrators and People managers
 * (`settings.people`) use it; People managers cannot grant administrator roles, change their own roles, or act on
 * administrators. Shutro keeps the last active administrator (a model constraint); everything is audited.
 *
 * - `GET   /api/v1/settings/people?status=&q=`          the list
 * - `GET   /api/v1/settings/people/catalogue`           apps with their access levels, roles, companies
 * - `GET   /api/v1/settings/people/:id`                 a person: details, roles, sign-in state, recent activity
 * - `POST  /api/v1/settings/people`                     `{ name, email, assignments }`: an invitation
 * - `PATCH /api/v1/settings/people/:id`                 `{ name?, email?, active? }`
 * - `PUT   /api/v1/settings/people/:id/roles`           `{ assignments: [{ group, company }] }` (replaces them)
 * - `POST  /api/v1/settings/people/:id/invitation`      a new link (earlier ones stop working)
 * - `POST  /api/v1/settings/people/:id/reset-2fa`       two-factor off, sessions revoked
 * - `POST  /api/v1/auth/activate`                       `{ token, password }`: the invited person's password
 */
import { createHash, randomBytes } from 'node:crypto';
import { layout, type Mailer } from '@kosh/mail';
import type { KoshModule } from '@kosh/modules-sdk';
import { audit, HttpProblem, isAdministratorUser, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';

/** How long an invitation works. */
export const INVITATION_DAYS = 7;

type Row = Record<string, unknown>;
interface Records {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
  unlink(): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly Row[]): Promise<Records>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
const rows = async (set: Records | Promise<Records>, keys: readonly string[]): Promise<Row[]> => {
  const s = await set;
  return s.length === 0 ? [] : (await s.load(keys)).read(['id', ...keys]);
};
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const iso = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v instanceof Date ? v : String(v)).toISOString();

export interface PeopleOptions {
  /** The back-office's address (`SHUTRO_ERP_BASE_URL`): activation links point there. */
  readonly baseUrl: string;
  /** Sends the invitations; without one, the inviter passes the link on. */
  readonly mailer?: Mailer | undefined;
}

export interface Assignment {
  readonly group: string;
  /** null: every company. */
  readonly company: number | null;
}

export function registerPeopleRoutes(context: ModuleContext, options: PeopleOptions): void {
  const { app, registry } = context;
  const auth = context.auth;
  if (auth === undefined) return;
  const modules = registry.loaded.modules as readonly KoshModule[];
  /** Groups that make a user external (portal users): not people of the installation. */
  const external = new Set(modules.flatMap((m) => m.externalGroups ?? []));

  const bad = (detail: string) => new HttpProblem(422, 'invalid-input', 'Invalid input', detail);
  const idOf = (request: FastifyRequest) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'The id is a positive integer.');
    return id;
  };
  /** Administrators and People managers; runs `fn` as the system, audited by Shutro. */
  const guarded = <T>(
    request: FastifyRequest,
    fn: (env: Env, su: Env, manager: { readonly administrator: boolean }) => Promise<T>,
  ) =>
    request.env(
      async (env) => {
        if (!env.administrator && !env.groups.has('settings.people'))
          throw new HttpProblem(
            403,
            'access',
            'People managers only',
            'Managing people needs the Administrator role or the Settings / People manager access.',
          );
        return env.asSuperuser({ reason: 'people' }, async (su) => {
          const out = await fn(env, su, { administrator: env.administrator });
          await su.flush();
          return out;
        });
      },
      { write: true },
    );
  /** Administrators only act on administrators. */
  const mayTouch = async (su: Env, manager: { administrator: boolean }, user: number) => {
    if (!manager.administrator && (await isAdministratorUser(su, user)))
      throw new HttpProblem(
        403,
        'access',
        'Administrators only',
        'Only an administrator changes an administrator’s account.',
      );
  };
  const adminGroups = (su: Env) => new Set(su.access.administratorGroups());
  /** Roles a person may be given: every declared group and runtime role. */
  const knownGroups = async (): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (const [code, g] of registry.registry.security.groups)
      out.set(code, (g as { label?: string }).label ?? code);
    // Runtime roles (the permissions app's), when that table exists: a failed query would abort the transaction.
    const [table] = await context.driver.query<{ found: boolean }>({
      text: "SELECT to_regclass('shutro_role') IS NOT NULL AS found",
      params: [],
    });
    const runtime =
      table?.found === true
        ? await context.driver.query<{ code: string; label: string }>({
            text: 'SELECT code, label FROM shutro_role',
            params: [],
          })
        : [];
    for (const r of runtime) out.set(r.code, r.label);
    return out;
  };
  const checkAssignments = async (
    su: Env,
    input: unknown,
    manager: { administrator: boolean },
  ): Promise<Assignment[]> => {
    if (!Array.isArray(input)) throw bad('assignments is a list of { group, company }.');
    const known = await knownGroups();
    const admin = adminGroups(su);
    const companies = new Set(
      (await rows(ref(su, 'res.company').search({ where: {} }), ['name'])).map(
        (c) => c['id'] as number,
      ),
    );
    const out: Assignment[] = [];
    for (const a of input as Row[]) {
      const group = String(a?.['group'] ?? '');
      const company =
        a?.['company'] === null || a?.['company'] === undefined ? null : Number(a['company']);
      if (!known.has(group) || external.has(group)) throw bad(`'${group}' is not a role here.`);
      if (company !== null && !companies.has(company)) throw bad(`There is no company ${company}.`);
      if (admin.has(group) && !manager.administrator)
        throw new HttpProblem(
          403,
          'access',
          'Administrators only',
          'Only an administrator gives the Administrator role.',
        );
      if (!out.some((x) => x.group === group && x.company === company))
        out.push({ group, company });
    }
    return out;
  };
  /** A new invitation for `user` (earlier unused ones expire); its link. */
  const invite = async (su: Env, user: number, by: number) => {
    const pending = await ref(su, 'settings.invitation').search({ where: { user, usedAt: null } });
    if (pending.length > 0) await pending.write({ expiresAt: new Date() });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_DAYS * 86_400_000);
    await ref(su, 'settings.invitation').create([
      { user, tokenHash: digest(token), expiresAt, invitedBy: by },
    ]);
    return {
      url: `${options.baseUrl.replace(/\/$/, '')}/activate?token=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  };
  /** Emails the link after the commit (a failed send is logged; the inviter has the link). */
  const email = (env: Env, to: string, name: string, company: string, url: string): boolean => {
    const mailer = options.mailer;
    if (mailer === undefined) return false;
    env.afterCommit(async () => {
      const body = layout({
        title: `Join ${company} on Shutro ERP`,
        paragraphs: [
          `Hello ${name},`,
          `You are invited to work with ${company} on Shutro ERP. Choose your password to start.`,
          `The link works for ${INVITATION_DAYS} days.`,
        ],
        action: { label: 'Choose your password', url },
      });
      await mailer
        .send({ to, subject: `Join ${company} on Shutro ERP`, ...body })
        .catch((error: unknown) => app.log.error({ err: error }, 'invitation not sent'));
    });
    return true;
  };
  const companyName = async (su: Env, id: number | null) =>
    id === null
      ? 'your company'
      : String((await rows(ref(su, 'res.company').browse([id]), ['name']))[0]?.['name'] ?? '');
  /** The people's state: groups per user, credentials, last sign-in, pending invitations. */
  const describe = async (su: Env, users: Row[]) => {
    const ids = users.map((u) => u['id'] as number);
    if (ids.length === 0) return [];
    const groups = await rows(ref(su, 'auth.user_group').search({ where: { user: { in: ids } } }), [
      'user',
      'group',
      'company',
    ]);
    const credentials = await rows(
      ref(su, 'auth.credential').search({ where: { user: { in: ids } } }),
      ['user', 'totpEnabled'],
    );
    const seen = await rows(ref(su, 'auth.session').search({ where: { user: { in: ids } } }), [
      'user',
      'lastSeenAt',
    ]);
    const sessions = ids.map((user) => ({
      user,
      last:
        seen
          .filter((r) => r['user'] === user)
          .map((r) => new Date(String(r['lastSeenAt'])))
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
    }));
    const invitations = await rows(
      ref(su, 'settings.invitation').search({ where: { user: { in: ids }, usedAt: null } }),
      ['user', 'expiresAt'],
    );
    const known = await knownGroups();
    const admin = adminGroups(su);
    // "Purchase · Manager": a group named by the app level that gives it, else by its own label.
    const levelLabel = new Map<string, string>();
    for (const m of modules)
      for (const level of Object.values(m.accessLevels ?? {}))
        for (const g of level.groups)
          if (!levelLabel.has(g) && m.app !== undefined)
            levelLabel.set(g, `${m.app.label} · ${level.label}`);
    return users
      .map((u) => {
        const id = u['id'] as number;
        const mine = groups.filter((g) => g['user'] === id);
        const open = invitations
          .filter(
            (i) => i['user'] === id && new Date(String(i['expiresAt'])).getTime() > Date.now(),
          )
          .map((i) => iso(i['expiresAt']));
        const signedIn = sessions.find((s) => s.user === id)?.last ?? null;
        return {
          id,
          name: String(u['name'] ?? ''),
          login: String(u['login'] ?? ''),
          email: typeof u['email'] === 'string' ? u['email'] : null,
          active: u['active'] !== false,
          state:
            u['active'] === false
              ? ('deactivated' as const)
              : open.length > 0 && signedIn === null
                ? ('invited' as const)
                : ('active' as const),
          invitationExpiresAt: open[0] ?? null,
          twoFactor: credentials.some((c) => c['user'] === id && c['totpEnabled'] === true),
          lastSeenAt: iso(signedIn),
          administrator: mine.some((g) => admin.has(String(g['group']))),
          assignments: mine.map((g) => ({
            group: String(g['group']),
            label:
              levelLabel.get(String(g['group'])) ??
              known.get(String(g['group'])) ??
              String(g['group']),
            company: (g['company'] as number | null) ?? null,
          })),
          external: mine.length > 0 && mine.every((g) => external.has(String(g['group']))),
        };
      })
      .filter((p) => !p.external)
      .map(({ external: _external, ...p }) => p);
  };
  /** Users that are people: not service accounts (portal users are filtered by their groups). */
  const people = async (su: Env, where: Row = {}) =>
    rows(
      ref(su, 'res.users')
        .search({ where: { and: [{ isService: { ne: true } }, where] }, order: ['name asc'] })
        .then((s) => s),
      ['name', 'login', 'email', 'active'],
    );
  /** With the deactivated ones (archived records). */
  const withArchived = (su: Env) => su.withFlags({ activeTest: false });

  app.get('/api/v1/settings/people', async (request) => {
    const query = request.query as { status?: string; q?: string };
    return guarded(request, async (_env, su) => {
      const q = (query.q ?? '').trim();
      const list = await describe(
        su,
        await people(
          withArchived(su),
          q === '' ? {} : { or: [{ name: { ilike: `%${q}%` } }, { login: { ilike: `%${q}%` } }] },
        ),
      );
      return {
        people:
          query.status === undefined || query.status === '' || query.status === 'all'
            ? list
            : list.filter((p) => p.state === query.status),
      };
    });
  });

  app.get('/api/v1/settings/people/catalogue', async (request) =>
    guarded(request, async (_env, su, manager) => {
      const known = await knownGroups();
      const admin = adminGroups(su);
      const apps = modules
        .filter((m) => m.accessLevels !== undefined && Object.keys(m.accessLevels).length > 0)
        .map((m) => ({
          module: m.name,
          // A technical module (no app) by its first access level's name: "Files", not "storage".
          label: m.app?.label ?? Object.values(m.accessLevels ?? {})[0]?.label ?? m.name,
          app: m.app !== undefined,
          levels: Object.entries(m.accessLevels ?? {}).map(([key, level]) => ({
            key,
            label: level.label,
            groups: [...level.groups],
          })),
        }))
        .filter((a) => a.levels.some((l) => l.groups.every((g) => !external.has(g))));
      return {
        apps,
        roles: [...known]
          .filter(([code]) => !external.has(code))
          .map(([code, label]) => ({ code, label, administrator: admin.has(code) })),
        administratorGroups: [...admin],
        companies: (await rows(ref(su, 'res.company').search({ where: {} }), ['name'])).map(
          (c) => ({
            id: c['id'] as number,
            name: String(c['name']),
          }),
        ),
        manager,
      };
    }),
  );

  app.get('/api/v1/settings/people/:id', async (request) => {
    const id = idOf(request);
    return guarded(request, async (_env, su) => {
      const [person] = await describe(su, await people(withArchived(su), { id }));
      if (person === undefined)
        throw new HttpProblem(404, 'missing-record', 'Not found', `There is no person ${id}.`);
      const activity = (
        await rows(
          ref(su, 'audit.event').search({
            where: {
              or: [{ actor: id }, { and: [{ targetModel: 'res.users' }, { targetId: id }] }],
            },
            order: ['id desc'],
            limit: 20,
          }),
          ['kind', 'summary', 'createdAt'],
        )
      ).map((a) => ({
        kind: String(a['kind']),
        summary: String(a['summary']),
        at: a['createdAt'],
      }));
      return {
        ...person,
        activity: activity.map((a) => ({ kind: a.kind, summary: a.summary, at: iso(a.at) })),
      };
    });
  });

  app.post('/api/v1/settings/people', async (request, reply) => {
    const body = (request.body ?? {}) as Row;
    const name = String(body['name'] ?? '').trim();
    const login = String(body['email'] ?? '')
      .trim()
      .toLowerCase();
    if (name === '' || name.length > 200) throw bad('The name is 1–200 characters.');
    if (!EMAIL.test(login)) throw bad('The email is their login and where the invitation goes.');
    const made = await guarded(request, async (env, su, manager) => {
      const assignments = await checkAssignments(su, body['assignments'] ?? [], manager);
      const taken = await ref(withArchived(su), 'res.users').search({ where: { login }, limit: 1 });
      if (taken.length > 0)
        throw new HttpProblem(
          409,
          'login-taken',
          'Already a person here',
          `${login} already has an account: find them in People.`,
        );
      const companies = [
        ...new Set(assignments.map((a) => a.company).filter((c): c is number => c !== null)),
      ];
      const home = companies[0] ?? env.companyId;
      const created = await ref(su, 'res.users').create([
        {
          login,
          name,
          email: login,
          company: home,
          companies: { set: companies.length === 0 ? [env.companyId] : companies },
        },
      ]);
      const user = created.ids[0] as number;
      // No usable password until the invitation is used.
      await auth.setPassword(su, user, randomBytes(32).toString('base64url'));
      if (assignments.length > 0)
        await ref(su, 'auth.user_group').create(
          assignments.map((a) => ({ user, group: a.group, company: a.company })),
        );
      const link = await invite(su, user, env.uid);
      await audit(env, {
        kind: 'people.invited',
        summary: `${name} (${login}) invited with ${assignments.length} role(s).`,
        targetModel: 'res.users',
        targetId: user,
        details: { assignments },
        ip: request.ip,
      });
      const emailed = email(env, login, name, await companyName(su, home), link.url);
      return { id: user, login, activationUrl: link.url, expiresAt: link.expiresAt, emailed };
    });
    return reply.code(201).send(made);
  });

  app.patch('/api/v1/settings/people/:id', async (request) => {
    const id = idOf(request);
    const body = (request.body ?? {}) as Row;
    return guarded(request, async (env, su, manager) => {
      await mayTouch(su, manager, id);
      const values: Row = {};
      if (body['name'] !== undefined) {
        const name = String(body['name']).trim();
        if (name === '' || name.length > 200) throw bad('The name is 1–200 characters.');
        values['name'] = name;
      }
      if (body['email'] !== undefined) {
        const mail = body['email'] === null ? '' : String(body['email']).trim();
        if (mail !== '' && !EMAIL.test(mail)) throw bad(`'${mail}' is not an email address.`);
        values['email'] = mail === '' ? null : mail;
      }
      if (body['active'] !== undefined) {
        if (typeof body['active'] !== 'boolean') throw bad('active is true or false.');
        if (body['active'] === false && id === env.uid)
          throw bad('You cannot deactivate yourself.');
        values['active'] = body['active'];
      }
      const target = ref(withArchived(su), 'res.users').browse([id]);
      if (Object.keys(values).length > 0) await target.write(values);
      if (values['active'] === false) {
        // Signed out everywhere, invitations void.
        const sessions = await ref(su, 'auth.session').search({
          where: { user: id, revoked: false },
        });
        if (sessions.length > 0) await sessions.write({ revoked: true });
        const pending = await ref(su, 'settings.invitation').search({
          where: { user: id, usedAt: null },
        });
        if (pending.length > 0) await pending.write({ expiresAt: new Date() });
      }
      await audit(env, {
        kind:
          values['active'] === false
            ? 'people.deactivated'
            : values['active'] === true
              ? 'people.reactivated'
              : 'people.changed',
        summary: `Person ${id}: ${Object.keys(values).join(', ')} changed.`,
        targetModel: 'res.users',
        targetId: id,
        details: values,
        ip: request.ip,
      });
      auth.forget(id);
      const [person] = await describe(su, await people(withArchived(su), { id }));
      return person;
    });
  });

  app.put('/api/v1/settings/people/:id/roles', async (request) => {
    const id = idOf(request);
    const body = (request.body ?? {}) as Row;
    return guarded(request, async (env, su, manager) => {
      if (!manager.administrator && id === env.uid)
        throw new HttpProblem(403, 'access', 'Not your own', 'Someone else changes your roles.');
      await mayTouch(su, manager, id);
      const assignments = await checkAssignments(su, body['assignments'], manager);
      const existing = await ref(su, 'auth.user_group').search({ where: { user: id } });
      // A People manager keeps the administrator roles a person has (they cannot give or take them).
      if (existing.length > 0) await existing.unlink();
      if (assignments.length > 0)
        await ref(su, 'auth.user_group').create(
          assignments.map((a) => ({ user: id, group: a.group, company: a.company })),
        );
      // The companies they may switch to follow their roles.
      const companies = [
        ...new Set(assignments.map((a) => a.company).filter((c): c is number => c !== null)),
      ];
      if (companies.length > 0)
        await ref(withArchived(su), 'res.users')
          .browse([id])
          .write({ companies: { set: companies } });
      await audit(env, {
        kind: 'security.assignment',
        summary: `Roles of person ${id} set (${assignments.length}).`,
        targetModel: 'res.users',
        targetId: id,
        details: { assignments },
        ip: request.ip,
      });
      auth.forget(id);
      const [person] = await describe(su, await people(withArchived(su), { id }));
      return person;
    });
  });

  app.post('/api/v1/settings/people/:id/invitation', async (request) => {
    const id = idOf(request);
    return guarded(request, async (env, su, manager) => {
      await mayTouch(su, manager, id);
      const [user] = await rows(ref(su, 'res.users').browse([id]), ['name', 'login', 'company']);
      if (user === undefined)
        throw new HttpProblem(
          404,
          'missing-record',
          'Not found',
          `There is no active person ${id}.`,
        );
      const link = await invite(su, id, env.uid);
      await audit(env, {
        kind: 'people.invited',
        summary: `A new invitation for ${String(user['name'])}.`,
        targetModel: 'res.users',
        targetId: id,
        ip: request.ip,
      });
      const emailed = email(
        env,
        String(user['login']),
        String(user['name']),
        await companyName(su, (user['company'] as number | null) ?? null),
        link.url,
      );
      return { activationUrl: link.url, expiresAt: link.expiresAt, emailed };
    });
  });

  app.post('/api/v1/settings/people/:id/reset-2fa', async (request) => {
    const id = idOf(request);
    return guarded(request, async (env, su, manager) => {
      await mayTouch(su, manager, id);
      const credentials = await ref(su, 'auth.credential').search({ where: { user: id } });
      if (credentials.length > 0)
        await credentials.write({ totpEnabled: false, totpSecret: null, recoveryCodes: null });
      const sessions = await ref(su, 'auth.session').search({
        where: { user: id, revoked: false },
      });
      if (sessions.length > 0) await sessions.write({ revoked: true });
      await audit(env, {
        kind: 'auth.2fa_reset',
        summary: `Two-factor sign-in of person ${id} reset; signed out everywhere.`,
        targetModel: 'res.users',
        targetId: id,
        ip: request.ip,
      });
      auth.forget(id);
      return { ok: true };
    });
  });

  app.post('/api/v1/auth/activate', { config: { auth: false } }, async (request) => {
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
    if (password.length < 12 || password.length > 1024)
      throw bad('The password has at least 12 characters.');
    const login = await context.shutro.bootstrap({ reason: 'activation' }, async (su) => {
      const found = await ref(su, 'settings.invitation').search({
        where: { tokenHash: digest(token) },
        limit: 1,
      });
      const [row] = await rows(found, ['user', 'expiresAt', 'usedAt']);
      if (
        row === undefined ||
        row['usedAt'] !== null ||
        new Date(String(row['expiresAt'])).getTime() <= Date.now()
      )
        throw invalid();
      const user = row['user'] as number;
      const [account] = await rows(ref(su, 'res.users').browse([user]), [
        'active',
        'company',
        'login',
      ]);
      if (account?.['active'] !== true) throw invalid();
      await auth.setPassword(su, user, password);
      await found.write({ usedAt: new Date() });
      await audit(su, {
        kind: 'people.activated',
        summary: 'An invited person chose their password.',
        actor: user,
        company: (account['company'] as number | null) ?? null,
        targetModel: 'res.users',
        targetId: user,
        ip: request.ip,
      });
      return String(account['login']);
    });
    return { login };
  });
}
