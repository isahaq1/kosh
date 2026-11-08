/**
 * The stock ledger and the stock report (RFC 0032 §3.3), over HTTP:
 *
 * - `GET /api/v1/stockroom/ledger?from&to&mode=summary|details&warehouses=1,2&locations=&categories=&products=`
 *   — for a period and a scope of locations (chosen warehouses' stock, or chosen locations; every warehouse
 *   otherwise), per product: the opening quantity, what came in by **movement type** (purchase receipt, sales
 *   return, production, transfer in, adjustment, other), what went out by type (sales delivery, purchase return,
 *   production consumption, transfer out, internal use, scrap, adjustment, other) and the closing quantity; or every
 *   movement of the period. Movement types come from where the goods came from and went to, never typed by hand.
 *   With `stock_account`, and for people who may read the valuation, each figure carries its value.
 * - `GET /api/v1/stockroom/stock?warehouses&locations&categories&products` — on hand, reserved, available, incoming
 *   and outgoing per product and location in the scope.
 *
 * Both as JSON for the screen, or with `format=xlsx` / `format=pdf` as a file (the export right; audited).
 */
import { type Cell, moneyFormat, renderPdf, type Sheet, workbook } from '@kosh/reporting';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import { type Decimal, orm } from '@kosh/server/orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from './.kosh/bindings.js';

const zero: Decimal = orm.toDecimal(0);

export const IN_TYPES = [
  'purchase_receipt',
  'sales_return',
  'production_in',
  'transfer_in',
  'adjustment_in',
  'other_in',
] as const;
export const OUT_TYPES = [
  'sales_delivery',
  'purchase_return',
  'production_out',
  'transfer_out',
  'consumption',
  'scrap',
  'adjustment_out',
  'other_out',
] as const;
export type InType = (typeof IN_TYPES)[number];
export type OutType = (typeof OUT_TYPES)[number];
export type MovementType = InType | OutType;

export const TYPE_LABELS: Readonly<Record<MovementType, string>> = {
  purchase_receipt: 'Purchase receipt',
  sales_return: 'Sales return',
  production_in: 'Production in',
  transfer_in: 'Transfer in',
  adjustment_in: 'Adjustment in',
  other_in: 'Other in',
  sales_delivery: 'Sales delivery',
  purchase_return: 'Purchase return',
  production_out: 'Production out',
  transfer_out: 'Transfer out',
  consumption: 'Internal use',
  scrap: 'Scrap',
  adjustment_out: 'Adjustment out',
  other_out: 'Other out',
};

export interface LedgerScope {
  readonly warehouses: readonly number[];
  readonly locations: readonly number[];
  readonly categories: readonly number[];
  readonly products: readonly number[];
}
export interface Figure {
  readonly qty: Decimal;
  readonly value: Decimal;
}
export interface LedgerRow {
  readonly product: { readonly id: number; readonly name: string; readonly uom: string };
  readonly opening: Figure;
  readonly in: Readonly<Record<InType, Figure>>;
  readonly out: Readonly<Record<OutType, Figure>>;
  readonly totalIn: Figure;
  readonly totalOut: Figure;
  readonly closing: Figure;
}
export interface MovementRow {
  readonly date: string;
  readonly reference: string;
  readonly origin: string | null;
  readonly product: { readonly id: number; readonly name: string; readonly uom: string };
  readonly from: string;
  readonly to: string;
  readonly type: MovementType;
  readonly qty: Decimal;
  readonly value: Decimal;
}
export interface StockRow {
  readonly product: { readonly id: number; readonly name: string; readonly uom: string };
  readonly location: { readonly id: number; readonly name: string };
  readonly onHand: Decimal;
  readonly reserved: Decimal;
  readonly available: Decimal;
  readonly incoming: Decimal;
  readonly outgoing: Decimal;
}

interface Place {
  readonly id: number;
  readonly name: string;
  readonly usage: string;
  readonly parent: number | null;
  readonly warehouse: number | null;
  readonly transit: boolean;
}

/** A date-only value as `YYYY-MM-DD`. */
export function isoDay(v: unknown): string {
  if (!(v instanceof Date)) return String(v ?? '').slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
}

/**
 * The locations the scope covers — the chosen locations and what is inside them, or the stock of the chosen (else
 * every) warehouses — with every location's name. Transit locations count only when chosen by name.
 */
