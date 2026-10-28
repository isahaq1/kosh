/**
 * The GST returns over HTTP (RFC 0016 step 5, part 3): `GET /api/v1/l10n_in/gstr/1?month=2026-10` and
 * `/gstr/3b?month=…`, as JSON for the screen, or with `format=xlsx` / `format=pdf` as a file, and GSTR-1 with
 * `format=portal` as the GST portal's offline JSON. As the user: reading needs the documents' read right, a file
 * their export right, and every file is in the audit log.
 */
import { type Cell, moneyFormat, renderPdf, type Sheet, workbook } from '@kosh/reporting';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import {
  type Gstr1,
  type Gstr1Document,
  type Gstr3b,
  gstr1,
  gstr1PortalJson,
  gstr3b,
  type Heads,
  MonthError,
  monthRange,
} from './gstr.js';

type Decimal = Heads['txval'];
type Value = string | Decimal;
const isDecimal = (v: Value): v is Decimal => typeof v !== 'string';

/** The JSON of a return: decimals as strings (amounts with two decimals). */
function plain(value: unknown, key = ''): unknown {
  if (value instanceof orm.Decimal)
    return key === 'rate' || key === 'quantity' ? value.toString() : value.toFixed(2);
  if (Array.isArray(value)) return value.map((v) => plain(v));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v, k)]));
  return value;
}

const HEADS = ['Taxable value', 'IGST', 'CGST', 'SGST', 'Cess'];
const heads = (h: Heads): Value[] => [h.txval, h.iamt, h.camt, h.samt, h.csamt];
const total = (docs: readonly Gstr1Document[]) =>
  docs.reduce<Heads>(
    (s, d) =>
      d.items.reduce(
        (t, i) => ({
          txval: t.txval.plus(i.txval),
          iamt: t.iamt.plus(i.iamt),
          camt: t.camt.plus(i.camt),
          samt: t.samt.plus(i.samt),
          csamt: t.csamt.plus(i.csamt),
        }),
        s,
      ),
    {
      txval: orm.toDecimal(0),
      iamt: orm.toDecimal(0),
      camt: orm.toDecimal(0),
      samt: orm.toDecimal(0),
      csamt: orm.toDecimal(0),
    },
  );

const SECTIONS = {
  b2b: '4A B2B invoices',
  b2cl: '5 B2C large invoices',
  exp: '6A Exports',
  b2cs: '7 B2C others',
  cdnr: '9B Credit / debit notes (registered)',
  cdnur: '9B Credit / debit notes (unregistered)',
} as const;

/** GSTR-1's sections: the documents (or B2C rows) of each, and their totals by head. */
export function gstr1Summary(
  r: Gstr1,
): (Heads & { readonly section: keyof typeof SECTIONS; readonly documents: number })[] {
  const b2cs = r.b2cs.reduce<Heads>(
    (s, x) => ({
      txval: s.txval.plus(x.txval),
      iamt: s.iamt.plus(x.iamt),
      camt: s.camt.plus(x.camt),
      samt: s.samt.plus(x.samt),
      csamt: s.csamt.plus(x.csamt),
    }),
    total([]),
  );
  return [
    { section: 'b2b', documents: r.b2b.length, ...total(r.b2b) },
    { section: 'b2cl', documents: r.b2cl.length, ...total(r.b2cl) },
    { section: 'exp', documents: r.exp.length, ...total(r.exp) },
    { section: 'b2cs', documents: r.b2cs.length, ...b2cs },
    { section: 'cdnr', documents: r.cdnr.length, ...total(r.cdnr) },
    { section: 'cdnur', documents: r.cdnur.length, ...total(r.cdnur) },
  ];
}

