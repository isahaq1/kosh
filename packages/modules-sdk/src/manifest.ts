/**
 * Module manifests (RFC 0001 §5): one typed object per module, wrapping its Shutro module. Shutro owns the data layer
 * (models, extensions, groups, permissions, sequences, data); the manifest adds what an application needs on top.
 *
 * The Shutro module is described structurally here (`@kosh/modules-sdk` does not import Shutro: only
 * `packages/server/src/orm.ts` does); the server's loader verifies it is a real Shutro module.
 */
import type { Action, Layout, SearchSpec, ViewDefinition, ViewExtension } from '@kosh/views';
import { ModuleDefinitionError } from './errors.js';
import { satisfies } from './semver.js';

/** What the manifest reads from the Shutro module it wraps. */
export interface ShutroModuleShape {
  readonly name: string;
  readonly version: string;
  readonly depends: readonly { readonly name: string }[];
  readonly groups: readonly { readonly code: string }[];
  readonly permissions: readonly { readonly code: string }[];
}

/** The app a module adds to the launcher (RFC 0001). */
export interface AppSpec {
  readonly code: string;
  readonly label: string;
  readonly icon?: string;
  /** Launcher order (lower first). */
  readonly sequence?: number;
  /** Where the App manager files it: `Finance`, `Sales`, `Services`, `Administration`, ... */
  readonly category?: string;
  /** One line for the App manager's card. */
  readonly summary?: string;
}

/**
 * An access level administrators assign through roles (RFC 0003 §5.1): installing a module grants none.
 * `groups` are Shutro group codes declared by this module or its dependencies.
 */
export interface AccessLevel {
  readonly label: string;
  readonly groups: readonly string[];
  /** Other access levels of this module this one includes. */
  readonly implies?: readonly string[];
}

/** A menu entry. Visible when the user holds one of `visibleTo` (group or permission codes), or any access level of the app. */
export interface MenuSpec {
  readonly id: string;
  readonly label: string;
  readonly parent?: string;
  readonly app?: string;
  readonly action?: string;
  readonly sequence?: number;
  readonly visibleTo?: readonly string[];
}

/** One level of an approval policy. */
export interface ApprovalLevelSpec {
  readonly name: string;
  /** A Shutro domain on the record (e.g. `{ amountTotal: { gt: '500000' } }`); empty or omitted: always. */
  readonly condition?: Readonly<Record<string, unknown>>;
  /** The group or role whose holders (in the record's company) decide. */
  readonly approverRole: string;
}

/** A default approval policy of a model. */
export interface ApprovalSpec {
  readonly name: string;
  readonly model: string;
  readonly levels: readonly ApprovalLevelSpec[];
  /** A transition of the record run when every level approved. */
  readonly onApproved?: string;
  /** A transition run when a level rejects. */
  readonly onRejected?: string;
}

/** A default document template of a module. */
export interface DocumentSpec {
  /** Unique within the module (`purchase_order`); stored as `module.key`. */
  readonly key: string;
  readonly name: string;
  readonly model: string;
  readonly layout: Layout;
  /** One record (default) or a list of records. */
  readonly scope?: 'record' | 'list';
}

/** A user the demo data is made by: created on first use with these groups (added to an existing one). */
export interface DemoUser {
  readonly login: string;
  readonly name: string;
  readonly groups: readonly string[];
}

/** What a module's demo seeder gets (RFC 0008 §5.8). Every scope is a transaction of its own. */
export interface DemoContext {
  /** The company the demo data belongs to. */
  readonly company: number;
  /** Every served module: a seeder may adapt to the others that are installed. */
  readonly modules: readonly KoshModule[];
  /** Runs `fn` as a demo user (`Env` of `@kosh/server/orm`): audit, sequences and record rules apply as for real data. */
  as<T>(user: DemoUser, fn: (env: unknown) => Promise<T>): Promise<T>;
  /** Runs `fn` in an audited system scope of the company, for what no user does by hand (a chart of accounts). */
  system<T>(reason: string, fn: (env: unknown) => Promise<T>): Promise<T>;
  /** Today in the company's calendar, `days` from now, as an ISO date: dates of the demo follow the installation. */
  date(days: number): string;
}