async function insideLocations(
  env: Env,
  scope: LedgerScope,
): Promise<{ inside: Set<number>; names: Map<number, string>; places: Map<number, Place> }> {
  const loaded = await (await env.model('stock.location').search({})).load({
    parent: true,
    warehouse: true,
  });
  const all: Place[] = [...loaded].map((l) => ({
    id: l.id as number,
    name: l.fullName ?? l.name,
    usage: l.usage,
    parent: (l.parent?.id as number | undefined) ?? null,
    warehouse: (l.warehouse?.id as number | undefined) ?? null,
    transit: l.transit === true,
  }));
  const places = new Map(all.map((l) => [l.id, l]));
  const roots = new Set<number>(scope.locations);
  if (roots.size === 0)
    for (const l of all)
      if (
        l.usage === 'internal' &&
        !l.transit &&
        l.parent === null &&
        l.warehouse !== null &&
        (scope.warehouses.length === 0 || scope.warehouses.includes(l.warehouse))
      )
        roots.add(l.id);
  const inside = new Set<number>();
  for (const l of all) {
    let p: Place | undefined = l;
    for (let depth = 0; p !== undefined && depth < 30; depth += 1) {
      if (roots.has(p.id)) {
        if (!l.transit || scope.locations.includes(l.id)) inside.add(l.id);
        break;
      }
      p = p.parent === null ? undefined : places.get(p.parent);
    }
  }
  return { inside, names: new Map(all.map((l) => [l.id, l.name])), places };
}

/** Whether this person may see stock values (`stock_account` installed and the valuation readable). */
function canValue(env: Env): boolean {
  try {
    return env.access.can('stock.valuation.layer' as never, 'read');
  } catch {
    return false;
  }
}

/** The done lines whose transfer was done in `[from, to]` (both optional), in the scope's products. */
async function doneLines(env: Env, scope: LedgerScope, from: string | null, to: string | null) {
  const where: Record<string, unknown> = { 'picking.state': 'done' };
  if (from !== null && to !== null) where['picking.doneDate'] = { gte: from, lte: to };
  else if (to !== null) where['picking.doneDate'] = { lte: to };
  else if (from !== null) where['picking.doneDate'] = { gte: from };
  if (scope.products.length > 0) where['product'] = { in: scope.products };
  if (scope.categories.length > 0) where['product.category'] = { in: scope.categories };
  const found = await env.model('stock.move').search({ where: where as never, limit: 200000 });
  return found.load({
    picking: { source: true, destination: true },
    product: { uom: true },
    destination: true,
  });
}

type Line = Awaited<ReturnType<typeof doneLines>> extends Iterable<infer T> ? T : never;

/** Where a line's goods came from and went to against the scope: in, out, or inside only (null). */
function classify(
  line: Line,
  inside: Set<number>,
  places: Map<number, Place>,
): { dir: 'in'; type: InType } | { dir: 'out'; type: OutType } | null {
  const sourceId = line.picking.source.id as number;
  const destinationId = (line.destination?.id ?? line.picking.destination.id) as number;
  const sIn = inside.has(sourceId);
  const dIn = inside.has(destinationId);
  if (sIn === dIn) return null;
  if (dIn) {
    const usage = places.get(sourceId)?.usage ?? line.picking.source.usage;
    const type: InType =
      usage === 'vendor'
        ? 'purchase_receipt'
        : usage === 'customer'
          ? 'sales_return'
          : usage === 'production'
            ? 'production_in'
            : usage === 'adjustment'
              ? 'adjustment_in'
              : usage === 'internal' || usage === 'transit' || usage === 'consumption'
                ? 'transfer_in'
                : 'other_in';
    return { dir: 'in', type };
  }
  const place = places.get(destinationId);
  const usage = place?.usage ?? line.picking.destination.usage;
  const type: OutType =
    usage === 'customer'
      ? 'sales_delivery'
      : usage === 'vendor'
        ? 'purchase_return'
        : usage === 'production'
          ? 'production_out'
          : usage === 'adjustment'
            ? (place?.name ?? '').endsWith('Scrap')
              ? 'scrap'
              : 'adjustment_out'
            : usage === 'consumption'
              ? 'consumption'
              : usage === 'internal' || usage === 'transit'
                ? 'transfer_out'
                : 'other_out';
  return { dir: 'out', type };
}

