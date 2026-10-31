import { describe, expect, test } from 'vitest';
import {
  evaluate,
  form,
  holds,
  kanban,
  list,
  type ModelInfo,
  resolveRecord,
  resolveView,
  stat,
  ViewDefinitionError,
  validateAction,
  validateSearch,
  validateView,
} from '../src/index.js';

// A model handle as Shutro's defineModel returns it (structurally).
const PurchaseOrder = {
  name: 'purchase.order',
  fields: { name: {}, partner: {}, amountTotal: {}, state: {}, lines: {}, dateOrder: {} },
} as const;

const models = new Map<string, ModelInfo>([
  [
    'purchase.order',
    {
      fields: new Map([
        ['id', { kind: 'integer', target: null, stored: true }],
        ['name', { kind: 'char', target: null, stored: true }],
        ['partner', { kind: 'many2one', target: 'res.partner', stored: true }],
        ['amountTotal', { kind: 'decimal', target: null, stored: true }],
        ['state', { kind: 'state', target: null, stored: true }],
        ['dateOrder', { kind: 'date', target: null, stored: true }],
        ['lines', { kind: 'one2many', target: 'purchase.order.line', stored: false }],
      ]),
      transitions: ['submit', 'approve', 'cancel'],
    },
  ],
  [
    'purchase.order.line',
    {
      fields: new Map([
        ['product', { kind: 'char', target: null, stored: true }],
        ['quantity', { kind: 'decimal', target: null, stored: true }],
      ]),
      transitions: [],
    },
  ],
  [
    'res.partner',
    { fields: new Map([['name', { kind: 'char', target: null, stored: true }]]), transitions: [] },
  ],
]);
const lookup = (name: string) => models.get(name);

const orderForm = () =>
  ({
    ...form(PurchaseOrder, (f) => ({
      header: {
        statusbar: 'state',
        buttons: [f.button('submit', { primary: true }), f.button('approve')],
      },
      sheet: [
        f.group('main', ['name', 'partner', { field: 'amountTotal', widget: 'money' }]),
        f.notebook('tabs', [
          f.page('lines_page', 'Lines', [f.lines('lines', ['product', 'quantity'])]),
        ]),
      ],
      readonlyWhen: { state: { notIn: ['draft'] } },
    })),
    id: 'purchase.order.form',
  }) as const;

describe('builders', () => {
  test('field keys are checked at compile time', () => {
    list(PurchaseOrder, { columns: ['name', { field: 'amountTotal', sum: true }, 'createdAt'] });
    // @ts-expect-error not a field of purchase.order
    list(PurchaseOrder, { columns: ['nmae'] });
    // @ts-expect-error not a field
    kanban(PurchaseOrder, { groupBy: 'stage', card: { title: 'name' } });
    // @ts-expect-error defaultOrder direction
    list(PurchaseOrder, { columns: ['name'], defaultOrder: ['name sideways'] });
    form(PurchaseOrder, (f) => ({
      // @ts-expect-error not a field
      sheet: [f.group('main', ['nope'])],
    }));
    expect(list('any.model', { columns: ['whatever'] }).model).toBe('any.model'); // by name: checked at load
  });

  test('nodes get anchor ids', () => {
    const view = orderForm();
    expect(view.header.buttons.map((b) => b.id)).toEqual(['submit', 'approve']);
    expect(view.sheet[0]).toMatchObject({
      kind: 'group',
      id: 'main',
      children: [{ id: 'name' }, { id: 'partner' }, { id: 'amountTotal', widget: 'money' }],
    });
  });
});

