/**
 * Variants (RFC 0030 §3.4, part 1). **Attributes** (size, colour…) have **values** with an extra price; a
 * **template** is the family — name, kind, category, unit, prices, taxes, picture — with the attributes it offers
 * and the **exclusions** (combinations that do not exist). **Generate variants** makes a `product.product` per
 * combination — so every app keeps working on products as before —, each with the template's values, its own code,
 * barcode, cost and picture, and a sales price of the template's plus its values' extras (unless the variant keeps
 * its own); combinations no longer offered are archived, never deleted.
 */
import type { Decimal } from '@kosh/server/orm';
import { check, compute, defineModel, type Env, f, records } from './.kosh/bindings.js';

const READ = ['read'] as const;
const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

export const ProductAttribute = defineModel('product.attribute', {
  label: 'Attribute',
  recName: 'name',
  archivable: true,
  order: ['sequence asc', 'name asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    display: f.selection(
      { list: 'List', radio: 'Radio buttons', swatch: 'Colour swatches', size: 'Sizes' },
      { required: true, default: 'list', help: 'How the Shop and the forms offer its values.' },
    ),
    sequence: f.integer({ required: true, default: 10 }),
    values: f.one2many('product.attribute.value', 'attribute'),
  },
});

export const ProductAttributeValue = defineModel('product.attribute.value', {
  label: 'Attribute value',
  recName: 'name',
  archivable: true,
  order: ['sequence asc', 'id asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    attribute: f.many2one('product.attribute', { required: true, ondelete: 'cascade' }),
    name: f.char({ required: true, translate: true }),
    color: f.char({ size: 7, label: 'Colour', help: 'A hex colour (#RRGGBB) for swatches.' }),
    sequence: f.integer({ required: true, default: 10 }),
    extraPrice: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Extra price',
      help: 'Added to the template’s sales price for variants with this value.',
    }),
  },
});

export const ProductTemplate = defineModel('product.template', {
  label: 'Product template',
  recName: 'name',
  archivable: true,
  order: ['name asc', 'id asc'],
  tracking: ['name', 'listPrice', 'standardPrice', 'state'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    name: f.char({ required: true, translate: true }),
    kind: f.selection(
      { goods: 'Goods', service: 'Service' },
      {
        required: true,
        default: 'goods',
        help: 'Goods are stocked and delivered; services are work or time.',
      },
    ),
    category: f.many2one('product.category'),
    uom: f.many2one('uom.uom', { label: 'Unit of measure' }),
    listPrice: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Sales price',
      help: 'The base: each variant adds its values’ extra prices, unless it keeps its own price.',
    }),
    standardPrice: f.decimal({
      scale: 2,
      required: true,
      default: '0',
      label: 'Cost',
      help: 'What new variants start at; each variant keeps its own cost.',
    }),
    saleOk: f.boolean({ default: true, label: 'Can be sold' }),
    purchaseOk: f.boolean({ default: true, label: 'Can be purchased' }),
    taxes: f.many2many('account.tax', {
      relation: 'product_template_sale_tax',
      label: 'Sales taxes',
    }),
    purchaseTaxes: f.many2many('account.tax', {
      relation: 'product_template_purchase_tax',
      label: 'Purchase taxes',
    }),
    image: f.many2one('storage.attachment', { ondelete: 'set null', label: 'Picture' }),
    description: f.text({ translate: true }),
    lines: f.one2many('product.template.line', 'template', { label: 'Attributes' }),
    exclusions: f.one2many('product.template.exclusion', 'template', { label: 'Exclusions' }),
    variants: f.one2many('product.product', 'template'),
    variantCount: f.integer({
      store: true,
      label: 'Variants',
      help: 'The active variants generated from the template.',
      ...compute('product.template', 'variantCount', ['variants.active'], (rows) => {
        for (const t of rows) t.variantCount = [...t.variants].filter((v) => v.active).length;
      }),
    }),
    state: f.state({
      states: { draft: 'Draft', ready: 'Variants generated' },
      initial: 'draft',
      help: 'Drafted until its variants are generated; generate again after changing the attributes offered.',
      transitions: {
        /** A variant per combination of the values offered, less the exclusions; the ones no longer offered archived. */
        generate: {
          from: ['draft', 'ready'],
          to: 'ready',
          guard: records('product.template', async (rows) =>
            [...(await rows.load({ lines: true }))]
              .filter((t) => t.lines.length === 0)
              .map((t) => t.id),
          ),
          message: 'Add at least one attribute with the values offered.',
          after: records('product.template', async (rows) => {
            const env = rows.env as unknown as Env;
            await env.flush();
            for (const t of await rows.load({})) {
              await generateVariants(env, t.id as number);
              await env.emit('product.template.generated', { id: t.id });
            }
          }),
        },
      },
      extensible: true,
    }),
  },
});