/** Each line's value as it moved (signed), from the valuation when readable, else at the product's cost. */
async function valuesOf(
  env: Env,
  lines: readonly Line[],
  valued: boolean,
): Promise<Map<number, Decimal>> {
  const out = new Map<number, Decimal>();
  if (!valued) return out;
  const ids = lines.map((l) => l.id as number);
  const given = new Map<number, Decimal>();
  for (let i = 0; i < ids.length; i += 2000) {
    const chunk = ids.slice(i, i + 2000);
    const values = await env
      .model('stock.move')
      .browse(chunk as never)
      .moveValues();
    for (const [id, v] of values) given.set(id, orm.toDecimal(v));
  }
  for (const l of lines) {
    const v = given.get(l.id as number);
    if (v !== undefined && !v.eq(0)) out.set(l.id as number, v.abs());
    else out.set(l.id as number, (l.doneQty ?? zero).times(l.product.standardPrice ?? zero).abs());
  }
  return out;
}

const figure = (): { qty: Decimal; value: Decimal } => ({ qty: zero, value: zero });
const add = (f: { qty: Decimal; value: Decimal }, qty: Decimal, value: Decimal) => {
  f.qty = f.qty.plus(qty);
  f.value = f.value.plus(value);
};
const productOf = (l: Line) => ({
  id: l.product.id as number,
  name: l.product.name,
  uom: l.product.uom?.name ?? '',
});

/** The ledger's summary: per product, opening, in and out by type, closing. */
export async function ledgerSummary(
  env: Env,
  scope: LedgerScope,
  from: string,
  to: string,
): Promise<{ valued: boolean; rows: LedgerRow[] }> {
  const valued = canValue(env);
  const { inside, places } = await insideLocations(env, scope);
  const before = [...(await doneLines(env, scope, null, isoDay(dayBefore(from))))];
  const during = [...(await doneLines(env, scope, from, to))];
  const values = await valuesOf(env, [...before, ...during], valued);
  type Row = {
    product: LedgerRow['product'];
    opening: { qty: Decimal; value: Decimal };
    in: Record<InType, { qty: Decimal; value: Decimal }>;
    out: Record<OutType, { qty: Decimal; value: Decimal }>;
  };
  const rows = new Map<number, Row>();
  const rowOf = (l: Line): Row => {
    const id = l.product.id as number;
    let r = rows.get(id);
    if (r === undefined) {
      r = {
        product: productOf(l),
        opening: figure(),
        in: Object.fromEntries(IN_TYPES.map((t) => [t, figure()])) as Row['in'],
        out: Object.fromEntries(OUT_TYPES.map((t) => [t, figure()])) as Row['out'],
      };
      rows.set(id, r);
    }
    return r;
  };
  for (const l of before) {
    const c = classify(l, inside, places);
    if (c === null) continue;
    const qty = l.doneQty ?? zero;
    const value = values.get(l.id as number) ?? zero;
    const r = rowOf(l);
    add(r.opening, c.dir === 'in' ? qty : qty.negated(), c.dir === 'in' ? value : value.negated());
  }
  for (const l of during) {
    const c = classify(l, inside, places);
    if (c === null) continue;
    const r = rowOf(l);
    const qty = l.doneQty ?? zero;
    const value = values.get(l.id as number) ?? zero;
    if (c.dir === 'in') add(r.in[c.type], qty, value);
    else add(r.out[c.type], qty, value);
  }
  const out: LedgerRow[] = [...rows.values()]
    .map((r) => {
      const totalIn = figure();
      const totalOut = figure();
      for (const t of IN_TYPES) add(totalIn, r.in[t].qty, r.in[t].value);
      for (const t of OUT_TYPES) add(totalOut, r.out[t].qty, r.out[t].value);
      const closing = {
        qty: r.opening.qty.plus(totalIn.qty).minus(totalOut.qty),
        value: r.opening.value.plus(totalIn.value).minus(totalOut.value),
      };
      return { ...r, totalIn, totalOut, closing };
    })
    .filter((r) => !r.opening.qty.eq(0) || !r.totalIn.qty.eq(0) || !r.totalOut.qty.eq(0))
    .sort((a, b) => a.product.name.localeCompare(b.product.name));
  return { valued, rows: out };
}

