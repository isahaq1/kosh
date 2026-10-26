/**
 * The Studio API (RFC 0012 §5.3, step 3), for Administrators and holders of `studio.manager`, checked on every call:
 *
 * - `GET  /api/v1/studio`                 the mode and the Studio modules of the project
 * - `GET  /api/v1/studio/modules/:name`   a module's spec and files
 * - `POST /api/v1/studio/preview`         `{ spec }` → the review: the spec as it will be applied (its version
 *                                         bumped when installed), the diff of the module's files, the migration's
 *                                         SQL and a `planId`; changes nothing
 * - `POST /api/v1/studio/apply`           `{ spec, planId }` (write mode): installs or upgrades the module through
 *                                         the App manager, in one transaction, then writes its files and serves it
 * - `POST /api/v1/studio/propose`         `{ spec }` → the change as a patch (`git apply`); writes nothing
 *
 * Write mode (`KOSH_STUDIO=write`) is for development and single-server installations: it writes code into the
 * project. Propose mode (the default) is for production: the change reaches it through review, CI and deploy.
 * The generated module is loaded for planning from a temporary folder of the project, removed at once.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AppChange,
  AppPlanError,
  compareVersions,
  defineModule,
  type KoshModule,
} from '@kosh/modules-sdk';
import {
  type AppsContext,
  applyApps,
  base,
  baseShutro,
  HttpProblem,
  installedApps,
  type ModuleContext,
  type PreparedApps,
  prepareApps,
  publicApiModels,
  ViewRegistry,
} from '@kosh/server';
import { orm } from '@kosh/server/orm';
import type { FastifyRequest } from 'fastify';
import { readSpec, studioModules } from './build.js';
import { unifiedDiff } from './diff.js';
import { type GenerateOptions, generateModule } from './generate.js';
import { camel, type StudioSpec, validateSpec } from './spec.js';

export type StudioMode = 'write' | 'propose';

export interface StudioOptions {
  /** Default: `KOSH_STUDIO` (`write` or `propose`), else `propose`. */
  readonly mode?: StudioMode;
  /** The project's folder (its `src/modules.ts`); default: `KOSH_STUDIO_DIR`, else the working directory. */
  readonly root?: string;
  /** How the generated modules import Kosh (default: an installation's `kosh-erp`). */
  readonly generate?: GenerateOptions;
  /** Modules Studio never replaces (default: the App manager's protected ones). */
  readonly protect?: readonly string[];
}

/** The review of a Studio change, as the API returns it. */
export interface StudioReview {
  readonly planId: string;
  /** The spec as it will be applied. */
  readonly spec: StudioSpec;
  readonly change: 'install' | 'upgrade';
  /** The installed version, when it is installed. */
  readonly from: string | null;
  /** The unified diff of every changed file, by path relative to the project. */
  readonly diff: readonly { readonly path: string; readonly diff: string }[];
  readonly statements: readonly string[];
  readonly destructive: boolean;
}

const PROTECTED = ['base', 'settings', 'studio'];
const MAX_SPEC_BYTES = 256 * 1024;

const sha = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

/** `1.4.2` → `1.4.3`. */
const nextPatch = (version: string): string => {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
};

const specText = (spec: StudioSpec): string => `${JSON.stringify(spec, null, 2)}\n`;

/** The import line and the list entry `src/modules.ts` needs for a new module (null: already listed or no list). */
function registered(text: string, name: string): string | null {
  const id = camel(name);
  const listed = /export const modules = \[([^\]]*)\];/.exec(text);
  if (listed === null) return null;
  if (text.includes(`'./modules/${name}/index.ts'`)) return null;
  const imports = [...text.matchAll(/^import .*;$/gm)];
  const last = imports.at(-1);
  const at = last === undefined ? 0 : (last.index ?? 0) + last[0].length;
  const withImport = `${text.slice(0, at)}\nimport { ${id} } from './modules/${name}/index.ts';${text.slice(at)}`;
  return withImport.replace(
    /export const modules = \[([^\]]*)\];/,
    (_m, items: string) => `export const modules = [${items.trim()}, ${id}];`,
  );
}

/** The Shutro module: the Studio group. */
export const studioShutro: ReturnType<typeof orm.defineModule> = orm.defineModule({
  name: 'studio',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [orm.defineGroup({ code: 'studio.manager', label: 'Studio', implies: ['base.user'] })],
  models: [],
});

/** Kosh Studio, configured. */
export function createStudio(options: StudioOptions = {}): KoshModule {
  return defineModule({
    shutro: studioShutro,
    kosh: '^0.1.0',
    depends: [base],
    accessLevels: { manager: { label: 'Studio', groups: ['studio.manager'] } },
    routes: (context: ModuleContext) => registerStudioRoutes(context, options),
  });
}

/** Kosh Studio, from the environment (`KOSH_STUDIO`, `KOSH_STUDIO_DIR`). */
export const studio: KoshModule = createStudio();

