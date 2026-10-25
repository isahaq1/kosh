/**
 * Apps, menus and actions per user (RFC 0003 §5.1 "visibility"): installing a module shows nothing; a user sees an
 * app, menu or action only with an access level of its module, or a group / permission it names in `visibleTo`, and
 * an action on a model only with read access to it. Administrators see everything. The server filters the tree and
 * refuses actions it would not show: the UI hiding is a convenience, never the control.
 *
 * - `GET /api/v1/apps`          the launcher
 * - `GET /api/v1/menus`         the menu tree (optionally `?app=`)
 * - `GET /api/v1/actions/:id`   one action, 403 when not visible
 * - `GET /api/v1/find?q=`        records whose name matches, across the models the user can open from a visible
 *                                menu (the command palette): each with the action and app that open it
 */
import type { KoshModule, LoadedModules, MenuSpec } from '@kosh/modules-sdk';
import type { FastifyInstance } from 'fastify';
import { HttpProblem } from '../errors.js';
import type { Env } from '../orm.js';
import type { ApiModel } from './metadata.js';

/** One record the global search found. */
export interface FoundRecord {
  readonly model: string;
  /** The model's label (`Sales order`). */
  readonly modelLabel: string;
  readonly id: number;
  readonly displayName: string;
  /** The action and app that open it. */
  readonly action: string;
  readonly app: string | undefined;
}

/** A visible menu entry with its visible children. */
export interface MenuNode {
  readonly id: string;
  readonly label: string;
  readonly app?: string;
  readonly action?: string;
  readonly sequence: number;
  readonly children: MenuNode[];
}

function holds(env: Env, code: string): boolean {
  if (env.groups.has(code)) return true;
  try {
    return env.access.has(code); // a feature permission (by role, grant or administrator)
  } catch {
    return false; // not a declared permission: a group the user does not hold
  }
}

/** The groups of a module's access levels. */
function levelGroups(module: KoshModule): string[] {
  return Object.values(module.accessLevels).flatMap((level) => [...level.groups]);
}

/** True when the user holds an access level of the module (or is an administrator). */
export function moduleVisible(env: Env, module: KoshModule): boolean {
  return env.administrator || levelGroups(module).some((g) => env.groups.has(g));
}

function actionModel(spec: unknown): string | undefined {
  const model = (spec as { model?: unknown } | null)?.model;
  return typeof model === 'string' ? model : undefined;
}

function visibleTo(spec: unknown): readonly string[] | undefined {
  const codes = (spec as { visibleTo?: unknown } | null)?.visibleTo;
  return Array.isArray(codes) ? (codes as string[]) : undefined;
}

/** Navigation for a loaded module set. */
export class Navigation {
  readonly #loaded: LoadedModules;
  readonly #models: ReadonlyMap<string, ApiModel>;

  constructor(loaded: LoadedModules, models: ReadonlyMap<string, ApiModel> = new Map()) {
    this.#loaded = loaded;
    this.#models = models;
  }