export const ProductTemplateLine = defineModel('product.template.line', {
  label: 'Template attribute',
  order: ['sequence asc', 'id asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    template: f.many2one('product.template', { required: true, ondelete: 'cascade' }),
    attribute: f.many2one('product.attribute', { required: true, ondelete: 'restrict' }),
    sequence: f.integer({ required: true, default: 10 }),
    values: f.many2many('product.attribute.value', {
      relation: 'product_template_line_value',
      label: 'Values offered',
    }),
  },
  constraints: {
    ownValues: {
      ...check('product.template.line', ['attribute', 'values'], async (lines) =>
        [...(await lines.load({ values: true }))]
          .filter((l) => [...l.values].some((v) => v.attribute.id !== l.attribute.id))
          .map((l) => l.id),
      ),
      message: 'Offer values of the line’s own attribute.',
    },
  },
});

export const ProductTemplateExclusion = defineModel('product.template.exclusion', {
  label: 'Excluded combination',
  order: ['id asc'],
  access: { 'product.user': READ, 'product.manager': ALL },
  fields: {
    template: f.many2one('product.template', { required: true, ondelete: 'cascade' }),
    values: f.many2many('product.attribute.value', {
      relation: 'product_template_excl_value',
      label: 'Values together',
      help: 'A variant with all of these values is not made.',
    }),
    note: f.char(),
  },
});

type ValueRow = { id: number; name: string; extraPrice: Decimal; sequence: number };

/** Every combination of one value per line, in the lines' order. */
function combinations(lines: ValueRow[][]): ValueRow[][] {
  return lines.reduce<ValueRow[][]>(
    (acc, values) => acc.flatMap((combo) => values.map((v) => [...combo, v])),
    [[]],
  );
}

/**
 * Makes the template's variants: one `product.product` per combination of the values offered that no exclusion
 * covers; existing ones are kept (reactivated, repriced unless they keep their own price), the ones no longer
 * offered are archived. Returns what was done.
 */
export async function generateVariants(
  env: Env,
  id: number,
): Promise<{ created: number; kept: number; archived: number }> {
  const [t] = await env
    .model('product.template')
    .browse([id as never])
    .load({
      lines: { attribute: true, values: true },
      exclusions: { values: true },
      variants: { attributeValues: true },
      taxes: true,
      purchaseTaxes: true,
    });
  if (t === undefined) return { created: 0, kept: 0, archived: 0 };
  const lines = [...t.lines]
    .sort(
      (a, b) =>
        a.sequence - b.sequence || a.attribute.sequence - b.attribute.sequence || a.id - b.id,
    )
    .map((l) =>
      [...l.values]
        .filter((v) => v.active)
        .sort((a, b) => a.sequence - b.sequence || a.id - b.id)
        .map((v) => ({
          id: v.id as number,
          name: v.name,
          extraPrice: v.extraPrice,
          sequence: v.sequence,
        })),
    )
    .filter((values) => values.length > 0);
  const excluded = [...t.exclusions].map((e) => [...e.values].map((v) => v.id as number));
  const wanted = new Map<string, ValueRow[]>();
  for (const combo of combinations(lines)) {
    const ids = combo.map((v) => v.id);
    if (excluded.some((ex) => ex.length > 0 && ex.every((v) => ids.includes(v)))) continue;
    wanted.set([...ids].sort((a, b) => a - b).join(','), combo);
  }
  const existing = new Map<string, typeof t.variants extends Iterable<infer V> ? V : never>();
  for (const v of t.variants)
    existing.set(
      [...v.attributeValues]
        .map((x) => x.id as number)
        .sort((a, b) => a - b)
        .join(','),
      v,
    );
  let created = 0;
  let kept = 0;
  let archived = 0;
  for (const [key, combo] of wanted) {
    const price = combo.reduce((s, v) => s.plus(v.extraPrice), t.listPrice);
    const name = combo.length === 0 ? t.name : `${t.name} (${combo.map((v) => v.name).join(', ')})`;
    const have = existing.get(key);
    if (have !== undefined) {
      kept++;
      await env
        .model('product.product')
        .browse([have.id])
        .write({
          active: true,
          ...(have.followsTemplatePrice ? { listPrice: price } : {}),
        } as never);
      continue;
    }
    created++;
    await env.model('product.product').create([
      {
        name,
        template: t.id,
        attributeValues: { set: combo.map((v) => v.id) },
        kind: t.kind,
        category: t.category?.id ?? null,
        uom: t.uom?.id ?? null,
        listPrice: price,
        standardPrice: t.standardPrice,
        saleOk: t.saleOk,
        purchaseOk: t.purchaseOk,
        taxes: { set: [...t.taxes].map((x) => x.id) },
        purchaseTaxes: { set: [...t.purchaseTaxes].map((x) => x.id) },
        image: t.image?.id ?? null,
        description: t.description,
        followsTemplatePrice: true,
      },
    ] as never);
  }
  for (const [key, v] of existing)
    if (!wanted.has(key) && v.active) {
      archived++;
      await env
        .model('product.product')
        .browse([v.id])
        .write({ active: false } as never);
    }
  await env.flush();
  return { created, kept, archived };
}