/** Registers the Studio API. */
export function registerStudioRoutes(context: ModuleContext, options: StudioOptions = {}): void {
  const { app, driver } = context;
  const env = process.env;
  const mode: StudioMode = options.mode ?? (env['KOSH_STUDIO'] === 'write' ? 'write' : 'propose');
  const root = resolve(options.root ?? env['KOSH_STUDIO_DIR'] ?? process.cwd());
  const protect = options.protect ?? PROTECTED;
  const generate = options.generate ?? {};
  const modulesDir = join(root, 'src', 'modules');

  const appsOf = (): AppsContext => {
    if (context.apps === undefined)
      throw new HttpProblem(
        503,
        'app-manager-unavailable',
        'App manager unavailable',
        'This server does not run in an app host, so Studio cannot plan or apply a change.',
        'Start the server with createAppHost (the starter project does).',
      );
    return context.apps;
  };
  const guard = async (request: FastifyRequest): Promise<number> =>
    request.env(async (e) => {
      if (!e.administrator && !e.groups.has('studio.manager'))
        throw new HttpProblem(
          403,
          'access',
          'Studio managers only',
          'Studio changes the schema: it needs the Administrator role or the Studio access.',
        );
      return e.uid;
    });
  const invalid = (detail: string): never => {
    throw new HttpProblem(400, 'invalid-body', 'Invalid request', detail);
  };

  /** The spec of a request body, validated (every problem in the detail). */
  const specOf = (body: unknown): StudioSpec => {
    const spec = (body as { spec?: unknown } | null)?.spec;
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec))
      return invalid('spec (a Studio specification) is required.');
    if (JSON.stringify(spec).length > MAX_SPEC_BYTES) return invalid('The spec is too large.');
    let problems: string[];
    try {
      problems = validateSpec(spec as StudioSpec);
    } catch {
      problems = ['spec: not a Studio specification (a list is not a list?)'];
    }
    if (problems.length > 0)
      throw new HttpProblem(
        400,
        'studio-spec-invalid',
        'The Studio spec is not valid',
        problems.join('\n'),
      );
    return spec as StudioSpec;
  };

  const fileOf = async (path: string): Promise<string | null> =>
    existsSync(path) ? readFile(path, 'utf8') : null;

  interface Prepared {
    readonly review: StudioReview;
    readonly files: Readonly<Record<string, string>>;
    readonly modulesTs: string | null;
    readonly module: KoshModule;
    readonly prepared: PreparedApps;
  }

  /** Plans a spec: the version, the files, the generated module loaded, the App manager's plan. */
  const prepare = async (input: StudioSpec): Promise<Prepared> => {
    const apps = appsOf();
    const name = input.name;
    const dir = join(modulesDir, name);
    const known = new Set(apps.catalogue.map((m) => m.name));
    const studioManaged = existsSync(join(dir, 'studio.json'));
    if (protect.includes(name) || (known.has(name) && !studioManaged))
      throw new HttpProblem(
        409,
        'studio-name-taken',
        'The name is taken',
        `"${name}" is a module of the installation that Studio does not manage.`,
        'Choose another name for the Studio module.',
      );
    const missing = input.depends.filter((d) => !known.has(d));
    if (missing.length > 0)
      throw new HttpProblem(
        400,
        'studio-spec-invalid',
        'The Studio spec is not valid',
        `depends: ${missing.join(', ')} not in the catalogue`,
      );
    const installed = (await installedApps(driver, apps.catalogue)).find((a) => a.name === name);
    if (installed !== undefined && installed.state !== 'installed')
      throw new HttpProblem(
        409,
        'studio-module-disabled',
        'The module is disabled',
        `"${name}" is disabled: enable it in Settings → Apps before changing it.`,
      );
    // Every apply moves an installed module forward: at least the next patch of what the database has.
    const spec: StudioSpec =
      installed !== undefined && compareVersions(input.version, installed.version) <= 0
        ? { ...input, version: nextPatch(installed.version) }
        : input;
    const files: Record<string, string> = {
      'studio.json': specText(spec),
      ...generateModule(spec, generate),
    };

    // Load the generated module from a folder as deep in the project as src/modules/<name>/ (same imports).
    const scratch = join(root, '.kosh-studio', 'plan', `${name}-${randomUUID()}`);
    let module: KoshModule;
    try {
      await mkdir(scratch, { recursive: true });
      for (const [file, content] of Object.entries(files))
        await writeFile(join(scratch, file), content, 'utf8');
      const loaded = (await import(pathToFileURL(join(scratch, 'index.ts')).href)) as Record<
        string,
        unknown
      >;
      const found = loaded[camel(name)] as KoshModule | undefined;
      if (found === undefined || found.name !== name)
        throw new Error(`the generated index.ts does not export ${camel(name)}`);
      module = found;
    } catch (error) {
      throw new HttpProblem(
        422,
        'studio-load-failed',
        'The change does not load',
        error instanceof Error ? error.message : String(error),
        'A view change names a node the view does not have, or a field targets a model that does not exist.',
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    const catalogue = [...apps.catalogue.filter((m) => m.name !== name), module];
    const change: AppChange = installed === undefined ? { install: [name] } : { upgrade: [name] };
    const prepared = await prepareApps({
      driver,
      catalogue,
      change,
      dir: apps.migrationsDir,
      protect,
    }).catch((error: unknown) => {
      if (error instanceof AppPlanError)
        throw new HttpProblem(409, 'studio-change-refused', 'Studio change refused', error.message);
      throw error;
    });

    // View changes are checked against the views as they will be served: a missing anchor is refused now.
    try {
      new ViewRegistry(prepared.runtime.loaded.modules, publicApiModels(prepared.runtime));
    } catch (error) {
      throw new HttpProblem(
        422,
        'studio-view-invalid',
        'A view change does not apply',
        error instanceof Error ? error.message : String(error),
        'Anchor the change on a node the view has (a field key or a group id).',
      );
    }

    const diff: { path: string; diff: string }[] = [];
    for (const [file, content] of Object.entries(files)) {
      const path = `src/modules/${name}/${file}`;
      const text = unifiedDiff(path, await fileOf(join(dir, file)), content);
      if (text !== '') diff.push({ path, diff: text });
    }
    const listPath = join(root, 'src', 'modules.ts');
    const list = await fileOf(listPath);
    const modulesTs = list === null ? null : registered(list, name);
    if (list !== null && modulesTs !== null)
      diff.push({ path: 'src/modules.ts', diff: unifiedDiff('src/modules.ts', list, modulesTs) });
    const statements = prepared.migration.statements.map((s) => s.sql);
    const review: StudioReview = {
      planId: sha({ spec, statements, current: prepared.current, diff }),
      spec,
      change: installed === undefined ? 'install' : 'upgrade',
      from: installed?.version ?? null,
      diff,
      statements,
      destructive: prepared.migration.destructive.length > 0,
    };
    return { review, files, modulesTs, module, prepared };
  };

  app.get('/api/v1/studio', async (request) => {
    await guard(request);
    const modules = [];
    for (const dir of await studioModules(root)) {
      const spec = await readSpec(dir);
      modules.push({ name: spec.name, label: spec.label, version: spec.version });
    }
    return { mode, modules };
  });

  app.get('/api/v1/studio/modules/:name', async (request) => {
    await guard(request);
    const { name } = request.params as { name: string };
    const dir = join(modulesDir, name);
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(name) || !existsSync(join(dir, 'studio.json')))
      throw new HttpProblem(404, 'not-found', 'Not found', `No Studio module "${name}".`);
    const spec = await readSpec(dir);
    const files: Record<string, string> = {};
    for (const file of Object.keys(generateModule(spec, generate))) {
      const text = await fileOf(join(dir, file));
      if (text !== null) files[file] = text;
    }
    return { spec, files };
  });

  app.post('/api/v1/studio/preview', async (request) => {
    await guard(request);
    return (await prepare(specOf(request.body))).review;
  });

  app.post('/api/v1/studio/propose', async (request) => {
    await guard(request);
    const { review } = await prepare(specOf(request.body));
    return {
      spec: review.spec,
      change: review.change,
      statements: review.statements,
      patch: review.diff.map((d) => d.diff).join(''),
    };
  });

  app.post('/api/v1/studio/apply', async (request) => {
    const uid = await guard(request);
    if (mode !== 'write')
      throw new HttpProblem(
        409,
        'studio-propose-only',
        'Studio proposes changes here',
        'This server runs Studio in propose mode: it never writes code. Download the patch and deploy it.',
        'KOSH_STUDIO=write is for development and single-server installations.',
      );
    const planId = (request.body as { planId?: unknown } | null)?.planId;
    if (typeof planId !== 'string') return invalid('planId (from /preview) is required.');
    const { review, files, modulesTs, module, prepared } = await prepare(specOf(request.body));
    if (review.planId !== planId)
      throw new HttpProblem(
        409,
        'plan-changed',
        'The plan changed',
        'The module, the installed apps or the schema changed since this preview.',
        'Review the new preview, then apply it.',
      );
    const apps = appsOf();
    // The database first (one transaction): when it fails, the project's files are unchanged.
    const result = await applyApps(prepared, {
      driver,
      dir: apps.migrationsDir,
      actor: `user:${uid}`,
      audit: { actor: uid, ip: request.ip },
    }).catch((error: unknown) => {
      if (error instanceof AppPlanError)
        throw new HttpProblem(409, 'studio-change-refused', 'Studio change refused', error.message);
      throw error;
    });
    const dir = join(modulesDir, review.spec.name);
    await mkdir(dir, { recursive: true });
    const written: string[] = [];
    for (const [file, content] of Object.entries(files)) {
      if ((await fileOf(join(dir, file))) === content) continue;
      await writeFile(join(dir, file), content, 'utf8');
      written.push(`src/modules/${review.spec.name}/${file}`);
    }
    if (modulesTs !== null) {
      await writeFile(join(root, 'src', 'modules.ts'), modulesTs, 'utf8');
      written.push('src/modules.ts');
    }
    apps.useModule?.(module);
    await apps.reload();
    return {
      name: review.spec.name,
      version: review.spec.version,
      change: review.change,
      installed: result.installed,
      upgraded: result.upgraded,
      written,
      migration:
        result.migration === null
          ? null
          : `${result.migration.version}_${result.migration.name}.sql`,
    };
  });
}
