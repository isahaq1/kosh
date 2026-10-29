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

/**
 * An automation rule a module ships (RFC 0011, RFC 0012 §5.1): installed by the Automation app as a rule owned by
 * the module (`module` + key) in every company, updated when the module is upgraded (its on/off switch stays the
 * administrator's), archived when the module no longer declares it. The fields are those of `automation.rule`.
 */
export interface AutomationRuleSpec {
  readonly name: string;
  /** The model it watches (`res.partner`). */
  readonly model: string;
  readonly trigger:
    | 'created'
    | 'updated'
    | 'deleted'
    | 'transition'
    | 'event'
    | 'date'
    | 'schedule';
  /** The ordered actions: `[{ kind, ...params }]` as the rule editor makes them. */
  readonly actions: readonly Readonly<Record<string, unknown>>[];
  readonly condition?: Readonly<Record<string, unknown>>;
  readonly watchFields?: readonly string[];
  readonly toValues?: Readonly<Record<string, unknown>>;
  readonly fromValues?: Readonly<Record<string, unknown>>;
  readonly topic?: string;
  readonly dateField?: string;
  readonly dateOffsetDays?: number;
  readonly cron?: string;
  readonly runAs?: 'actor' | 'system';
  readonly logOnRecord?: boolean;
  readonly description?: string;
  readonly sequence?: number;
  /** Installed switched on (default) or off. */
  readonly enabled?: boolean;
}

/**
 * An event a module emits through Shutro's outbox (`env.emit(topic, { id, … })`), which webhooks and integrations
 * may subscribe to (RFC 0017 §5.3): the topic, the model whose record `id` names, and what it means.
 */
export interface EventSpec {
  readonly topic: string;
  readonly model: string;
  readonly label: string;
}

/** A call received by an inbound webhook (RFC 0017 §5.4): the raw body (what signatures cover) and its JSON. */
export interface InboundCall {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  /** The body as received. */
  readonly body: string;
  /** The body parsed as JSON, or null. */
  readonly json: unknown;
}

/**
 * An endpoint a module receives calls on from outside (RFC 0017 §5.4): a payment provider's callback, a shipping
 * status. Companies switch it on in Integrations › Inbound webhooks (a URL and a secret each).
 */