describe('extensions by anchor', () => {
  test('insert, replace, remove, setAttrs; origins and chain recorded', () => {
    const resolved = resolveView(orderForm(), 'purchase', [
      {
        module: 'approvals',
        extension: {
          view: 'purchase.order.form',
          operations: [
            {
              insertAfter: 'main',
              nodes: [{ kind: 'component', id: 'approval_panel', component: 'approvals.Panel' }],
            },
            { setAttrs: 'partner', attrs: { label: 'Vendor' } },
            { remove: 'approve' },
          ],
        },
      },
      {
        module: 'purchase_stock',
        extension: {
          view: 'purchase.order.form',
          operations: [
            {
              insertBefore: 'quantity',
              nodes: [{ kind: 'field', id: 'warehouse', field: 'product' }],
            },
            { append: 'main', nodes: [{ kind: 'field', id: 'dateOrder', field: 'dateOrder' }] },
          ],
        },
      },
    ]);
    const view = resolved.view;
    if (view.type !== 'form') throw new Error('form');
    expect(view.sheet.map((n) => n.id)).toEqual(['main', 'approval_panel', 'tabs']);
    expect(view.header.buttons.map((b) => b.id)).toEqual(['submit']);
    expect(resolved.origins).toMatchObject({
      approval_panel: 'approvals',
      partner: 'approvals',
      warehouse: 'purchase_stock',
      name: 'purchase',
    });
    expect(resolved.origins).not.toHaveProperty('approve');
    expect(resolved.chain).toEqual(['purchase', 'approvals', 'purchase_stock']);
    const main = view.sheet[0];
    expect(main?.kind === 'group' && main.children.map((c) => c.id)).toEqual([
      'name',
      'partner',
      'amountTotal',
      'dateOrder',
    ]);
  });

  test('an unknown anchor or a duplicate id fails at load', () => {
    expect(() =>
      resolveView(orderForm(), 'purchase', [
        {
          module: 'x',
          extension: { view: 'purchase.order.form', operations: [{ remove: 'nowhere' }] },
        },
      ]),
    ).toThrow(ViewDefinitionError);
    expect(() =>
      resolveView(orderForm(), 'purchase', [
        {
          module: 'x',
          extension: {
            view: 'purchase.order.form',
            operations: [
              { insertAfter: 'name', nodes: [{ kind: 'field', id: 'partner', field: 'partner' }] },
            ],
          },
        },
      ]),
    ).toThrow(/two nodes have the id 'partner'/);
  });
});

describe('conditions', () => {
  const env = { uid: 7, companyId: 1 };
  test('the domain subset the client decides', () => {
    expect(evaluate({ state: { notIn: ['draft'] } }, { state: 'submitted' }, env)).toBe(true);
    expect(evaluate({ state: 'draft' }, { state: 'submitted' }, env)).toBe(false);
    expect(evaluate({ amountTotal: { gt: '50000' } }, { amountTotal: '750000.00' }, env)).toBe(
      true,
    );
    expect(evaluate({ amountTotal: { gt: '50000' } }, { amountTotal: '9999' }, env)).toBe(false);
    expect(evaluate({ createdBy: { $env: 'uid' } }, { createdBy: 7 }, env)).toBe(true);
    expect(evaluate({ partner: null }, { partner: null }, env)).toBe(true);
    expect(
      evaluate(
        { or: [{ state: 'draft' }, { amountTotal: { lt: 10 } }] },
        { state: 'x', amountTotal: '5' },
        env,
      ),
    ).toBe(true);
    expect(evaluate({ not: { state: 'draft' } }, { state: 'draft' }, env)).toBe(false);
    expect(evaluate({ name: { ilike: 'acme%' } }, { name: 'ACME Ltd' }, env)).toBe(true);
  });
  test('holds: no condition never holds (readonlyWhen absent: editable)', () => {
    expect(holds(undefined, {}, env)).toBe(false);
    expect(evaluate(undefined, {}, env)).toBe(true); // visibleWhen absent: visible
    expect(holds({ state: 'lost' }, { state: 'lost' }, env)).toBe(true);
    expect(holds({ 'partner.x': 1 }, {}, env)).toBe(false);
  });
  test('relation paths and unloaded values are undecided (server-evaluated)', () => {
    expect(evaluate({ 'partner.country': 'BD' }, { partner: 3 }, env)).toBeUndefined();
    expect(evaluate({ amountTotal: { gt: 1 } }, {}, env)).toBeUndefined();
    expect(evaluate({ and: [{ state: 'x' }, { 'a.b': 1 }] }, { state: 'y' }, env)).toBe(false); // decided anyway
  });
});