/** The ledger's details: every movement of the period in the scope. */
export async function ledgerDetails(
  env: Env,
  scope: LedgerScope,
  from: string,
  to: string,
): Promise<{ valued: boolean; rows: MovementRow[] }> {
  const valued = canValue(env);
  const { inside, names, places } = await insideLocations(env, scope);
  const during = [...(await doneLines(env, scope, from, to))];
  const values = await valuesOf(env, during, valued);
  const rows: MovementRow[] = [];
  for (const l of during) {
    const c = classify(l, inside, places);
    if (c === null) continue;
    const qty = l.doneQty ?? zero;
    const value = values.get(l.id as number) ?? zero;
    const destination = (l.destination?.id ?? l.picking.destination.id) as number;
    rows.push({
      date: isoDay(l.picking.doneDate),
      reference: l.picking.name,
      origin: l.picking.origin ?? null,
      product: productOf(l),
      from: names.get(l.picking.source.id as number) ?? '',
      to: names.get(destination) ?? '',
      type: c.type,
      qty: c.dir === 'in' ? qty : qty.negated(),
      value: c.dir === 'in' ? value : value.negated(),
    });
  }
  rows.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.reference.localeCompare(b.reference) ||
      a.product.name.localeCompare(b.product.name),
  );
  return { valued, rows };
}

/** The stock report: on hand, reserved, available, incoming and outgoing per product and location in the scope. */
export async function stockReport(env: Env, scope: LedgerScope): Promise<StockRow[]> {
  const { inside, names } = await insideLocations(env, scope);
  const where: Record<string, unknown> = { location: { in: [...inside] } };
  if (scope.products.length > 0) where['product'] = { in: scope.products };
  if (scope.categories.length > 0) where['product.category'] = { in: scope.categories };
  const quants = await (
    await env.model('stock.quant').search({ where: where as never, limit: 200000 })
  ).load({ product: { uom: true }, location: true });
  type Row = {
    product: StockRow['product'];
    location: StockRow['location'];
    onHand: Decimal;
    reserved: Decimal;
    incoming: Decimal;
    outgoing: Decimal;
  };
  const rows = new Map<string, Row>();
  const rowOf = (product: StockRow['product'], location: StockRow['location']): Row => {
    const key = `${product.id}:${location.id}`;
    let r = rows.get(key);
    if (r === undefined) {
      r = { product, location, onHand: zero, reserved: zero, incoming: zero, outgoing: zero };
      rows.set(key, r);
    }
    return r;
  };
  for (const q of quants) {
    const r = rowOf(
      { id: q.product.id as number, name: q.product.name, uom: q.product.uom?.name ?? '' },
      { id: q.location.id as number, name: names.get(q.location.id as number) ?? '' },
    );
    r.onHand = r.onHand.plus(q.quantity);
    r.reserved = r.reserved.plus(q.reserved ?? zero);
  }
  // What confirmed transfers will bring in or take out.
  const openWhere: Record<string, unknown> = { 'picking.state': 'confirmed' };
  if (scope.products.length > 0) openWhere['product'] = { in: scope.products };
  if (scope.categories.length > 0) openWhere['product.category'] = { in: scope.categories };
  const open = await (
    await env.model('stock.move').search({ where: openWhere as never, limit: 200000 })
  ).load({
    picking: { source: true, destination: true },
    product: { uom: true },
    destination: true,
  });
  for (const m of open) {
    const sourceId = m.picking.source.id as number;
    const destinationId = (m.destination?.id ?? m.picking.destination.id) as number;
    const sIn = inside.has(sourceId);
    const dIn = inside.has(destinationId);
    if (sIn === dIn) continue;
    const product = {
      id: m.product.id as number,
      name: m.product.name,
      uom: m.product.uom?.name ?? '',
    };
    const at = dIn ? destinationId : sourceId;
    const r = rowOf(product, { id: at, name: names.get(at) ?? '' });
    const qty = m.productQty ?? m.quantity;
    if (dIn) r.incoming = r.incoming.plus(qty);
    else r.outgoing = r.outgoing.plus(qty);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, available: r.onHand.minus(r.reserved) }))
    .filter((r) => !r.onHand.eq(0) || !r.incoming.eq(0) || !r.outgoing.eq(0))
    .sort(
      (a, b) =>
        a.product.name.localeCompare(b.product.name) ||
        a.location.name.localeCompare(b.location.name),
    );
}

function dayBefore(day: string): Date {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return d;
}

// ---------------------------------------------------------------------------------------------------- HTTP

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ints = (v: unknown): number[] =>
  typeof v === 'string' && v !== ''
    ? v
        .split(',')
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0)
    : [];
const money = (d: Decimal): string => d.toFixed(2);
const qtyText = (d: Decimal): string => d.toFixed(3);
const esc = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );
const isDecimal = (v: unknown): v is Decimal =>
  typeof v === 'object' && v !== null && typeof (v as Decimal).toFixed === 'function';

