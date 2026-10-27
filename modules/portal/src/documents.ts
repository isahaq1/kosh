/**
 * The portal's catalogue (RFC 0015 §5.3): the documents the installed modules declare, checked when the server
 * starts. Every declared model, field, line field, transition and template must exist, and the model must give
 * `portal.user` read access with a record rule, so a declaration can never show a document without the rule that
 * keeps it to its customer.
 */
import type { PortalDocumentSpec } from '@kosh/modules-sdk';
import { type ApiModel, type KoshRegistry, publicApiModels, ServerConfigError } from '@kosh/server';

/** A declared document with the models it reads. */
export interface PortalDocument {
  readonly spec: PortalDocumentSpec;
  readonly model: ApiModel;
  /** The lines' model, when the document has lines. */
  readonly lineModel: ApiModel | null;
}

const fail = (key: string, problem: string, hint: string): never => {
  throw new ServerConfigError(`Portal document '${key}': ${problem}`, hint);
};

/** The documents of the loaded modules, by key. @throws {ServerConfigError} for a declaration that cannot work */
export function portalDocuments(registry: KoshRegistry): ReadonlyMap<string, PortalDocument> {
  const models = publicApiModels(registry);
  const out = new Map<string, PortalDocument>();
  const templates = new Set(
    registry.loaded.modules.flatMap((m) => (m.documents ?? []).map((d) => `${m.name}.${d.key}`)),
  );
  for (const module of registry.loaded.modules)
    for (const spec of module.portal?.documents ?? []) {
      const key = spec.key;
      if (out.has(key))
        fail(key, `declared twice (again by ${module.name}).`, 'Document keys are unique.');
      const model = models.get(spec.model);
      if (model === undefined)
        fail(key, `no served model '${spec.model}'.`, 'Declare a model of an installed module.');
      const m = model as ApiModel;
      const definition = registry.registry.get(spec.model as never).model;
      const access = (definition.access as Readonly<Record<string, readonly string[]>>)[
        'portal.user'
      ];
      const ruled = Object.values(definition.rules).some(
        (r) =>
          r.groups !== 'global' && r.groups.includes('portal.user') && r.perms.includes('read'),
      );
      if (access?.includes('read') !== true || !ruled)
        fail(
          key,
          `${spec.model} gives portal.user no read access with a record rule.`,
          "Extend the model in the bridge: access { 'portal.user': ['read'] } and rules { portal: portalRule('partner') }.",
        );
      const partner = m.byKey.get(spec.partner);
      if (partner?.kind !== 'many2one' || partner.target !== 'res.partner')
        fail(
          key,
          `'${spec.partner}' is not a many2one to res.partner.`,
          'Name the customer field.',
        );
      for (const field of [...spec.list, ...spec.fields])
        if (!m.byKey.has(field))
          fail(key, `${spec.model} has no field '${field}'.`, 'Declare existing fields.');
      let lineModel: ApiModel | null = null;
      if (spec.lines !== undefined) {
        const lines = m.byKey.get(spec.lines.field);
        if (lines?.kind !== 'one2many' || lines.target === null)
          fail(key, `'${spec.lines.field}' is not a one2many.`, 'Name the lines field.');
        lineModel = models.get(lines?.target ?? '') ?? null;
        if (lineModel === null)
          fail(key, `the lines' model ${lines?.target} is not served.`, 'Use a served model.');
        for (const field of spec.lines.fields)
          if (!(lineModel as ApiModel).byKey.has(field))
            fail(key, `${lines?.target} has no field '${field}'.`, 'Declare existing line fields.');
      }
      for (const action of spec.actions ?? [])
        if (!m.transitions.includes(action.transition))
          fail(
            key,
            `${spec.model} has no transition '${action.transition}' (action '${action.key}').`,
            `Transitions: ${m.transitions.join(', ') || 'none'}.`,
          );
      if (spec.pdf !== undefined && !templates.has(spec.pdf))
        fail(
          key,
          `no document template '${spec.pdf}'.`,
          'Name a template a module ships (module.key).',
        );
      out.set(key, { spec, model: m, lineModel });
    }
  return out;
}