/** GSTR-1's sections as tables (the workbook's sheets; the first is the summary). */
function gstr1Tables(r: Gstr1): { name: string; rows: Value[][] }[] {
  const docRows = (docs: readonly Gstr1Document[], withGstin: boolean) => [
    [
      ...(withGstin ? ['GSTIN of recipient'] : []),
      'Name',
      'Number',
      'Date',
      'Value',
      'Place of supply',
      'Reverse charge',
      'Rate %',
      ...HEADS,
    ],
    ...docs.flatMap((d) =>
      d.items.map((i) => [
        ...(withGstin ? [d.gstin ?? ''] : []),
        d.partner,
        `${d.noteType === undefined ? '' : `${d.noteType === 'C' ? 'Credit' : 'Debit'} note `}${d.number}`,
        d.date,
        d.value,
        d.pos,
        d.reverseCharge ? 'Y' : 'N',
        i.rate.toString(),
        ...heads(i),
      ]),
    ),
  ];
  return [
    {
      name: 'Summary',
      rows: [
        ['Section', 'Documents', ...HEADS],
        ...gstr1Summary(r).map((s) => [SECTIONS[s.section], String(s.documents), ...heads(s)]),
      ],
    },
    { name: 'b2b', rows: docRows(r.b2b, true) },
    { name: 'b2cl', rows: docRows(r.b2cl, false) },
    {
      name: 'b2cs',
      rows: [
        ['Type', 'Place of supply', 'Rate %', ...HEADS],
        ...r.b2cs.map((s) => [s.supply, s.pos, s.rate.toString(), ...heads(s)]),
      ],
    },
    { name: 'exp', rows: docRows(r.exp, false) },
    { name: 'cdnr', rows: docRows(r.cdnr, true) },
    { name: 'cdnur', rows: docRows(r.cdnur, false) },
    {
      name: 'nil',
      rows: [
        ['Supply', 'Nil-rated', 'Exempt', 'Non-GST'],
        ...r.nil.map((n) => [n.supply, n.nil, n.exempt, n.nonGst]),
      ],
    },
    {
      name: 'hsn',
      rows: [
        ['HSN / SAC', 'Description', 'Quantity', 'Rate %', ...HEADS],
        ...r.hsn.map((h) => [
          h.hsn,
          h.description,
          h.quantity.toString(),
          h.rate.toString(),
          ...heads(h),
        ]),
      ],
    },
  ];
}

function gstr3bTable(r: Gstr3b): Value[][] {
  return [
    ['', ...HEADS],
    ['3.1 (a) Outward taxable supplies', ...heads(r.outwardTaxable)],
    ['3.1 (b) Outward zero-rated supplies', ...heads(r.outwardZeroRated)],
    ['3.1 (c) Other outward supplies (nil-rated, exempt)', ...heads(r.outwardNilExempt)],
    ['3.1 (d) Inward supplies liable to reverse charge', ...heads(r.inwardReverseCharge)],
    ['3.1 (e) Non-GST outward supplies', ...heads(r.outwardNonGst)],
    ['4 (A)(3) ITC: inward supplies liable to reverse charge', ...heads(r.itcReverseCharge)],
    ['4 (A)(5) ITC: all other', ...heads(r.itcOther)],
    [
      '5 Exempt, nil and non-GST inward supplies: from another state',
      r.inwardExempt.inter,
      '',
      '',
      '',
      '',
    ],
    [
      '5 Exempt, nil and non-GST inward supplies: within the state',
      r.inwardExempt.intra,
      '',
      '',
      '',
      '',
    ],
    [
      '6.1 Tax payable',
      '',
      r.payable.igst.tax,
      r.payable.cgst.tax,
      r.payable.sgst.tax,
      r.payable.cess.tax,
    ],
    [
      '6.1 Input tax credit',
      '',
      r.payable.igst.credit,
      r.payable.cgst.credit,
      r.payable.sgst.credit,
      r.payable.cess.credit,
    ],
    [
      '6.1 To pay (negative: carried forward)',
      '',
      r.payable.igst.net,
      r.payable.cgst.net,
      r.payable.sgst.net,
      r.payable.cess.net,
    ],
  ];
}

const sheet = (name: string, rows: Value[][]): Sheet => {
  const format = moneyFormat('INR');
  return {
    name,
    rows: rows.map((row) =>
      row.map((v): Cell => (isDecimal(v) ? { decimal: v.toFixed(2), format } : v)),
    ),
  };
};

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