/** The table of a report as rows of cells (the first the header), for XLSX and PDF. */
function tableOf(
  kind: 'summary' | 'details' | 'stock',
  data: { valued: boolean; rows: readonly (LedgerRow | MovementRow | StockRow)[] },
): (string | Decimal)[][] {
  if (kind === 'summary') {
    const head = ['Product', 'Unit', 'Opening'];
    for (const t of IN_TYPES) head.push(TYPE_LABELS[t]);
    head.push('Total in');
    for (const t of OUT_TYPES) head.push(TYPE_LABELS[t]);
    head.push('Total out', 'Closing');
    if (data.valued) head.push('Opening value', 'Value in', 'Value out', 'Closing value');
    return [
      head,
      ...(data.rows as LedgerRow[]).map((r) => {
        const row: (string | Decimal)[] = [r.product.name, r.product.uom, r.opening.qty];
        for (const t of IN_TYPES) row.push(r.in[t].qty);
        row.push(r.totalIn.qty);
        for (const t of OUT_TYPES) row.push(r.out[t].qty);
        row.push(r.totalOut.qty, r.closing.qty);
        if (data.valued)
          row.push(r.opening.value, r.totalIn.value, r.totalOut.value, r.closing.value);
        return row;
      }),
    ];
  }
  if (kind === 'details')
    return [
      [
        'Date',
        'Reference',
        'Source document',
        'Product',
        'Unit',
        'From',
        'To',
        'Movement',
        'Quantity',
        ...(data.valued ? ['Value'] : []),
      ],
      ...(data.rows as MovementRow[]).map((r) => [
        r.date,
        r.reference,
        r.origin ?? '',
        r.product.name,
        r.product.uom,
        r.from,
        r.to,
        TYPE_LABELS[r.type],
        r.qty,
        ...(data.valued ? [r.value] : []),
      ]),
    ];
  return [
    ['Product', 'Unit', 'Location', 'On hand', 'Reserved', 'Available', 'Incoming', 'Outgoing'],
    ...(data.rows as StockRow[]).map((r) => [
      r.product.name,
      r.product.uom,
      r.location.name,
      r.onHand,
      r.reserved,
      r.available,
      r.incoming,
      r.outgoing,
    ]),
  ];
}

function sheetOf(name: string, rows: (string | Decimal)[][], currency: string): Sheet {
  const format = moneyFormat(currency);
  const valueColumns = new Set(
    (rows[0] ?? []).map((h, i) => (String(h).toLowerCase().includes('value') ? i : -1)),
  );
  return {
    name,
    rows: rows.map((r, i): Cell[] =>
      r.map((v, j) => {
        if (isDecimal(v))
          return valueColumns.has(j) ? { decimal: money(v), format } : Number(qtyText(v));
        return i === 0 ? { text: String(v), bold: true } : String(v);
      }),
    ),
    headerRows: 1,
    widths: (rows[0] ?? []).map((h, i) =>
      i === 0 ? 32 : Math.max(10, Math.min(18, String(h).length + 2)),
    ),
  };
}

