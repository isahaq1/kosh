/**
 * Module manifests (RFC 0001 §5): one typed object per module, wrapping its Shutro module. Shutro owns the data layer
 * (models, extensions, groups, permissions, sequences, data); the manifest adds what an application needs on top.
 *
 * The Shutro module is described structurally here (`@kosh/modules-sdk` does not import Shutro: only
 * `packages/server/src/orm.ts` does); the server's loader verifies it is a real Shutro module.
 */
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

/** Lifecycle hooks (RFC 0001 §5.7); run by the server in a system scope inside the install transaction. */
export interface ModuleHooks {
  readonly postInstall?: (env: unknown) => Promise<void>;
  readonly preUninstall?: (env: unknown) => Promise<void>;
}

/** The input of {@link defineModule}. */
export interface ModuleInput {
  /** The Shutro module: name, version and data-layer dependencies come from it. */
  readonly shutro: ShutroModuleShape;
  /** The framework versions this module works with (checked when loading). */
  readonly kosh: string;
  /** Kosh modules this one needs; must cover every dependency of the Shutro module. */
  readonly depends?: readonly KoshModule[];
  readonly app?: AppSpec;
  /** Required and non-empty: a module without access levels fails to load (CLAUDE.md). */
  readonly accessLevels: Readonly<Record<string, AccessLevel>>;
  readonly menus?: readonly MenuSpec[];
  /** Window actions by id (shape defined with RFC 0004). */
  readonly actions?: Readonly<Record<string, unknown>>;
  /** Views by id (RFC 0004). */
  readonly views?: Readonly<Record<string, unknown>>;
  /**
   * Models of this module the generated API never serves, not even to administrators (credentials, sessions,
   * internal queues). The module's own routes use them in system scopes.
   */
  readonly privateModels?: readonly string[];
  /**
   * Default approval policies (RFC 0003 §5.3), installed as data and editable afterwards by administrators. Levels
   * apply in order; a level applies when its condition (a Shutro domain on the record) matches.
   */
  readonly approvals?: readonly ApprovalSpec[];
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
