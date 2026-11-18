/**
 * SCIM 2.0 provisioning (RFC 0034 §2.4, design of 2026-11-18): people and their roles follow the company's
 * directory — Entra ID, Okta, any SCIM client. The directory creates a person here when they join, updates them,
 * deactivates them when they leave, and keeps its groups' members in step; a group gives the roles an Administrator
 * set for it.
 *
 * - **A token per directory** (`Authorization: Bearer …`), made by an Administrator and shown once; only its hash
 *   is kept. It provisions into one company.
 * - **People**: `userName` is the login, `emails` the address, `displayName` / `name` the name, `active` whether they
 *   may sign in. A person made here has no password: they sign in through single sign-on, or ask for a reset link.
 *   **Nobody is ever deleted**: `DELETE` and `active: false` deactivate (signed out everywhere), so their records
 *   and the audit log keep their author. The last Administrator cannot be deactivated (the model refuses it).
 * - **Groups**: a directory group and its members. Its roles are set here, by an Administrator — never by the
 *   directory — and never an Administrator's. A person holds exactly the roles their groups give, among the roles
 *   any group gives: given and taken as memberships change, in the audit log; other roles are never touched.
 * - Portal users and service accounts are not the directory's: they are not listed and cannot be changed.
 *
 * `GET /api/scim/v2/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`; `/Users` and `/Groups` with `GET` (a list with
 * `filter=userName eq "…"`, `startIndex`, `count`; one by id), `POST`, `PUT`, `PATCH`, `DELETE`.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { problemOf } from '../errors.js';
import type { Env, Shutro } from '../orm.js';
import type { AuthService } from './service.js';

type Row = Record<string, unknown>;
type Recs = {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<Recs>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
  unlink(): Promise<void>;
};
interface Loose {
  search(q: unknown): Promise<Recs>;
  create(values: unknown): Promise<Recs>;
}
const model = (env: Env, name: string): Loose => env.model(name as never) as unknown as Loose;
const everyone = (env: Env): Env =>
  (env as unknown as { withFlags(f: { activeTest: boolean }): Env }).withFlags({
    activeTest: false,
  });
const rows = async (set: Recs | Promise<Recs>, keys: readonly string[]): Promise<Row[]> => {
  const s = await set;
  return s.length === 0 ? [] : (await s.load(keys)).read(['id', ...keys]);
};
const idOf = (v: unknown): number =>
  typeof v === 'object' && v !== null ? Number((v as { id: unknown }).id) : Number(v);
const iso = (v: unknown): string | undefined =>
  v === null || v === undefined
    ? undefined
    : new Date(v instanceof Date ? v : String(v)).toISOString();

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_JSON = 'application/scim+json';

/** A SCIM error: the status, what is wrong, and the protocol's keyword for it. */
class ScimError extends Error {
  readonly status: number;
  readonly scimType: string | undefined;
  constructor(status: number, detail: string, scimType?: string) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}
const invalid = (detail: string, scimType = 'invalidValue') => new ScimError(400, detail, scimType);
const missing = (what: string) => new ScimError(404, `${what} does not exist.`);

/** The hash a SCIM token is stored as. */
export const scimTokenHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** `True`, `"False"`, `false`: the booleans directories send. */
const truth = (value: unknown): boolean | undefined =>
  typeof value === 'boolean'
    ? value
    : typeof value === 'string' && /^(true|false)$/i.test(value)
      ? value.toLowerCase() === 'true'
      : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** What a SCIM request says about a person (whatever is present). */
