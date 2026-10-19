/**
 * Apps, menus and actions per user (RFC 0003 §5.1 "visibility"): installing a module shows nothing; a user sees an
 * app, menu or action only with an access level of its module, or a group / permission it names in `visibleTo`, and
 * an action on a model only with read access to it. Administrators see everything. The server filters the tree and
 * refuses actions it would not show: the UI hiding is a convenience, never the control.
 *
 * - `GET /api/v1/apps`          the launcher
 * - `GET /api/v1/menus`         the menu tree (optionally `?app=`)
 * - `GET /api/v1/actions/:id`   one action, 403 when not visible
 */
import type { KoshModule, LoadedModules, MenuSpec } from '@isahaq/kosh-modules-sdk';
import type { FastifyInstance } from 'fastify';
import { HttpProblem } from '../errors.js';
import type { Env } from '../orm.js';

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

  constructor(loaded: LoadedModules) {
    this.#loaded = loaded;
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
  apps(env: Env): { code: string; label: string; icon?: string; sequence: number }[] {
    return this.#loaded.modules
      .filter((m) => m.app !== undefined && moduleVisible(env, m))
      .map((m) => {
        const app = m.app as NonNullable<KoshModule['app']>;
        return {
          code: app.code,
          label: app.label,
          ...(app.icon === undefined ? {} : { icon: app.icon }),
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