function html(
  title: string,
  subtitle: string,
  tables: { name: string; rows: Value[][] }[],
): string {
  const number = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const cell = (v: Value, tag: 'td' | 'th') =>
    isDecimal(v)
      ? `<${tag} class="n">${number.format(Number(v.toFixed(2)))}</${tag}>`
      : `<${tag}>${esc(v)}</${tag}>`;
  const body = tables
    .filter((t) => t.rows.length > 1)
    .map(
      (t) =>
        `<h2>${esc(t.name)}</h2><table><thead><tr>${(t.rows[0] ?? []).map((v) => cell(v, 'th')).join('')}</tr></thead><tbody>${t.rows
          .slice(1)
          .map((r) => `<tr>${r.map((v) => cell(v, 'td')).join('')}</tr>`)
          .join('')}</tbody></table>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body { font: 8.5pt system-ui, sans-serif; color: #111; }
h1 { font-size: 14pt; margin: 0 0 2mm; } h2 { font-size: 10pt; margin: 5mm 0 1mm; } p { margin: 0 0 3mm; }
table { width: 100%; border-collapse: collapse; }
th, td { border-bottom: 1px solid #ccc; padding: 1mm 1.5mm; text-align: start; vertical-align: top; }
th { background: #f2f2f2; } .n { text-align: end; white-space: nowrap; }
</style></head><body><h1>${esc(title)}</h1><p>${esc(subtitle)}</p>${body}</body></html>`;
}

export function registerGstRoutes(context: ModuleContext): void {
  context.app.get('/api/v1/l10n_in/gstr/:form', async (request, reply) => {
    const form = (request.params as { form?: string }).form;
    if (form !== '1' && form !== '3b')
      throw new HttpProblem(404, 'unknown-form', 'Unknown return', 'The returns are 1 and 3b.');
    const query = request.query as { month?: unknown; format?: unknown };
    const month = typeof query.month === 'string' ? query.month : '';
    const format =
      query.format === 'xlsx' ||
      query.format === 'pdf' ||
      (query.format === 'portal' && form === '1')
        ? query.format
        : 'json';
    try {
      monthRange(month);
    } catch (error) {
      if (error instanceof MonthError)
        throw new HttpProblem(400, 'invalid-month', 'Invalid month', error.message);
      throw error;
    }
    const data = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        env.access.check('account.move', format === 'json' ? 'read' : 'export');
        const result = form === '1' ? await gstr1(env, month) : await gstr3b(env, month);
        if (format !== 'json')
          await audit(raw, {
            kind: 'data.export',
            summary: `Exported GSTR-${form.toUpperCase()} for ${month} as ${format}.`,
            targetModel: 'account.move',
            details: { form, month },
            ip: request.ip,
          });
        return result;
      },
      // A file is an export: its audit event is written.
      { write: format !== 'json' },
    );
    if (format === 'json')
      return form === '1'
        ? { ...(plain(data) as object), summary: plain(gstr1Summary(data as Gstr1)) }
        : plain(data);
    const title = `GSTR-${form.toUpperCase()}`;
    const tables =
      form === '1'
        ? gstr1Tables(data as Gstr1)
        : [{ name: 'GSTR-3B', rows: gstr3bTable(data as Gstr3b) }];
    const [y, m] = month.split('-') as [string, string];
    const name = `${title}_${data.gstin ?? 'GSTIN'}_${m}${y}`;
    if (format === 'portal') {
      await reply
        .type('application/json')
        .header('content-disposition', `attachment; filename="${name}.json"`)
        .send(JSON.stringify(gstr1PortalJson(data as Gstr1)));
      return reply;
    }
    const content =
      format === 'xlsx'
        ? workbook(tables.map((t) => sheet(t.name, t.rows)))
        : await renderPdf(html(title, `GSTIN ${data.gstin ?? '—'} · ${month}`, tables), {
            paper: 'A4',
            orientation: 'landscape',
            blocks: [],
          });
    await reply
      .type(
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
      )
      .header('content-disposition', `attachment; filename="${name}.${format}"`)
      .send(content);
    return reply;
  });
}
