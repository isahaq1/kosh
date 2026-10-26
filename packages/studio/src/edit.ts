/**
 * Studio edits (RFC 0012 §5.6): what the back-office's Studio mode asks for — a field added to a form section, a
 * column added to a list, a model of its own with a menu — merged into a Studio module's spec. The server does
 * this (the UI only says where and what): the new field's name, the dependencies on the modules that own the
 * models and views, the view change merged into the existing ones.
 */
import {
  camel,
  modelName,
  type StudioApproval,
  type StudioField,
  type StudioModel,
  type StudioRule,
  type StudioSpec,
} from './spec.js';

/** Where the change goes in a view: after a node, or at the end of a container (a form group). */
export type EditAnchor = { readonly insertAfter: string } | { readonly append: string };

export type StudioEdit =
  /** A new field on a model, shown in a view (form section or list column). */
  | {
      readonly kind: 'field';
      readonly model: string;
      /** Without `name`, the name comes from the label (`GST number` → `gstNumber`). */
      readonly field: Omit<StudioField, 'name'> & { readonly name?: string };
      readonly view?: string;
      readonly anchor?: EditAnchor;
    }
  /** An existing field of the view's model, as a list column (or form field). */
  | {
      readonly kind: 'show';
      readonly view: string;
      readonly field: string;
      readonly anchor: EditAnchor;
    }
  /** A model of the module's own, with a menu entry in the module's app. */
  | {
      readonly kind: 'model';
      /** Without names, they come from the labels (`Fuel log` → `fuel_log`, `Litres used` → `litresUsed`). */
      readonly model: Omit<StudioModel, 'name' | 'fields'> & {
        readonly name?: string;
        readonly fields: readonly (Omit<StudioField, 'name'> & { readonly name?: string })[];
      };
      readonly menu: { readonly label: string };
    }
  /** An approval policy (RFC 0003) the module ships; needs the Permissions app. */
  | { readonly kind: 'approval'; readonly approval: StudioApproval }
  /** An automation rule the module ships; without `id`, the key comes from the name. Needs the Automation app. */
  | { readonly kind: 'rule'; readonly rule: Omit<StudioRule, 'id'> & { readonly id?: string } };

/** Who owns what, from the served registry: the module defining a model, and the module defining a view. */
export interface Owners {
  modelOwner(model: string): string | undefined;
  viewOwner(view: string): string | undefined;
}

export class StudioEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioEditError';
  }
}

/** `GST number` → `gstNumber`; `2nd phone` → `f2ndPhone`. */
export function nameFromLabel(label: string): string {
  const words = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  const name = camel(words.map((w) => w.toLowerCase()).join('_'));
  if (name === '') return 'field';
  return /^[a-z]/.test(name) ? name.slice(0, 50) : `f${name}`.slice(0, 50);
}

/** `Fuel log` → `fuel_log` (a model's local name). */
export function localFromLabel(label: string): string {
  const name = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(name) ? name : `m_${name}`.slice(0, 40);
}

/** A new, empty Studio module. */
export function emptySpec(name: string, label: string): StudioSpec {
  return { name, label, version: '0.1.0', depends: [] };
}

const unique = (taken: ReadonlySet<string>, wanted: string): string => {
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) if (!taken.has(`${wanted}${i}`)) return `${wanted}${i}`;
};