describe('validation against the models', () => {
  test('a valid form passes', () => {
    expect(validateView(orderForm(), lookup)).toEqual([]);
  });
  test('unknown fields, line columns, transitions and group-by fields are reported', () => {
    const bad = {
      ...form('purchase.order', (f) => ({
        header: { statusbar: 'name', buttons: [f.button('teleport')] },
        sheet: [
          f.group('main', ['nope', 'partner.name', 'partner.zip']),
          f.lines('lines', ['product', 'colour']),
        ],
      })),
      id: 'bad',
    };
    expect(validateView(bad, lookup)).toEqual([
      "unknown transition 'teleport' (has submit, approve, cancel)",
      "unknown field 'nope' (no field 'nope' on purchase.order)",
      "unknown field 'partner.zip' (no field 'zip' on res.partner)",
      "unknown field 'colour' (no field 'colour' on purchase.order.line)",
      "statusbar 'name' is not a state or selection field",
    ]);
    expect(
      validateView(
        {
          ...kanban('purchase.order', { groupBy: 'amountTotal', card: { title: 'name' } }),
          id: 'k',
        },
        lookup,
      ),
    ).toEqual([
      "kanban groupBy 'amountTotal' is not a stored selection, state, many2one or char field",
    ]);
    expect(
      validateSearch(
        'purchase.order',
        { fields: ['name', 'partner.name', 'lines.x'], groupBy: ['dateOrder:month', 'name:month'] },
        lookup,
      ),
    ).toEqual([
      "unknown search field 'lines.x' (no field 'x' on purchase.order.line)",
      "group-by 'name:month': a granularity needs a date field",
    ]);
  });
});

test('client actions open a registered page, named <module>.<Name>', () => {
  const none = () => undefined;
  expect(validateAction({ type: 'client', page: 'settings.Apps' }, none, new Map())).toEqual([]);
  expect(validateAction({ type: 'client', page: 'Apps' }, none, new Map())).toEqual([
    "the page 'Apps' is not '<module>.<Name>'",
  ]);
});

describe('stat tiles (RFC 0022 §3.1)', () => {
  const withStats = () => ({
    ...form(PurchaseOrder, (f) => ({
      sheet: [
        f.stats('related', [
          {
            id: 'lines_count',
            label: 'Lines',
            model: 'purchase.order.line',
            where: { product: { $record: 'name' } },
          },
        ]),
        f.group('main', ['name']),
      ],
    })),
    id: 'purchase.order.form',
  });

  test('k.stats builds a row; another module appends a tile by the row anchor', () => {
    const resolved = resolveView(withStats(), 'purchase', [
      {
        module: 'purchase_account',
        extension: {
          view: 'purchase.order.form',
          operations: [
            {
              append: 'related',
              nodes: [
                stat({
                  id: 'bills',
                  label: 'Bills',
                  model: 'purchase.order',
                  where: { partner: { $record: 'partner' } },
                  measure: { sum: 'amountTotal' },
                }),
              ],
            },
          ],
        },
      },
    ]);
    const view = resolved.view;
    if (view.type !== 'form') throw new Error('form');
    const row = view.sheet[0];
    expect(row?.kind === 'stats' && row.children.map((c) => c.id)).toEqual([
      'lines_count',
      'bills',
    ]);
    expect(resolved.origins).toMatchObject({ lines_count: 'purchase', bills: 'purchase_account' });
  });

  test('tiles are checked: the model, the measure, the filter fields and the $record fields', () => {
    expect(validateView(withStats(), lookup)).toEqual([]);
    const bad = form(PurchaseOrder, (f) => ({
      sheet: [
        f.stats('related', [
          { id: 'a', label: 'A', model: 'nowhere.model', where: {} },
          {
            id: 'b',
            label: 'B',
            model: 'purchase.order',
            where: { nope: 1 },
            measure: { sum: 'missing' },
          },
          {
            id: 'c',
            label: 'C',
            model: 'purchase.order',
            where: { partner: { $record: 'ghost' } },
          },
        ]),
      ],
    }));
    const problems = validateView({ ...bad, id: 'x' }, lookup);
    expect(problems).toEqual([
      "stat 'a': the model 'nowhere.model' is not installed",
      "stat 'b': no field 'missing' on purchase.order",
      "stat 'b': no field 'nope' on purchase.order",
      "stat 'c': '$record' names no field 'ghost' of purchase.order",
    ]);
  });

  test("$record placeholders take the record's values; related values give their id", () => {
    expect(
      resolveRecord(
        {
          partner: { $record: 'partner' },
          state: { in: ['sale'] },
          or: [{ order: { $record: 'id' } }],
        },
        { id: 42, partner: { id: 7, displayName: 'Bengal Steel' } },
      ),
    ).toEqual({ partner: 7, state: { in: ['sale'] }, or: [{ order: 42 }] });
  });
});