interface PersonChange {
  login?: string;
  name?: string;
  email?: string;
  active?: boolean;
  externalId?: string;
}
const nameIn = (resource: Row): string | undefined => {
  const name = resource['name'] as Row | undefined;
  return (
    text(resource['displayName']) ??
    text(name?.['formatted']) ??
    text([text(name?.['givenName']), text(name?.['familyName'])].filter(Boolean).join(' '))
  );
};
const emailIn = (resource: Row): string | undefined => {
  const emails = Array.isArray(resource['emails']) ? (resource['emails'] as Row[]) : [];
  const chosen = emails.find((e) => truth(e['primary']) === true) ?? emails[0];
  return text(chosen?.['value'])?.toLowerCase();
};
const personIn = (resource: Row): PersonChange => {
  const out: PersonChange = {};
  const login = text(resource['userName'])?.toLowerCase();
  if (login !== undefined) out.login = login;
  const name = nameIn(resource);
  if (name !== undefined) out.name = name;
  const email = emailIn(resource);
  if (email !== undefined) out.email = email;
  const active = truth(resource['active']);
  if (active !== undefined) out.active = active;
  const externalId = text(resource['externalId']);
  if (externalId !== undefined) out.externalId = externalId;
  return out;
};
/** A PATCH's operations on a person, as one change. Paths are read without regard to case. */
const personPatch = (body: Row): PersonChange => {
  const out: PersonChange = {};
  for (const op of Array.isArray(body['Operations']) ? (body['Operations'] as Row[]) : []) {
    const kind = String(op['op'] ?? '').toLowerCase();
    if (kind !== 'replace' && kind !== 'add') continue;
    const path = String(op['path'] ?? '').toLowerCase();
    const value = op['value'];
    if (path === '') Object.assign(out, personIn((value ?? {}) as Row));
    else if (path === 'active') {
      const active = truth(value);
      if (active !== undefined) out.active = active;
    } else if (path === 'username') {
      const login = text(value)?.toLowerCase();
      if (login !== undefined) out.login = login;
    } else if (path === 'displayname' || path === 'name.formatted') {
      const name = text(value);
      if (name !== undefined) out.name = name;
    } else if (path === 'externalid') {
      const externalId = text(value);
      if (externalId !== undefined) out.externalId = externalId;
    } else if (path.startsWith('emails')) {
      const email = (
        typeof value === 'string' ? text(value) : emailIn({ emails: value } as Row)
      )?.toLowerCase();
      if (email !== undefined) out.email = email;
    }
  }
  return out;
};

/** The member ids a request names: `[{ value: "12" }]`. */
const membersIn = (value: unknown): number[] =>
  (Array.isArray(value) ? (value as Row[]) : [])
    .map((m) => Number(m['value']))
    .filter((n) => Number.isSafeInteger(n) && n > 0);

/** `userName eq "x"`: the one comparison directories use to find what they are about to create. */
const filterOf = (
  raw: unknown,
  attributes: Readonly<Record<string, string>>,
): { field: string; value: string } | null => {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const found = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
  const field = found === null ? undefined : attributes[String(found[1]).toLowerCase()];
  if (found === null || field === undefined)
    throw new ScimError(
      400,
      `The filter is one of: ${Object.keys(attributes)
        .map((a) => `${a} eq "…"`)
        .join(', ')}.`,
      'invalidFilter',
    );
  return { field, value: String(found[2]).replace(/\\(.)/g, '$1') };
};

