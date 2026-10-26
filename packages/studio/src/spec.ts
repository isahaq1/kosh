/**
 * The Studio specification (RFC 0012 §5.1–5.2): what a Studio module changes, as JSON (`studio.json`). The only
 * file Studio reads and writes; the module's TypeScript is generated from it (`generate.ts`).
 */

export const FIELD_TYPES = [
  'char',
  'text',
  'integer',
  'decimal',
  'monetary',
  'date',
  'datetime',
  'boolean',
  'selection',
  'many2one',
  'many2many',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** A field Studio adds: on another module's model (`model`), or on one of its own models. */
export interface StudioField {
  /** camelCase, without the prefix: `gstNumber` becomes `xAcmeGstNumber` on another module's model. */
  readonly name: string;
  readonly type: FieldType;
  readonly label: string;
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  readonly help?: string;
  /** Logged in the chatter's change log, and watchable by automation rules. */
  readonly tracking?: boolean;
  /** Field security: only these groups read it. */
  readonly groups?: readonly string[];
  /** `selection`: value → label. */
  readonly options?: Readonly<Record<string, string>>;
  /** `many2one`, `many2many`: the target model. */
  readonly target?: string;
  /** `decimal`: digits after the point (default 2). */
  readonly scale?: number;
  /** `monetary`: the many2one field of the same model holding the currency (default `currency`). */
  readonly currency?: string;
}

/** A field on another module's model. */
export interface StudioModelField extends StudioField {
  /** `res.partner` */
  readonly model: string;
}

/** A model of the Studio module's own: `x_<module>.<name>`. */
export interface StudioModel {
  /** Lower-case, `vehicle` becomes `x_acme.vehicle`. */
  readonly name: string;
  readonly label: string;
  readonly fields: readonly StudioField[];
  /** The field that names a record (default: the first char field). */
  readonly recName?: string;
  readonly archivable?: boolean;
  readonly companyScoped?: boolean;
}

/**
 * A change of a view, by node ids (RFC 0004): fields are the Studio fields' names, or other keys as they are. A
 * list's columns are anchored on a column (`insertAfter: 'city'`); `append` needs a container (a form group).
 */
export type StudioViewOperation =
  | { readonly insertAfter: string; readonly fields: readonly string[] }
  | { readonly insertBefore: string; readonly fields: readonly string[] }
  | { readonly append: string; readonly fields: readonly string[] }
  | { readonly remove: string }
  | { readonly setAttrs: string; readonly attrs: Readonly<Record<string, unknown>> };

export interface StudioViewChange {
  /** The view's id: `res.partner.form`, `sale.order.list`. Its model is the id without the last segment. */
  readonly view: string;
  readonly operations: readonly StudioViewOperation[];
}

/** A menu entry opening a model's records (with a window action made for it). */
export interface StudioMenu {
  /** Local id: `vehicles` becomes `<module>.vehicles`. */
  readonly id: string;
  readonly label: string;
  /** A Studio model's name, or another model. */
  readonly model: string;
  /** An existing menu id; default: the module's own app. */
  readonly parent?: string;
  readonly views?: readonly ('list' | 'form' | 'kanban')[];
  readonly sequence?: number;
}

export interface StudioApproval {
  readonly name: string;
  readonly model: string;
  readonly onApproved?: string;
  readonly onRejected?: string;
  readonly levels: readonly {
    readonly name: string;
    readonly approverRole: string;
    readonly condition?: Readonly<Record<string, unknown>>;
  }[];
}

export interface StudioSpec {
  /** The module's name: lower-case letters, digits and `_` (`acme_custom`). */
  readonly name: string;
  readonly label: string;
  /** Bumped by Studio on every apply. */
  readonly version: string;
  readonly description?: string;
  /** The Kosh modules whose models or views it changes (`contacts`, `sales`). */
  readonly depends: readonly string[];
  /** An app of its own, for its menus (default: none; menus then need a parent). */
  readonly app?: { readonly label: string; readonly icon?: string };
  readonly fields?: readonly StudioModelField[];
  readonly models?: readonly StudioModel[];
  readonly viewChanges?: readonly StudioViewChange[];
  readonly menus?: readonly StudioMenu[];
  readonly approvals?: readonly StudioApproval[];
}

const MODULE = /^[a-z][a-z0-9_]{1,40}$/;
const FIELD = /^[a-z][a-zA-Z0-9]{0,50}$/;
const LOCAL = /^[a-z][a-z0-9_]{0,40}$/;
const MODEL = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const RESERVED = new Set([
  'base',
  'kosh',
  'auth',
  'res',
  'mail',
  'storage',
  'report',
  'approval',
  'studio',
]);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** `acme_custom` → `AcmeCustom`. */
export const pascal = (name: string): string =>
  name
    .split('_')
    .filter((p) => p !== '')
    .map(cap)
    .join('');
/** `acme_custom` → `acmeCustom`. */
export const camel = (name: string): string => {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** The key a Studio field gets on another module's model: `x` + module + name (`xAcmeGstNumber`). */
export function prefixedKey(module: string, name: string): string {
  return `x${pascal(module)}${cap(name)}`;
}

/** The name of a Studio model: `x_<module>.<name>`. */
export function modelName(module: string, name: string): string {
  return `x_${module}.${name}`;
}

/** The problems of a spec, each with where it is (`fields[2].target`); empty when it is valid. */
export function validateSpec(spec: StudioSpec): string[] {
  const problems: string[] = [];
  const at = (where: string, problem: string) => problems.push(`${where}: ${problem}`);
  if (!MODULE.test(spec.name) || RESERVED.has(spec.name))
    at('name', 'lower-case letters, digits and _ (2–41 characters), not a reserved name');
  if (typeof spec.label !== 'string' || spec.label.trim() === '') at('label', 'required');
  if (!VERSION.test(spec.version)) at('version', 'major.minor.patch');
  if (!Array.isArray(spec.depends)) at('depends', 'a list of module names');
  const own = new Set((spec.models ?? []).map((m) => modelName(spec.name, m.name)));
  const checkField = (where: string, f: StudioField, keys: Set<string>) => {
    if (!FIELD.test(f.name))
      at(`${where}.name`, 'camelCase letters and digits, starting lower-case');
    if (keys.has(f.name)) at(`${where}.name`, `'${f.name}' twice`);
    keys.add(f.name);
    if (!FIELD_TYPES.includes(f.type)) at(`${where}.type`, `one of ${FIELD_TYPES.join(', ')}`);
    if (typeof f.label !== 'string' || f.label.trim() === '') at(`${where}.label`, 'required');
    if (f.type === 'selection' && (f.options === undefined || Object.keys(f.options).length === 0))
      at(`${where}.options`, 'a selection needs its options');
    if (
      (f.type === 'many2one' || f.type === 'many2many') &&
      (f.target === undefined || !MODEL.test(f.target))
    )
      at(`${where}.target`, 'the target model (res.partner)');
    if (f.scale !== undefined && (!Number.isInteger(f.scale) || f.scale < 0 || f.scale > 12))
      at(`${where}.scale`, '0 to 12');
  };
  const onModel = new Map<string, Set<string>>();
  (spec.fields ?? []).forEach((f, i) => {
    if (!MODEL.test(f.model)) at(`fields[${i}].model`, 'a model name (res.partner)');
    if (own.has(f.model))
      at(`fields[${i}].model`, 'a Studio model takes its fields in models[].fields');
    const keys = onModel.get(f.model) ?? new Set<string>();
    onModel.set(f.model, keys);
    checkField(`fields[${i}]`, f, keys);
  });
  const names = new Set<string>();
  (spec.models ?? []).forEach((m, i) => {
    if (!LOCAL.test(m.name)) at(`models[${i}].name`, 'lower-case letters, digits and _');
    if (names.has(m.name)) at(`models[${i}].name`, `'${m.name}' twice`);
    names.add(m.name);
    if (typeof m.label !== 'string' || m.label.trim() === '') at(`models[${i}].label`, 'required');
    if (!Array.isArray(m.fields) || m.fields.length === 0)
      at(`models[${i}].fields`, 'at least one field');
    const keys = new Set<string>();
    (m.fields ?? []).forEach((f, j) => {
      checkField(`models[${i}].fields[${j}]`, f, keys);
    });
    if (m.recName !== undefined && !keys.has(m.recName))
      at(`models[${i}].recName`, `'${m.recName}' is not a field of the model`);
  });
  (spec.viewChanges ?? []).forEach((v, i) => {
    if (typeof v.view !== 'string' || !v.view.includes('.'))
      at(`viewChanges[${i}].view`, 'a view id (res.partner.form)');
    if (!Array.isArray(v.operations) || v.operations.length === 0)
      at(`viewChanges[${i}].operations`, 'at least one');
  });
  const menuIds = new Set<string>();
  (spec.menus ?? []).forEach((m, i) => {
    if (!LOCAL.test(m.id)) at(`menus[${i}].id`, 'lower-case letters, digits and _');
    if (menuIds.has(m.id)) at(`menus[${i}].id`, `'${m.id}' twice`);
    menuIds.add(m.id);
    if (m.parent === undefined && spec.app === undefined)
      at(`menus[${i}].parent`, 'a parent menu, or an app of the module');
  });
  return problems;
}