/** A catch-all email alias of a module (RFC 0006 §7.1). */
export interface InboundAliasSpec {
  /** The local part of the address (`support` for `support@<inbound domain>`). */
  readonly alias: string;
  readonly model: string;
  /** The field that takes the subject (`name`). */
  readonly subjectField: string;
  /** The field that takes the message text, when any. */
  readonly bodyField?: string;
  readonly defaults?:
    | Readonly<Record<string, unknown>>
    | ((env: unknown) => Promise<Readonly<Record<string, unknown>> | null>);
}

/** Lifecycle hooks (RFC 0001 §5.7); run by the server in a system scope inside the install transaction. */
export interface ModuleHooks {
  readonly postInstall?: (env: unknown) => Promise<void>;
  readonly preUninstall?: (env: unknown) => Promise<void>;
  /**
   * Installs this module's defaults derived from the served modules (approval policies from their `approvals`,
   * document templates from their `documents`, activity types, ...). Idempotent: runs after every seed and app
   * install (RFC 0008), so a newly installed module's declarations get their defaults. Returns a summary line for
   * the log (`3 approval policies installed`), or nothing.
   */
  readonly defaults?: (env: unknown, modules: readonly KoshModule[]) => Promise<string | undefined>;
  /**
   * Seeds this module's demo data (RFC 0008 §5.8): a realistic sample set made as demo users through the models,
   * so that an evaluator sees the app at work. Run once per module (`installDemo`), in dependency order, when an
   * installation asks for it (`kosh init --demo`); never on its own. Returns a summary line for the log.
   */
  readonly demo?: (context: DemoContext) => Promise<string | undefined>;
}

/** The input of {@link defineModule}. */
export interface ModuleInput {
  /** The Shutro module: name, version and data-layer dependencies come from it. */
  readonly shutro: ShutroModuleShape;
  /** The framework versions this module works with (checked when loading). */
  readonly kosh: string;
  /** Kosh modules this one needs; must cover every dependency of the Shutro module. */
  readonly depends?: readonly KoshModule[];
  /**
   * A bridge (RFC 0008 §5.1): the modules this one connects. It is proposed, and installed with reason `bridge`,
   * whenever every one of them is installed, unless the change leaves it out (`withoutBridges`). They must be
   * among `depends`.
   */
  readonly bridge?: readonly KoshModule[];
  readonly app?: AppSpec;
  /** Required and non-empty: a module without access levels fails to load (CLAUDE.md). */
  readonly accessLevels: Readonly<Record<string, AccessLevel>>;
  readonly menus?: readonly MenuSpec[];
  /** Actions by id: window actions (RFC 0004) and client actions (pages, RFC 0008). What menus open. */
  readonly actions?: Readonly<Record<string, Action>>;
  /** Views by id (RFC 0004), built with `list` / `form` / `kanban` from `@kosh/views`. */
  readonly views?: Readonly<Record<string, ViewDefinition>>;
  /** Changes to other modules' views by anchor, applied in dependency order. */
  readonly viewExtensions?: readonly ViewExtension[];
  /** Search definitions by model (filters, search fields, group-by options). */
  readonly search?: Readonly<Record<string, SearchSpec>>;
  /**
   * Models of this module the generated API never serves, not even to administrators (credentials, sessions,
   * internal queues). The module's own routes use them in system scopes.
   */
  readonly privateModels?: readonly string[];
  /**
   * Private models whose records take attachments through the attachment routes all the same (a chat channel):
   * the record's rules decide who uploads, lists and downloads, as for a public model.
   */
  readonly attachable?: readonly string[];
  /**
   * Catch-all email aliases (RFC 0006 §7.1): a message to `<alias>@<inbound domain>` that names no record creates
   * one of `model` (as the system, in the first company), its subject and text in `subjectField` and
   * `bodyField`, with `defaults` (a value, or a function of a system environment returning values; `null` when the
   * alias cannot take a message right now, which quarantines it), and the message is posted on it naming the
   * sender.
   */
  readonly inboundAliases?: readonly InboundAliasSpec[];
  /**
   * Default approval policies (RFC 0003 §5.3), installed as data and editable afterwards by administrators. Levels
   * apply in order; a level applies when its condition (a Shutro domain on the record) matches.
   */
  readonly approvals?: readonly ApprovalSpec[];
  /** Default document templates (RFC 0005), installed as data (`key` = `module.name`) and editable by designers. */
  readonly documents?: readonly DocumentSpec[];
  /**
   * Server routes of this module (admin APIs, custom endpoints). Called once at startup with the server context
   * (`ModuleContext` of `@kosh/server`); typed by the server, so modules declare the parameter type they use.
   */
  readonly routes?: (context: never) => void | Promise<void>;
  readonly hooks?: ModuleHooks;
  /** Translations per locale, loaded lazily. */
  readonly i18n?: Readonly<Record<string, () => Promise<unknown>>>;
}