export function registerScimRoutes(
  app: FastifyInstance,
  auth: AuthService,
  shutro: () => Shutro,
  options: { readonly baseUrl: string; readonly externalGroups: () => ReadonlySet<string> },
): void {
  const base = `${options.baseUrl.replace(/\/$/, '')}/api/scim/v2`;

  /** The directory's token: its company, and its name for the audit log. */
  const directory = async (request: FastifyRequest): Promise<{ company: number; name: string }> => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(request.headers.authorization ?? ''))?.[1];
    const found =
      bearer === undefined
        ? undefined
        : await shutro().bootstrap({ reason: 'scim token' }, async (env) => {
            const set = await model(env, 'auth.scim_token').search({
              where: { tokenHash: scimTokenHash(bearer), revoked: false },
              limit: 1,
            });
            const [row] = await rows(set, ['name', 'company']);
            if (row !== undefined) await set.write({ lastUsedAt: new Date() });
            return row;
          });
    if (found === undefined) throw new ScimError(401, 'The token is missing, wrong or revoked.');
    return { company: idOf(found['company']), name: String(found['name']) };
  };

  // ---- people

  /** The users the directory manages: internal people (not portal users, not service accounts). */
  const outsiders = async (env: Env): Promise<Set<number>> => {
    const external = [...options.externalGroups()];
    const held =
      external.length === 0
        ? []
        : await rows(model(env, 'auth.user_group').search({ where: { group: { in: external } } }), [
            'user',
          ]);
    return new Set(held.map((h) => idOf(h['user'])));
  };
  const USER_KEYS = ['login', 'name', 'email', 'active', 'createdAt', 'updatedAt'];
  const personOf = async (env: Env, id: number): Promise<Row> => {
    const [row] = await rows(model(everyone(env), 'res.users').search({ where: { id } }), [
      ...USER_KEYS,
      'isService',
    ]);
    if (row === undefined || row['isService'] === true || (await outsiders(env)).has(id))
      throw missing(`User ${id}`);
    return row;
  };
  const shownUser = async (env: Env, row: Row): Promise<Row> => {
    const [link] = await rows(model(env, 'auth.scim_user').search({ where: { user: row['id'] } }), [
      'externalId',
    ]);
    const email =
      text(row['email']) ?? (String(row['login']).includes('@') ? String(row['login']) : undefined);
    return {
      schemas: [USER],
      id: String(row['id']),
      ...(link?.['externalId'] ? { externalId: String(link['externalId']) } : {}),
      userName: String(row['login']),
      displayName: String(row['name']),
      name: { formatted: String(row['name']) },
      ...(email === undefined ? {} : { emails: [{ value: email, primary: true }] }),
      active: row['active'] !== false,
      meta: {
        resourceType: 'User',
        location: `${base}/Users/${row['id']}`,
        ...(iso(row['createdAt']) === undefined ? {} : { created: iso(row['createdAt']) }),
        ...(iso(row['updatedAt']) === undefined ? {} : { lastModified: iso(row['updatedAt']) }),
      },
    };
  };
  /** Applies a change to a person; returns what changed, for the audit log. */
  const changePerson = async (
    env: Env,
    request: FastifyRequest,
    who: { name: string },
    id: number,
    change: PersonChange,
  ): Promise<void> => {
    const before = await personOf(env, id);
    const values: Row = {};
    if (change.login !== undefined && change.login !== before['login']) {
      const taken = await model(everyone(env), 'res.users').search({
        where: { login: change.login, id: { ne: id } },
        limit: 1,
      });
      if (taken.length > 0)
        throw new ScimError(409, `Someone else has the login ${change.login}.`, 'uniqueness');
      values['login'] = change.login;
    }
    if (change.name !== undefined && change.name !== before['name']) values['name'] = change.name;
    if (change.email !== undefined && change.email !== before['email'])
      values['email'] = change.email;
    const wasActive = before['active'] !== false;
    if (change.active !== undefined && change.active !== wasActive)
      values['active'] = change.active;
    const users = await model(everyone(env), 'res.users').search({ where: { id } });
    if (Object.keys(values).length > 0) await users.write(values);
    if (change.externalId !== undefined) {
      const link = await model(env, 'auth.scim_user').search({ where: { user: id }, limit: 1 });
      if (link.length > 0) await link.write({ externalId: change.externalId });
      else await model(env, 'auth.scim_user').create([{ user: id, externalId: change.externalId }]);
    }
    if (values['active'] === false) {
      // Signed out everywhere, at once.
      const sessions = await model(env, 'auth.session').search({
        where: { user: id, revoked: false },
      });
      if (sessions.length > 0) await sessions.write({ revoked: true });
    }
    if (Object.keys(values).length > 0)
      await audit(env, {
        kind:
          values['active'] === false
            ? 'scim.user_deactivated'
            : values['active'] === true
              ? 'scim.user_reactivated'
              : 'scim.user_updated',
        summary:
          `${String(before['login'])} ${values['active'] === false ? 'deactivated' : values['active'] === true ? 'reactivated' : `updated (${Object.keys(values).join(', ')})`} by the directory (${who.name}).`.slice(
            0,
            300,
          ),
        targetModel: 'res.users',
        targetId: id,
        ip: request.ip,
      });
  };

  // ---- groups and the roles they give

  const syncRoles = async (
    env: Env,
    request: FastifyRequest,
    who: { name: string },
    users: readonly number[],
  ) => {
    for (const user of await syncScimRoles(env, users, {
      by: `the directory (${who.name})`,
      ip: request.ip,
    }))
      auth.forget(user);
  };
  const groupOf = async (env: Env, id: number): Promise<Row> => {
    const [row] = await rows(model(env, 'auth.scim_group').search({ where: { id } }), [
      'displayName',
      'externalId',
      'createdAt',
      'updatedAt',
    ]);
    if (row === undefined) throw missing(`Group ${id}`);
    return row;
  };
  const membersOf = async (env: Env, group: number): Promise<number[]> =>
    (await rows(model(env, 'auth.scim_member').search({ where: { group } }), ['user'])).map((m) =>
      idOf(m['user']),
    );
  const shownGroup = async (env: Env, row: Row): Promise<Row> => {
    const members = await membersOf(env, row['id'] as number);
    const names = new Map(
      (
        await rows(model(everyone(env), 'res.users').search({ where: { id: { in: members } } }), [
          'name',
        ])
      ).map((u) => [u['id'] as number, String(u['name'])]),
    );
    return {
      schemas: [GROUP],
      id: String(row['id']),
      ...(row['externalId'] ? { externalId: String(row['externalId']) } : {}),
      displayName: String(row['displayName']),
      members: members.map((m) => ({
        value: String(m),
        display: names.get(m) ?? '',
        $ref: `${base}/Users/${m}`,
      })),
      meta: {
        resourceType: 'Group',
        location: `${base}/Groups/${row['id']}`,
        ...(iso(row['createdAt']) === undefined ? {} : { created: iso(row['createdAt']) }),
        ...(iso(row['updatedAt']) === undefined ? {} : { lastModified: iso(row['updatedAt']) }),
      },
    };
  };
  /** Sets, adds to or removes from a group's members; returns everyone whose membership changed. */
  const changeMembers = async (
    env: Env,
    group: number,
    change: { set?: number[]; add?: number[]; remove?: number[] },
  ): Promise<number[]> => {
    const now = new Set(await membersOf(env, group));
    const wanted = new Set(change.set ?? now);
    for (const m of change.add ?? []) wanted.add(m);
    for (const m of change.remove ?? []) wanted.delete(m);
    const added = [...wanted].filter((m) => !now.has(m));
    const removed = [...now].filter((m) => !wanted.has(m));
    if (added.length > 0) {
      // Only people the directory manages; an id that is nobody's is refused.
      const outside = await outsiders(env);
      const real = await model(everyone(env), 'res.users').search({ where: { id: { in: added } } });
      const known = new Set(real.ids.filter((id) => !outside.has(id)));
      const unknown = added.find((m) => !known.has(m));
      if (unknown !== undefined) throw invalid(`There is no user ${unknown}.`);
      await model(env, 'auth.scim_member').create(added.map((user) => ({ group, user })));
    }
    if (removed.length > 0)
      await (
        await model(env, 'auth.scim_member').search({ where: { group, user: { in: removed } } })
      ).unlink();
    return [...added, ...removed];
  };

  // ---- the routes, in a scope of their own: SCIM's media type, its token, its errors

  void app.register(async (scim) => {
    scim.addContentTypeParser(SCIM_JSON, { parseAs: 'string' }, (_request, body, done) => {
      try {
        done(null, body === '' ? {} : JSON.parse(String(body)));
      } catch {
        done(invalid('The body is not JSON.', 'invalidSyntax'), undefined);
      }
    });
    const send = (reply: FastifyReply, status: number, body?: unknown) =>
      body === undefined
        ? reply.code(status).send()
        : reply.code(status).header('content-type', SCIM_JSON).send(JSON.stringify(body));
    scim.setErrorHandler((error, _request, reply) => {
      const known = error instanceof ScimError;
      const problem = known ? null : problemOf(error);
      const status = known ? error.status : (problem?.status ?? 500);
      if (status >= 500) scim.log.error({ err: error }, 'scim');
      return send(reply, status, {
        schemas: [ERROR],
        status: String(status),
        detail: known
          ? error.message
          : status >= 500
            ? 'The server failed.'
            : (problem?.detail ?? ''),
        ...(known && error.scimType !== undefined
          ? { scimType: error.scimType }
          : status === 409
            ? { scimType: 'uniqueness' }
            : {}),
      });
    });
    const route = { config: { auth: false } };
    const idIn = (request: FastifyRequest, what: string): number => {
      const id = Number((request.params as { id?: unknown }).id);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw missing(`${what} ${String((request.params as Row)['id'])}`);
      return id;
    };
    const paging = (request: FastifyRequest) => {
      const query = request.query as { startIndex?: unknown; count?: unknown };
      const start = Math.max(1, Number(query.startIndex ?? 1) || 1);
      const count = Math.min(200, Math.max(0, Number(query.count ?? 100) || 0));
      return { start, count };
    };
    /** In the directory's company, as the system: every write audited with the directory's name. */
    const acting = async <T>(
      request: FastifyRequest,
      reason: string,
      fn: (env: Env, who: { company: number; name: string }) => Promise<T>,
    ): Promise<T> => {
      const who = await directory(request);
      return shutro().bootstrap({ reason: `scim ${reason}`, company: who.company }, async (env) => {
        const out = await fn(env, who);
        await env.flush();
        return out;
      });
    };

    scim.get('/api/scim/v2/ServiceProviderConfig', route, async (request, reply) => {
      await directory(request);
      return send(reply, 200, {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [
          {
            type: 'oauthbearertoken',
            name: 'Bearer token',
            description: 'A token made in Settings › Security.',
          },
        ],
      });
    });
    scim.get('/api/scim/v2/ResourceTypes', route, async (request, reply) => {
      await directory(request);
      return send(reply, 200, {
        schemas: [LIST],
        totalResults: 2,
        Resources: [
          {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
            id: 'User',
            name: 'User',
            endpoint: '/Users',
            schema: USER,
          },
          {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
            id: 'Group',
            name: 'Group',
            endpoint: '/Groups',
            schema: GROUP,
          },
        ],
      });
    });
    scim.get('/api/scim/v2/Schemas', route, async (request, reply) => {
      await directory(request);
      return send(reply, 200, {
        schemas: [LIST],
        totalResults: 2,
        Resources: [
          {
            id: USER,
            name: 'User',
            attributes: ['userName', 'displayName', 'name', 'emails', 'active', 'externalId'].map(
              (name) => ({ name }),
            ),
          },
          {
            id: GROUP,
            name: 'Group',
            attributes: ['displayName', 'members', 'externalId'].map((name) => ({ name })),
          },
        ],
      });
    });

    scim.get('/api/scim/v2/Users', route, async (request, reply) =>
      send(
        reply,
        200,
        await acting(request, 'users', async (env) => {
          const filter = filterOf((request.query as Row)['filter'], {
            username: 'login',
            externalid: 'externalId',
          });
          const { start, count } = paging(request);
          let where: Row = { isService: { ne: true } };
          if (filter?.field === 'login') where = { ...where, login: filter.value.toLowerCase() };
          if (filter?.field === 'externalId') {
            const links = await rows(
              model(env, 'auth.scim_user').search({ where: { externalId: filter.value } }),
              ['user'],
            );
            where = { ...where, id: { in: links.map((l) => idOf(l['user'])) } };
          }
          const outside = await outsiders(env);
          const all = (
            await rows(
              model(everyone(env), 'res.users').search({ where, order: ['id asc'], limit: 5000 }),
              USER_KEYS,
            )
          ).filter((u) => !outside.has(u['id'] as number));
          const page = all.slice(start - 1, start - 1 + count);
          return {
            schemas: [LIST],
            totalResults: all.length,
            startIndex: start,
            itemsPerPage: page.length,
            Resources: await Promise.all(page.map((u) => shownUser(env, u))),
          };
        }),
      ),
    );
    scim.get('/api/scim/v2/Users/:id', route, async (request, reply) =>
      send(
        reply,
        200,
        await acting(request, 'user', async (env) =>
          shownUser(env, await personOf(env, idIn(request, 'User'))),
        ),
      ),
    );
    scim.post('/api/scim/v2/Users', route, async (request, reply) => {
      const person = personIn((request.body ?? {}) as Row);
      const login = person.login;
      if (login === undefined || login.length > 320) throw invalid('userName is needed.');
      const made = await acting(request, 'user created', async (env, who) => {
        const taken = await model(everyone(env), 'res.users').search({
          where: { login },
          limit: 1,
        });
        if (taken.length > 0)
          throw new ScimError(409, `Someone has the login ${login} already.`, 'uniqueness');
        const created = await model(env, 'res.users').create([
          {
            login,
            name: person.name ?? login,
            email: person.email ?? (login.includes('@') ? login : null),
            company: who.company,
            companies: { set: [who.company] },
            active: person.active !== false,
          },
        ]);
        const user = created.ids[0] as number;
        // One of the company's people: the role every internal person holds.
        await model(env, 'auth.user_group').create([{ user, company: null, group: 'base.user' }]);
        await model(env, 'auth.scim_user').create([
          { user, externalId: person.externalId ?? null },
        ]);
        await audit(env, {
          kind: 'scim.user_created',
          summary: `${person.name ?? login} (${login}) added by the directory (${who.name}).`.slice(
            0,
            300,
          ),
          targetModel: 'res.users',
          targetId: user,
          ip: request.ip,
        });
        return shownUser(env, await personOf(env, user));
      });
      return send(reply.header('location', String((made['meta'] as Row)['location'])), 201, made);
    });
    for (const method of ['put', 'patch'] as const)
      scim[method]('/api/scim/v2/Users/:id', route, async (request, reply) => {
        const id = idIn(request, 'User');
        const body = (request.body ?? {}) as Row;
        const change = method === 'put' ? personIn(body) : personPatch(body);
        const shown = await acting(request, 'user updated', async (env, who) => {
          await changePerson(env, request, who, id, change);
          return shownUser(env, await personOf(env, id));
        });
        if (change.active !== undefined) auth.forget(id);
        return send(reply, 200, shown);
      });
    scim.delete('/api/scim/v2/Users/:id', route, async (request, reply) => {
      const id = idIn(request, 'User');
      // Never deleted: deactivated, so their records and the audit log keep their author.
      await acting(request, 'user deactivated', (env, who) =>
        changePerson(env, request, who, id, { active: false }),
      );
      auth.forget(id);
      return send(reply, 204);
    });

    scim.get('/api/scim/v2/Groups', route, async (request, reply) =>
      send(
        reply,
        200,
        await acting(request, 'groups', async (env) => {
          const filter = filterOf((request.query as Row)['filter'], {
            displayname: 'displayName',
            externalid: 'externalId',
          });
          const { start, count } = paging(request);
          const all = await rows(
            model(env, 'auth.scim_group').search({
              where: filter === null ? {} : { [filter.field]: filter.value },
              order: ['id asc'],
            }),
            ['displayName', 'externalId', 'createdAt', 'updatedAt'],
          );
          const page = all.slice(start - 1, start - 1 + count);
          return {
            schemas: [LIST],
            totalResults: all.length,
            startIndex: start,
            itemsPerPage: page.length,
            Resources: await Promise.all(page.map((g) => shownGroup(env, g))),
          };
        }),
      ),
    );
    scim.get('/api/scim/v2/Groups/:id', route, async (request, reply) =>
      send(
        reply,
        200,
        await acting(request, 'group', async (env) =>
          shownGroup(env, await groupOf(env, idIn(request, 'Group'))),
        ),
      ),
    );
    scim.post('/api/scim/v2/Groups', route, async (request, reply) => {
      const body = (request.body ?? {}) as Row;
      const displayName = text(body['displayName']);
      if (displayName === undefined) throw invalid('displayName is needed.');
      const made = await acting(request, 'group created', async (env, who) => {
        const taken = await model(env, 'auth.scim_group').search({
          where: { displayName },
          limit: 1,
        });
        if (taken.length > 0)
          throw new ScimError(409, `A group is named ${displayName} already.`, 'uniqueness');
        const created = await model(env, 'auth.scim_group').create([
          { displayName, externalId: text(body['externalId']) ?? null, roles: [] },
        ]);
        const id = created.ids[0] as number;
        const changed = await changeMembers(env, id, { set: membersIn(body['members']) });
        await audit(env, {
          kind: 'scim.group_created',
          summary:
            `Group ${displayName} added by the directory (${who.name}): it gives no role until an Administrator sets them.`.slice(
              0,
              300,
            ),
          ip: request.ip,
        });
        await syncRoles(env, request, who, changed);
        return shownGroup(env, await groupOf(env, id));
      });
      return send(reply.header('location', String((made['meta'] as Row)['location'])), 201, made);
    });
    scim.put('/api/scim/v2/Groups/:id', route, async (request, reply) => {
      const id = idIn(request, 'Group');
      const body = (request.body ?? {}) as Row;
      return send(
        reply,
        200,
        await acting(request, 'group updated', async (env, who) => {
          await groupOf(env, id);
          const displayName = text(body['displayName']);
          const set = await model(env, 'auth.scim_group').search({ where: { id } });
          if (displayName !== undefined) await set.write({ displayName });
          await syncRoles(
            env,
            request,
            who,
            await changeMembers(env, id, { set: membersIn(body['members']) }),
          );
          return shownGroup(env, await groupOf(env, id));
        }),
      );
    });
    scim.patch('/api/scim/v2/Groups/:id', route, async (request, reply) => {
      const id = idIn(request, 'Group');
      const operations = Array.isArray(((request.body ?? {}) as Row)['Operations'])
        ? (((request.body ?? {}) as Row)['Operations'] as Row[])
        : [];
      return send(
        reply,
        200,
        await acting(request, 'group updated', async (env, who) => {
          await groupOf(env, id);
          const touched: number[] = [];
          for (const op of operations) {
            const kind = String(op['op'] ?? '').toLowerCase();
            const path = String(op['path'] ?? '');
            const value = op['value'];
            // `members[value eq "12"]`: one member named in the path.
            const named = /^members\[\s*value\s+eq\s+"(\d+)"\s*\]$/i.exec(path)?.[1];
            if (/^members/i.test(path)) {
              const ids = named === undefined ? membersIn(value) : [Number(named)];
              if (kind === 'add') touched.push(...(await changeMembers(env, id, { add: ids })));
              else if (kind === 'remove')
                touched.push(
                  ...(await changeMembers(
                    env,
                    id,
                    ids.length === 0 && named === undefined ? { set: [] } : { remove: ids },
                  )),
                );
              else if (kind === 'replace')
                touched.push(...(await changeMembers(env, id, { set: ids })));
            } else if (kind === 'replace' || kind === 'add') {
              const fields = path === '' ? ((value ?? {}) as Row) : { [path]: value };
              const displayName = text(fields['displayName']);
              if (displayName !== undefined)
                await (await model(env, 'auth.scim_group').search({ where: { id } })).write({
                  displayName,
                });
              if (path === '' && fields['members'] !== undefined)
                touched.push(
                  ...(await changeMembers(env, id, { add: membersIn(fields['members']) })),
                );
            }
          }
          await syncRoles(env, request, who, touched);
          return shownGroup(env, await groupOf(env, id));
        }),
      );
    });
    scim.delete('/api/scim/v2/Groups/:id', route, async (request, reply) => {
      const id = idIn(request, 'Group');
      await acting(request, 'group removed', async (env, who) => {
        const row = await groupOf(env, id);
        const members = await membersOf(env, id);
        await changeMembers(env, id, { set: [] });
        // Its roles stay managed until the group is gone: taken from its members first.
        await syncRoles(env, request, who, members);
        await (await model(env, 'auth.scim_group').search({ where: { id } })).unlink();
        await audit(env, {
          kind: 'scim.group_removed',
          summary:
            `Group ${String(row['displayName'])} removed by the directory (${who.name}).`.slice(
              0,
              300,
            ),
          ip: request.ip,
        });
      });
      return send(reply, 204);
    });
  });
}