  /**
   * Records named like `text` in every model the user can open from a visible menu (one action per model: the
   * first menu's), at most `limit` per model, within ACL and record rules (the user's own search).
   */
  /**
   * For each model the user can open in a form from a visible menu: the first such menu's action and app. What
   * the global search, and "open this record" links from elsewhere (approvals, activities), route to.
   */
  routes(env: Env): ReadonlyMap<string, { action: string; app: string | undefined }> {
    const targets = new Map<string, { action: string; app: string | undefined }>();
    for (const menu of this.#loaded.menus) {
      if (menu.action === undefined || !this.menuVisible(env, menu)) continue;
      const owner = this.#loaded.actions.get(menu.action);
      const spec = owner === undefined ? undefined : this.#module(owner).actions?.[menu.action];
      const model = actionModel(spec);
      // Only actions that open records in a form: a found record must open where it is found.
      const views = (spec as { views?: unknown } | undefined)?.views;
      if (!Array.isArray(views) || !views.includes('form')) continue;
      if (model === undefined || targets.has(model) || !this.#models.has(model)) continue;
      targets.set(model, { action: menu.action, app: this.#appOf(menu) });
    }
    return targets;
  }

  async find(env: Env, text: string, limit: number): Promise<FoundRecord[]> {
    const targets = this.routes(env);
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const out: FoundRecord[] = [];
    for (const [model, target] of targets) {
      const meta = this.#models.get(model);
      if (meta?.recName === null || meta === undefined) continue;
      const set = await (
        env.model(model as never) as unknown as {
          search(q: unknown): Promise<{
            length: number;
            load(
              k: string[],
            ): Promise<{ read(k: string[]): { id: number; displayName: string }[] }>;
          }>;
        }
      ).search({ where: { [meta.recName]: { ilike: like } }, limit });
      if (set.length === 0) continue;
      for (const row of (await set.load(['displayName'])).read(['id', 'displayName']))
        out.push({
          model,
          modelLabel: meta.label,
          id: row.id,
          displayName: row.displayName,
          action: target.action,
          app: target.app,
        });
    }
    return out;
  }

  #module(name: string): KoshModule {
    return this.#loaded.byName.get(name) as KoshModule;
  }

  /** The action spec, when the user may open it. */
  actionVisible(env: Env, id: string): boolean {
    const owner = this.#loaded.actions.get(id);
    if (owner === undefined) return false;
    if (env.administrator) return true;
    const module = this.#module(owner);
    const spec = module.actions?.[id];
    const codes = visibleTo(spec);
    if (codes !== undefined ? !codes.some((c) => holds(env, c)) : !moduleVisible(env, module))
      return false;
    const model = actionModel(spec);
    if (model === undefined) return true;
    try {
      return env.access.can(model as never, 'read');
    } catch {
      return false; // a model that is not installed
    }
  }

  menuVisible(env: Env, menu: MenuSpec & { readonly module: string }): boolean {
    if (env.administrator) return true;
    const own =
      menu.visibleTo !== undefined
        ? menu.visibleTo.some((c) => holds(env, c))
        : moduleVisible(env, this.#module(menu.module));
    return own && (menu.action === undefined || this.actionVisible(env, menu.action));
  }

  /** The visible tree: hidden parents hide their children; entries without an action and visible children go. */
  menus(env: Env, app?: string): MenuNode[] {
    const all = this.#loaded.menus.filter((m) => app === undefined || this.#appOf(m) === app);
    const byParent = new Map<string | undefined, (MenuSpec & { module: string })[]>();
    for (const m of all) {
      const parent =
        m.parent !== undefined && all.some((p) => p.id === m.parent) ? m.parent : undefined;
      byParent.set(parent, [...(byParent.get(parent) ?? []), m]);
    }
    const build = (parent: string | undefined): MenuNode[] =>
      (byParent.get(parent) ?? [])
        .filter((m) => this.menuVisible(env, m))
        .map((m) => ({
          id: m.id,
          label: m.label,
          ...(this.#appOf(m) === undefined ? {} : { app: this.#appOf(m) as string }),
          ...(m.action === undefined ? {} : { action: m.action }),
          sequence: m.sequence ?? 10,
          children: build(m.id),
        }))
        .filter((m) => m.action !== undefined || m.children.length > 0)
        .sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label));
    return build(undefined);
  }

  #appOf(menu: MenuSpec & { readonly module: string }): string | undefined {
    if (menu.app !== undefined) return menu.app;
    const parent = this.#loaded.menus.find((m) => m.id === menu.parent);
    return parent === undefined ? this.#module(menu.module).app?.code : this.#appOf(parent);
  }

  /** The launcher: apps of modules the user has an access level of. */
  apps(env: Env): {
    code: string;
    label: string;
    icon?: string;
    category?: string;
    summary?: string;
    sequence: number;
  }[] {
    return this.#loaded.modules
      .filter((m) => m.app !== undefined && moduleVisible(env, m))
      .map((m) => {
        const app = m.app as NonNullable<KoshModule['app']>;
        return {
          code: app.code,
          label: app.label,
          ...(app.icon === undefined ? {} : { icon: app.icon }),
          ...(app.category === undefined ? {} : { category: app.category }),
          ...(app.summary === undefined ? {} : { summary: app.summary }),
          sequence: app.sequence ?? 10,
        };
      })
      .sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label));
  }

  /** Registers the routes. */
  register(app: FastifyInstance): void {
    app.get('/api/v1/apps', async (request) =>
      request.env(async (env) => ({ apps: this.apps(env) })),
    );
    app.get('/api/v1/menus', async (request) => {
      const q = (request.query ?? {}) as { app?: unknown };
      const only = typeof q.app === 'string' && q.app !== '' ? q.app : undefined;
      return request.env(async (env) => ({ menus: this.menus(env, only) }));
    });
    app.get('/api/v1/find', async (request) => {
      const q = (request.query ?? {}) as { q?: unknown; limit?: unknown };
      const text = typeof q.q === 'string' ? q.q.trim() : '';
      if (text === '' || text.length > 200)
        throw new HttpProblem(400, 'invalid-query', 'Invalid search', 'q is 1–200 characters.');
      const limit = q.limit === undefined ? 5 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20)
        throw new HttpProblem(400, 'invalid-limit', 'Invalid limit', 'limit must be 1–20.');
      return request.env(async (env) => ({ results: await this.find(env, text, limit) }));
    });
    // Where records of each model open for this user (`{ 'sale.order': { action, app } }`).
    app.get('/api/v1/routes', async (request) =>
      request.env(async (env) => ({ routes: Object.fromEntries(this.routes(env)) })),
    );
    app.get('/api/v1/actions/:id', async (request) => {
      const id = String((request.params as { id?: unknown }).id ?? '');
      const owner = this.#loaded.actions.get(id);
      if (owner === undefined)
        throw new HttpProblem(404, 'unknown-action', 'Unknown action', `No action '${id}'.`);
      return request.env(async (env) => {
        if (!this.actionVisible(env, id))
          throw new HttpProblem(
            403,
            'access',
            'Forbidden',
            `The action '${id}' is not available to this user.`,
            'Ask an administrator for a role of its app.',
          );
        return { id, module: owner, spec: this.#module(owner).actions?.[id] ?? null };
      });
    });
  }
}