/** The spec with the edit merged in. @throws {StudioEditError} when it refers to something that is not there */
export function applyEdit(spec: StudioSpec, edit: StudioEdit, owners: Owners): StudioSpec {
  const depends = new Set(spec.depends);
  const needs = (owner: string | undefined, what: string): void => {
    if (owner === undefined) throw new StudioEditError(`${what} is not served here.`);
    if (owner !== spec.name && owner !== 'base') depends.add(owner);
  };
  const withView = (
    next: StudioSpec,
    view: string,
    anchor: EditAnchor,
    fields: readonly string[],
  ): StudioSpec => {
    if (!view.startsWith(`x_${spec.name}.`)) needs(owners.viewOwner(view), `The view ${view}`);
    const operation =
      'append' in anchor
        ? { append: anchor.append, fields }
        : { insertAfter: anchor.insertAfter, fields };
    const changes = [...(next.viewChanges ?? [])];
    const at = changes.findIndex((c) => c.view === view);
    if (at === -1) changes.push({ view, operations: [operation] });
    else {
      const current = changes[at];
      if (current !== undefined)
        changes[at] = { view, operations: [...current.operations, operation] };
    }
    return { ...next, viewChanges: changes };
  };

  let next: StudioSpec;
  switch (edit.kind) {
    case 'field': {
      const own = (spec.models ?? []).find((m) => modelName(spec.name, m.name) === edit.model);
      const existing = own?.fields ?? (spec.fields ?? []).filter((f) => f.model === edit.model);
      const name = unique(
        new Set(existing.map((f) => f.name)),
        edit.field.name ?? nameFromLabel(edit.field.label),
      );
      const field: StudioField = { ...edit.field, name };
      if (own !== undefined)
        next = {
          ...spec,
          models: (spec.models ?? []).map((m) =>
            m === own ? { ...m, fields: [...m.fields, field] } : m,
          ),
        };
      else {
        needs(owners.modelOwner(edit.model), `The model ${edit.model}`);
        next = { ...spec, fields: [...(spec.fields ?? []), { ...field, model: edit.model }] };
      }
      if (field.target !== undefined && !field.target.startsWith(`x_${spec.name}.`))
        needs(owners.modelOwner(field.target), `The model ${field.target}`);
      // A model of the module's own shows every field in its generated views: no view change.
      if (own === undefined && edit.view !== undefined && edit.anchor !== undefined)
        next = withView(next, edit.view, edit.anchor, [name]);
      break;
    }
    case 'show':
      next = withView(spec, edit.view, edit.anchor, [edit.field]);
      break;
    case 'model': {
      const taken = new Set((spec.models ?? []).map((m) => m.name));
      const local = edit.model.name ?? localFromLabel(edit.model.label);
      if (taken.has(local)) throw new StudioEditError(`The module has a model ${local} already.`);
      const keys = new Set<string>();
      const fields = edit.model.fields.map((f): StudioField => {
        const name = unique(keys, f.name ?? nameFromLabel(f.label));
        keys.add(name);
        return { ...f, name };
      });
      const model: StudioModel = { ...edit.model, name: local, fields };
      const menus = new Set((spec.menus ?? []).map((m) => m.id));
      next = {
        ...spec,
        app: spec.app ?? { label: spec.label },
        models: [...(spec.models ?? []), model],
        menus: [
          ...(spec.menus ?? []),
          { id: unique(menus, local), label: edit.menu.label, model: local },
        ],
      };
      for (const f of fields)
        if (f.target !== undefined && !f.target.startsWith(`x_${spec.name}.`))
          needs(owners.modelOwner(f.target), `The model ${f.target}`);
      break;
    }
    case 'approval': {
      if ((spec.approvals ?? []).some((a) => a.name === edit.approval.name))
        throw new StudioEditError(
          `The module has an approval policy "${edit.approval.name}" already.`,
        );
      needs(owners.modelOwner('approval.policy'), 'The Permissions app (approval policies)');
      if (!edit.approval.model.startsWith(`x_${spec.name}.`))
        needs(owners.modelOwner(edit.approval.model), `The model ${edit.approval.model}`);
      next = { ...spec, approvals: [...(spec.approvals ?? []), edit.approval] };
      break;
    }
    case 'rule': {
      const ids = new Set((spec.automationRules ?? []).map((r) => r.id));
      const rule: StudioRule = {
        ...edit.rule,
        id: unique(ids, edit.rule.id ?? localFromLabel(edit.rule.name)),
      };
      needs(owners.modelOwner('automation.rule'), 'The Automation app (rules)');
      if (!rule.model.startsWith(`x_${spec.name}.`))
        needs(owners.modelOwner(rule.model), `The model ${rule.model}`);
      next = { ...spec, automationRules: [...(spec.automationRules ?? []), rule] };
      break;
    }
  }
  return { ...next, depends: [...depends].sort() };
}