/** A defined module: frozen, with its name and version taken from the Shutro module. */
export interface KoshModule extends Omit<ModuleInput, 'depends'> {
  readonly name: string;
  readonly version: string;
  readonly depends: readonly KoshModule[];
}

const ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const LEVEL = /^[a-z][a-z0-9_]*$/;

/**
 * Defines a Kosh module (RFC 0001). Checks what can be checked from the manifest alone; references between modules
 * (dependencies, groups, menu parents and actions) are checked by {@link loadModules}.
 * @throws {ModuleDefinitionError}
 */
export function defineModule(input: ModuleInput): KoshModule {
  const name = input.shutro?.name;
  if (typeof name !== 'string' || name === '')
    throw new ModuleDefinitionError(
      '?',
      'the Shutro module has no name.',
      'Pass the module returned by Shutro defineModule() as `shutro`.',
    );
  const fail = (problem: string, hint: string): never => {
    throw new ModuleDefinitionError(name, problem, hint);
  };
  try {
    satisfies('0.0.0', input.kosh); // validates the range's syntax
  } catch {
    fail(`kosh ${JSON.stringify(input.kosh)} is not a version range.`, "Use e.g. kosh: '^0.1.0'.");
  }
  const levels = Object.entries(input.accessLevels ?? {});
  if (levels.length === 0)
    fail(
      'declares no access levels.',
      "Every module declares what admins can grant, e.g. accessLevels: { user: { label: 'User', groups: ['contacts.user'] } }.",
    );
  for (const [key, level] of levels) {
    if (!LEVEL.test(key))
      fail(`access level '${key}' is not a snake_case key.`, "Use keys like 'user' or 'manager'.");
    if (level.groups.length === 0)
      fail(`access level '${key}' grants no group.`, 'List the Shutro groups it grants.');
    for (const implied of level.implies ?? [])
      if (implied === key || input.accessLevels[implied] === undefined)
        fail(
          `access level '${key}' implies '${implied}', which this module does not declare.`,
          'Imply another access level of the same module.',
        );
  }
  if (input.app !== undefined && !/^[a-z][a-z0-9_]*$/.test(input.app.code))
    fail(
      `app code '${input.app.code}' is not snake_case.`,
      "Use e.g. app: { code: 'contacts', label: 'Contacts' }.",
    );
  for (const policy of input.approvals ?? []) {
    if (!ID.test(policy.model))
      fail(
        `approval policy '${policy.name}' names the model '${policy.model}'.`,
        "Use a model name like 'purchase.order'.",
      );
    if (policy.levels.length === 0)
      fail(
        `approval policy '${policy.name}' has no levels.`,
        'Give at least one level with an approverRole.',
      );
    for (const level of policy.levels)
      if (!ID.test(level.approverRole))
        fail(
          `approval level '${level.name}' of '${policy.name}' has no approverRole group code.`,
          "Use a group or role code, e.g. 'purchase.approver'.",
        );
  }
  const menuIds = new Set<string>();
  for (const menu of input.menus ?? []) {
    if (!ID.test(menu.id))
      fail(`menu id '${menu.id}' is not '<module>.<name>'.`, `Use e.g. '${name}.root'.`);
    if (menuIds.has(menu.id)) fail(`menu '${menu.id}' is declared twice.`, 'Menu ids are unique.');
    menuIds.add(menu.id);
  }
  for (const id of Object.keys(input.actions ?? {}))
    if (!ID.test(id))
      fail(`action id '${id}' is not '<module>.<name>'.`, `Use e.g. '${name}.action_list'.`);
  return Object.freeze({
    ...input,
    name,
    version: input.shutro.version,
    depends: Object.freeze([...(input.depends ?? [])]),
    accessLevels: Object.freeze({ ...input.accessLevels }),
    menus: Object.freeze([...(input.menus ?? [])]),
  });
}