export interface InboundWebhookSpec {
  /** Unique within the module (`ipn`); the endpoint is `<module>.<key>`. */
  readonly key: string;
  readonly label: string;
  /**
   * Whether the call is genuine — the provider's signature, or an HMAC with the endpoint's secret — and its event
   * id, by which repeated calls are recognised: the id, or null to refuse the call.
   */
  readonly verify: (call: InboundCall, secret: string) => string | null | Promise<string | null>;
  /**
   * Handles a verified call, once per event id, in a job (retried on failure): `env` is a system environment in
   * the endpoint's company. Returns a short note for the log (a string; anything else is not kept).
   */
  readonly handle: (env: unknown, call: InboundCall) => Promise<unknown>;
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

/**
 * An import template a module ships (RFC 0014 §5.4): the columns of a file for one of its models, offered on the
 * import screen and downloadable as a sample workbook. Read-only for users, who save their own mappings beside it.
 */
export interface ImportTemplateSpec {
  /** Unique within the module (`customers`); the template's id is `module.key`. */
  readonly key: string;
  readonly model: string;
  readonly label: string;
  /** The columns in order: the header the file has, and the field path it fills (`name`, `lines.product`). */
  readonly columns: readonly { readonly header: string; readonly field: string }[];
  /** Conversion options and the mode (`mode`, `key`, `dateOrder`, `decimal`…), as an import takes them. */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** An action a portal user may take on a document (RFC 0015 §5.3): accept a quotation, decline it. */
export interface PortalActionSpec {
  /** Unique within the document (`accept`). */
  readonly key: string;
  readonly label: string;
  /** The state transition it runs, once the portal checked the record is the user's and `when` holds. */
  readonly transition: string;
  /** When it is offered: a domain on the record (`{ state: 'sent' }`). */
  readonly when: Readonly<Record<string, unknown>>;
  /** The user signs: a typed name and a drawn signature, kept with the document's hash. */
  readonly signature?: boolean;
  /** The user writes why (a reason to decline): posted on the document's thread. */
  readonly message?: boolean;
}

/**
 * A document type the portal shows its customers or vendors (RFC 0015 §5.3): which records (theirs by `partner`,
 * narrowed by `domain`), which fields, its lines, its PDF, its actions and its thread. The model must give
 * `portal.user` read access with a record rule (the portal checks at start); only the declared fields are ever read.
 */
export interface PortalDocumentSpec {
  /** Unique across modules (`quotations`): the portal's path. */
  readonly key: string;
  readonly model: string;
  readonly label: string;
  /** Whose document it is: a many2one to `res.partner`, or a path to one (`project.partner`). */
  readonly partner: string;
  /** Which records show (drafts stay internal): a domain. */
  readonly domain?: Readonly<Record<string, unknown>>;
  /** Fields of the list, in order. */
  readonly list: readonly string[];
  /** Fields of the document's page, in order. */
  readonly fields: readonly string[];
  /** Its lines: a one2many and the fields of each line. */
  readonly lines?: { readonly field: string; readonly fields: readonly string[] };
  /** A document template (`module.key`, RFC 0005) printed as the PDF. */
  readonly pdf?: string;
  readonly actions?: readonly PortalActionSpec[];
  /** The document's comments, both ways. */
  readonly thread?: boolean;
  /** What needs the user, shown on the portal's home (`{ state: 'sent' }`). */
  readonly attention?: Readonly<Record<string, unknown>>;
  /** The list's order (default: the model's). */
  readonly order?: readonly string[];
  /**
   * When a record enters this domain (a quotation sent, an invoice posted), its customer's portal users get an
   * email with a link, once. The model's writes must reach the portal: list it in the module's `changeEvents`.
   */
  readonly announce?: Readonly<Record<string, unknown>>;
  /**
   * The customer may pay it online (RFC 0017 §5.5) while it is in this domain (`{ paymentState: 'not_paid' }`):
   * the document's page offers Pay now when a payment module and a provider are there.
   */
  readonly payment?: { readonly when: Readonly<Record<string, unknown>> };
}

/**
 * A country localization (RFC 0016 §5.2): what installing it sets up for a company, once — its chart of accounts,
 * the accounts of the taxes it ships, its withholdings, its fiscal year and number grouping. The shapes are
 * Accounting's (`account.account` types, `account.withholding` fields); Accounting installs them.
 */
export interface LocalizationSpec {
  /** The chart's code (`bd`), stored on the company. */
  readonly key: string;
  /** ISO 3166 code (`BD`). */
  readonly country: string;
  readonly label: string;
  readonly chart: {
    readonly accounts: readonly {
      readonly code: string;
      readonly name: string;
      readonly type: string;
      readonly reconcile?: boolean;
    }[];
    /** The company's default accounts, by code. */
    readonly defaults: Readonly<
      Record<
        | 'receivable'
        | 'payable'
        | 'exchangeGain'
        | 'exchangeLoss'
        | 'retainedEarnings'
        | 'bank'
        | 'cash'
        | 'income'
        | 'expense',
        string
      >
    >;
    /** The account of any tax without one, by use. */
    readonly taxAccounts: { readonly sale: string; readonly purchase: string };
  };
  /** The account of each tax the module ships (`module.name` external id → account code). */
  readonly taxes?: Readonly<Record<string, string>>;
  /**
   * The accounts of the module's tax components (RFC 0016 step 5), by external id: the account code, or the account
   * and the reverse-charge (payable) account.
   */
  readonly components?: Readonly<
    Record<string, string | { readonly account: string; readonly reverseCharge?: string }>
  >;
  readonly withholdings?: readonly {
    readonly name: string;
    readonly direction: 'vendor' | 'customer';
    readonly base: 'untaxed' | 'tax' | 'total';
    readonly rate: string;
    readonly threshold?: string;
    /** An account code of the chart. */
    readonly account: string;
  }[];
  /** The first month of the fiscal year (1–12). */
  readonly fiscalYearStart?: number;
  readonly grouping?: 'international' | 'lakh';
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

/** An action a module offers to automation rules (RFC 0011 §5.3). */
export interface AutomationActionSpec {
  /** Unique (`crm.flag_vip`). */
  readonly key: string;
  readonly label: string;
  /** The model it applies to; any when omitted. */
  readonly model?: string;
  /** The parameters a rule may give (shown in the rule editor). */
  readonly params?: readonly {
    readonly key: string;
    readonly label: string;
    readonly kind: 'char' | 'integer' | 'boolean';
  }[];
  /** Runs in the run's environment (`Env` of `@kosh/server/orm`); `record.id` is null for a deleted record. */
  readonly run: (
    env: unknown,
    record: { readonly model: string; readonly id: number | null },
    params: Readonly<Record<string, unknown>>,
  ) => Promise<string | undefined>;
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
   * Models whose writes this module needs to hear about (Shutro change events, RFC 0018 §7.5): each create, write
   * and unlink emits a `record.changed` outbox event per model and action. `'*'`: every model served, but the
   * private ones. The automation builder asks for `'*'` (rules on any field, RFC 0011 step 4).
   */
  readonly changeEvents?: '*' | readonly string[];
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
   * Actions the automation builder (RFC 0011) offers beyond its fixed menu: typed TypeScript a rule runs on a
   * record in the run's scope (the actor's rights, or the system's), with the parameters the rule gives.
   */
  readonly automationActions?: readonly AutomationActionSpec[];
  /**
   * Default approval policies (RFC 0003 §5.3), installed as data and editable afterwards by administrators. Levels
   * apply in order; a level applies when its condition (a Shutro domain on the record) matches.
   */
  readonly approvals?: readonly ApprovalSpec[];
  /**
   * Automation rules the module ships, by key (`welcome_note`), installed by the Automation app as rules owned by
   * the module (needs `automation` installed; RFC 0012 §5.1).
   */
  readonly automationRules?: Readonly<Record<string, AutomationRuleSpec>>;
  /** Default document templates (RFC 0005), installed as data (`key` = `module.name`) and editable by designers. */
  readonly documents?: readonly DocumentSpec[];
  /**
   * Groups of users from outside the company: the customers and vendors of the portal (RFC 0015 §5.1). A user whose
   * groups are all external reaches only the sign-in routes and `/api/portal/`; every other route answers 403. An
   * external group may not imply `base.user` (checked when the server starts).
   */
  readonly externalGroups?: readonly string[];
  /** The country this module localizes (RFC 0016): set up for each company when the module is installed. */
  readonly localization?: LocalizationSpec;
  /** Events the module emits that webhooks may subscribe to (RFC 0017 §5.3). */
  readonly events?: readonly EventSpec[];
  /** Endpoints the module receives calls on from outside (RFC 0017 §5.4). */
  readonly inboundWebhooks?: readonly InboundWebhookSpec[];
  /** The app's own settings, shown in Settings › App settings (RFC 0020). */
  readonly settings?: SettingsSpec;
  /** What the module shows in the customer and vendor portal (RFC 0015), when `portal` is installed. */
  readonly portal?: { readonly documents: readonly PortalDocumentSpec[] };
  /** Import templates for the module's models (RFC 0014 §5.4), offered when `import` is installed. */
  readonly importTemplates?: readonly ImportTemplateSpec[];
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
/**
 * A setting (RFC 0020 §3.1). In a `company` section, `key` names a `res.company` field the module adds with
 * `extendModel`: its type, label and default come from the field; `help`, bounds and `visibleWhen` add to it. In an
 * `installation` section, the setting is a key / value of its own: `type` and `label` are required.
 */
export interface SettingFieldSpec {
  readonly key: string;
  readonly type?: 'boolean' | 'integer' | 'decimal' | 'char' | 'text' | 'selection' | 'date';
  readonly label?: string;
  readonly help?: string;
  readonly default?: string | number | boolean | null;
  readonly min?: number;
  readonly max?: number;
  /** Selection options (installation settings): value → label. */
  readonly options?: Readonly<Record<string, string>>;
  /** Shown only when another setting of the section has this value. */
  readonly visibleWhen?: { readonly key: string; readonly equals: string | number | boolean };
}

/** A section of an app's settings (RFC 0020 §3.1). */
export interface SettingsSectionSpec {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /** Words the Settings search also finds it by. */
  readonly keywords?: string;
  /** Per company (`res.company` fields) or for the whole installation. */
  readonly scope: 'company' | 'installation';
  /** Groups whose holders may change it; Administrators always may. Empty: administrators only. */
  readonly editors?: readonly string[];
  readonly fields: readonly SettingFieldSpec[];
}

export interface SettingsSpec {
  readonly sections: readonly SettingsSectionSpec[];
}

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
  const RULE_TRIGGERS = [
    'created',
    'updated',
    'deleted',
    'transition',
    'event',
    'date',
    'schedule',
  ];
  for (const [key, rule] of Object.entries(input.automationRules ?? {})) {
    if (!LEVEL.test(key))
      fail(`automation rule key '${key}' is not snake_case.`, "Use e.g. 'welcome_note'.");
    if (!ID.test(rule.model))
      fail(`automation rule '${key}' names the model '${rule.model}'.`, "Use e.g. 'res.partner'.");
    if (!RULE_TRIGGERS.includes(rule.trigger))
      fail(
        `automation rule '${key}' has the trigger '${rule.trigger}'.`,
        `Use one of ${RULE_TRIGGERS.join(', ')}.`,
      );
    if (!Array.isArray(rule.actions) || rule.actions.length === 0)
      fail(`automation rule '${key}' has no actions.`, "Give at least one, e.g. { kind: 'note' }.");
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
  const documentKeys = new Set<string>();
  for (const document of input.portal?.documents ?? []) {
    if (!LEVEL.test(document.key) || documentKeys.has(document.key))
      fail(
        `portal document key '${document.key}' is not a unique snake_case name.`,
        "Use e.g. key: 'quotations'.",
      );
    documentKeys.add(document.key);
    if (document.fields.length === 0 || document.list.length === 0)
      fail(
        `portal document '${document.key}' shows no field.`,
        'List its fields and list columns.',
      );
    const actionKeys = new Set<string>();
    for (const action of document.actions ?? []) {
      if (!LEVEL.test(action.key) || actionKeys.has(action.key))
        fail(
          `portal action '${action.key}' of '${document.key}' is not a unique snake_case name.`,
          "Use e.g. key: 'accept'.",
        );
      actionKeys.add(action.key);
    }
  }
  const templateKeys = new Set<string>();
  for (const template of input.importTemplates ?? []) {
    if (!LEVEL.test(template.key) || templateKeys.has(template.key))
      fail(
        `import template key '${template.key}' is not a unique snake_case name.`,
        "Use e.g. key: 'customers'.",
      );
    templateKeys.add(template.key);
    if (template.columns.length === 0)
      fail(`import template '${template.key}' has no columns.`, 'List the columns of the file.');
  }
  return Object.freeze({
    ...input,
    name,
    version: input.shutro.version,
    depends: Object.freeze([...(input.depends ?? [])]),
    accessLevels: Object.freeze({ ...input.accessLevels }),
    menus: Object.freeze([...(input.menus ?? [])]),
  });
}