function htmlOf(
  title: string,
  subtitle: string,
  rows: (string | Decimal)[][],
  locale: string,
): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  const cell = (v: string | Decimal, tag: 'td' | 'th') =>
    isDecimal(v)
      ? `<${tag} class="n">${number.format(Number(v.toFixed(3)))}</${tag}>`
      : `<${tag}>${esc(v)}</${tag}>`;
  const [head, ...body] = rows;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body { font: 8pt system-ui, sans-serif; color: #111; }
h1 { font-size: 13pt; margin: 0 0 2mm; } p { margin: 0 0 4mm; }
table { width: 100%; border-collapse: collapse; }
th, td { border-bottom: 1px solid #ccc; padding: 1mm 1.2mm; text-align: start; vertical-align: top; }
th { background: #f2f2f2; } .n { text-align: end; white-space: nowrap; }
</style></head><body><h1>${esc(title)}</h1><p>${esc(subtitle)}</p><table><thead><tr>${(head ?? [])
    .map((v) => cell(v, 'th'))
    .join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((v) => cell(v, 'td')).join('')}</tr>`)
    .join('')}</tbody></table></body></html>`;
}

const figureJson = (f: Figure) => ({ qty: qtyText(f.qty), value: money(f.value) });

export function registerLedgerRoutes(context: ModuleContext): void {
  const { app } = context;
  const scopeOf = (query: Record<string, unknown>): LedgerScope => ({
    warehouses: ints(query['warehouses']),
    locations: ints(query['locations']),
    categories: ints(query['categories']),
    products: ints(query['products']),
  });
  const serve = async (
    request: FastifyRequest,
    reply: FastifyReply,
    kind: 'summary' | 'details' | 'stock',
    filename: string,
    compute: (
      env: Env,
    ) => Promise<{ valued: boolean; rows: (LedgerRow | MovementRow | StockRow)[] }>,
    json: (data: { valued: boolean; rows: (LedgerRow | MovementRow | StockRow)[] }) => unknown,
    subtitle: string,
  ) => {
    const query = request.query as Record<string, unknown>;
    const format =
      query['format'] === 'xlsx' || query['format'] === 'pdf' ? query['format'] : 'json';
    const out = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        env.access.check('stock.move', format === 'json' ? 'read' : 'export');
        const data = await compute(env);
        if (format === 'json') return { json: json(data) };
        await audit(raw, {
          kind: 'data.export',
          summary: `Exported the stock ${kind === 'stock' ? 'report' : 'ledger'} as ${format}.`,
          targetModel: 'stock.move',
          details: { kind, query },
          ip: request.ip,
        });
        const [company] = await env
          .model('res.company')
          .search({ where: { id: env.companyRef }, limit: 1 })
          .then((c) => c.load({ currency: ['name'] }));
        return {
          rows: tableOf(kind, data),
          company: {
            name: company?.name ?? '',
            currency: company?.currency.name ?? 'BDT',
            locale: company?.numberGrouping === 'lakh' ? 'en-IN' : 'en-US',
          },
        };
      },
      { write: format !== 'json' },
    );
    if ('json' in out) return out.json;
    const title = kind === 'stock' ? 'Stock report' : 'Stock ledger';
    const content =
      format === 'xlsx'
        ? workbook([sheetOf(title, out.rows, out.company.currency)])
        : await renderPdf(
            htmlOf(title, `${out.company.name} · ${subtitle}`, out.rows, out.company.locale),
            {
              paper: 'A4',
              orientation: 'landscape',
              blocks: [],
            },
          );
    await reply
      .type(
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
      )
      .header('content-disposition', `attachment; filename="${filename}.${format}"`)
      .send(content);
    return reply;
  };

  app.get('/api/v1/stockroom/ledger', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const from = typeof query['from'] === 'string' ? query['from'] : '';
    const to = typeof query['to'] === 'string' ? query['to'] : '';
    if (!DAY.test(from) || !DAY.test(to) || from > to)
      throw new HttpProblem(
        400,
        'invalid-period',
        'Invalid period',
        'Give from and to as YYYY-MM-DD, from first.',
      );
    const mode = query['mode'] === 'details' ? 'details' : 'summary';
    const scope = scopeOf(query);
    return serve(
      request,
      reply,
      mode,
      `stock-ledger-${from}-${to}`,
      (env) =>
        mode === 'details'
          ? ledgerDetails(env, scope, from, to)
          : ledgerSummary(env, scope, from, to),
      (data) => ({
        valued: data.valued,
        from,
        to,
        mode,
        rows:
          mode === 'details'
            ? (data.rows as MovementRow[]).map((r) => ({
                ...r,
                qty: qtyText(r.qty),
                value: money(r.value),
              }))
            : (data.rows as LedgerRow[]).map((r) => ({
                product: r.product,
                opening: figureJson(r.opening),
                in: Object.fromEntries(IN_TYPES.map((t) => [t, figureJson(r.in[t])])),
                out: Object.fromEntries(OUT_TYPES.map((t) => [t, figureJson(r.out[t])])),
                totalIn: figureJson(r.totalIn),
                totalOut: figureJson(r.totalOut),
                closing: figureJson(r.closing),
              })),
      }),
      `${from} – ${to}`,
    );
  });

  app.get('/api/v1/stockroom/stock', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const scope = scopeOf(query);
    return serve(
      request,
      reply,
      'stock',
      'stock-report',
      async (env) => ({ valued: false, rows: await stockReport(env, scope) }),
      (data) => ({
        rows: (data.rows as StockRow[]).map((r) => ({
          product: r.product,
          location: r.location,
          onHand: qtyText(r.onHand),
          reserved: qtyText(r.reserved),
          available: qtyText(r.available),
          incoming: qtyText(r.incoming),
          outgoing: qtyText(r.outgoing),
        })),
      }),
      isoDay(new Date()),
    );
  });
}
