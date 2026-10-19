/**
 * The App manager's API (RFC 0008 §5.5), for Administrators and holders of `settings.apps`, checked on every call:
 *
 * - `GET  /api/v1/settings/apps`        the catalogue: each app's state, what it needs, whether it can be disabled
 * - `POST /api/v1/settings/apps/plan`   `{ install?, enable?, disable? }` → the plan and its `planId` (changes nothing)
 * - `POST /api/v1/settings/apps/apply`  `{ change, planId }` → applied in one transaction, then served by every server
 *
 * `apply` re-plans and refuses (409) when the plan is no longer the one reviewed, so a stale or replayed request
 * changes nothing. The change, its SQL and its author go to `kosh_app_log` and the audit log, in its transaction.
 */
import { createHash } from 'node:crypto';
import { type AppChange, AppPlanError, catalogueOf } from '@kosh/modules-sdk';
import {
  type AppsContext,
  applyApps,
  HttpProblem,
  installedApps,
  type ModuleContext,
  type PreparedApps,
  prepareApps,
  readInstalledApps,
} from '@kosh/server';
import type { FastifyRequest } from 'fastify';

/** Modules that are never disabled: every installation needs them. */
export const PROTECTED_APPS: readonly string[] = ['base', 'settings'];

/** One app of the catalogue, as the App manager shows it. */
export interface AppInfo {
  readonly name: string;
  readonly version: string;
  readonly label: string;
  readonly icon: string | null;
  readonly category: string;
  readonly summary: string | null;
  readonly state: 'installed' | 'disabled' | 'available';
  /** Installed because another app needs it. */
  readonly dependency: boolean;
  /** Modules it needs. */
  readonly depends: readonly string[];
  /** It shows in the launcher (has an app), rather than being a technical module. */
  readonly application: boolean;
  readonly protected: boolean;
}

/** A plan, as the App manager shows it. */
export interface PlanInfo {
  readonly planId: string;
  readonly install: readonly { readonly name: string; readonly reason: string }[];
  readonly enable: readonly string[];
  readonly disable: readonly { readonly name: string; readonly cascade: boolean }[];
  readonly unchanged: readonly string[];
  readonly statements: readonly string[];
  readonly empty: boolean;
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

function changeOf(body: unknown): AppChange {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: { install?: string[]; enable?: string[]; disable?: string[] } = {};
  for (const key of ['install', 'enable', 'disable'] as const) {
    const value = b[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      value.some((v) => typeof v !== 'string' || !NAME.test(v))
    )
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid request',
        `${key} must be an array of module names.`,
      );
    out[key] = [...new Set(value as string[])].sort();
  }
  if ((out.install?.length ?? 0) + (out.enable?.length ?? 0) + (out.disable?.length ?? 0) === 0)
    throw new HttpProblem(
      400,
      'invalid-body',
      'Invalid request',
      'Name at least one app to install, enable or disable.',
    );
  return out;
}

/** Stable for the same change against the same installed set and schema. */
function planIdOf(change: AppChange, prepared: PreparedApps): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        change,
        current: [...prepared.current].sort((a, b) => a.name.localeCompare(b.name)),
        statements: prepared.migration.statements.map((s) => s.sql),
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

function planInfo(change: AppChange, prepared: PreparedApps): PlanInfo {
  const { plan } = prepared;
  return {
    planId: planIdOf(change, prepared),
    install: plan.install,
    enable: plan.enable,
    disable: plan.disable,
    unchanged: plan.unchanged,
    statements: prepared.migration.statements.map((s) => s.sql),
    empty: prepared.empty,
  };
}

/** Registers the App manager's routes. */
export function registerAppRoutes(context: ModuleContext): void {
  const { app, driver } = context;

  const appsOf = (): AppsContext => {
    if (context.apps === undefined)
      throw new HttpProblem(
        503,
        'app-manager-unavailable',
        'App manager unavailable',
        'This server does not run in an app host, so it cannot change the installed apps.',
        'Start the server with createAppHost (the starter project does), or use npx kosh apps.',
      );
    return context.apps;
  };
  /** Administrators and App managers only; returns the caller's user id. */
  const guard = async (request: FastifyRequest): Promise<number> =>
    request.env(async (env) => {
      if (!env.administrator && !env.groups.has('settings.apps'))
        throw new HttpProblem(
          403,
          'access',
          'App managers only',
          'Installing and disabling apps needs the Administrator role or the Settings / App manager access.',
        );
      return env.uid;
    });
  const refused = (error: unknown): never => {
    if (error instanceof AppPlanError)
      throw new HttpProblem(409, 'app-change-refused', 'App change refused', error.message);
    throw error;
  };

  app.get('/api/v1/settings/apps', async (request) => {
    await guard(request);
    const { catalogue } = appsOf();
    const rows = await installedApps(driver, catalogue);
    const legacy = (await readInstalledApps(driver)) === null;
    const state = new Map(rows.map((r) => [r.name, r]));
    const apps: AppInfo[] = [...catalogueOf(catalogue).values()]
      .map(
        (m): AppInfo => ({
          name: m.name,
          version: m.version,
          label: m.app?.label ?? m.name,
          icon: m.app?.icon ?? null,
          category: m.app?.category ?? (m.app === undefined ? 'Technical' : 'Other'),
          summary: m.app?.summary ?? null,
          state: state.get(m.name)?.state ?? 'available',
          dependency: state.get(m.name)?.reason === 'dependency',
          depends: m.depends.map((d) => d.name),
          application: m.app !== undefined,
          protected: PROTECTED_APPS.includes(m.name),
        }),
      )
      .sort((a, b) => a.label.localeCompare(b.label));
    return { apps, legacy };
  });

  app.post('/api/v1/settings/apps/plan', async (request) => {
    await guard(request);
    const change = changeOf(request.body);
    const { catalogue, migrationsDir } = appsOf();
    const prepared = await prepareApps({
      driver,
      catalogue,
      change,
      dir: migrationsDir,
      protect: PROTECTED_APPS,
    }).catch(refused);
    return planInfo(change, prepared);
  });

  app.post('/api/v1/settings/apps/apply', async (request) => {
    const uid = await guard(request);
    const body = (request.body ?? {}) as { change?: unknown; planId?: unknown };
    const change = changeOf(body.change);
    if (typeof body.planId !== 'string')
      throw new HttpProblem(
        400,
        'invalid-body',
        'Invalid request',
        'planId (from /plan) is required.',
      );
    const apps = appsOf();
    const prepared = await prepareApps({
      driver,
      catalogue: apps.catalogue,
      change,
      dir: apps.migrationsDir,
      protect: PROTECTED_APPS,
    }).catch(refused);
    if (planIdOf(change, prepared) !== body.planId)
      throw new HttpProblem(
        409,
        'plan-changed',
        'The plan changed',
        'The installed apps or the schema changed since this plan was made.',
        'Review the new plan, then apply it.',
      );
    if (prepared.empty) return { installed: [], enabled: [], disabled: [], migration: null };
    const result = await applyApps(prepared, {
      driver,
      dir: apps.migrationsDir,
      actor: `user:${uid}`,
      audit: { actor: uid, ip: request.ip },
    }).catch(refused);
    // This server switches to the new set now (others on NOTIFY); this request finishes on the current one.
    await apps.reload();
    return {
      installed: result.installed,
      enabled: result.enabled,
      disabled: result.disabled,
      migration:
        result.migration === null
          ? null
          : `${result.migration.version}_${result.migration.name}.sql`,
    };
  });
}