/**
 * Brings people's roles in line with the directory's groups: each holds exactly the roles their groups give, among
 * the roles any group gives (plus `released`: roles a group gave until now). Never an Administrator's role. Each
 * change is in the audit log. Returns the people whose roles changed (their cached rights are to be forgotten).
 */
export async function syncScimRoles(
  env: Env,
  users: readonly number[] | 'all',
  options: { readonly by: string; readonly ip?: string; readonly released?: readonly string[] },
): Promise<number[]> {
  const groups = await rows(model(env, 'auth.scim_group').search({ where: {} }), ['roles']);
  const admins = new Set(env.access.administratorGroups());
  const rolesOf = (g: Row): string[] =>
    (Array.isArray(g['roles']) ? (g['roles'] as string[]) : []).filter((r) => !admins.has(r));
  const managed = new Set([
    ...groups.flatMap(rolesOf),
    ...(options.released ?? []).filter((r) => !admins.has(r)),
  ]);
  if (managed.size === 0) return [];
  const people =
    users === 'all'
      ? (await rows(model(env, 'auth.scim_member').search({ where: {} }), ['user'])).map((m) =>
          idOf(m['user']),
        )
      : users;
  const changed: number[] = [];
  for (const user of new Set(people)) {
    const memberships = await rows(model(env, 'auth.scim_member').search({ where: { user } }), [
      'group',
    ]);
    const mine = new Set(memberships.map((m) => idOf(m['group'])));
    const target = new Set(groups.filter((g) => mine.has(g['id'] as number)).flatMap(rolesOf));
    const held = await rows(
      model(env, 'auth.user_group').search({
        where: { user, company: null, group: { in: [...managed] } },
      }),
      ['group'],
    );
    const has = new Set(held.map((h) => String(h['group'])));
    const added = [...target].filter((r) => !has.has(r)).sort();
    const removed = held.filter((h) => !target.has(String(h['group'])));
    if (added.length > 0)
      await model(env, 'auth.user_group').create(
        added.map((group) => ({ user, company: null, group })),
      );
    if (removed.length > 0)
      await (
        await model(env, 'auth.user_group').search({
          where: { id: { in: removed.map((h) => h['id'] as number) } },
        })
      ).unlink();
    if (added.length === 0 && removed.length === 0) continue;
    await audit(env, {
      kind: 'scim.roles',
      summary: `Roles of person ${user} from ${options.by}: ${[
        added.length > 0 ? `given ${added.join(', ')}` : null,
        removed.length > 0
          ? `taken ${removed
              .map((h) => String(h['group']))
              .sort()
              .join(', ')}`
          : null,
      ]
        .filter((x) => x !== null)
        .join('; ')}.`,
      targetModel: 'res.users',
      targetId: user,
      ...(options.ip === undefined ? {} : { ip: options.ip }),
    });
    changed.push(user);
  }
  return changed;
}
