/**
 * The Mushak registers and return over HTTP (RFC 0016 §5.3): `GET /api/v1/l10n_bd/mushak/:form?month=2026-10` for
 * 6.1 (purchases), 6.2 (sales) and 9.1 (the monthly return's summary), as JSON for the screen, or with
 * `format=xlsx` / `format=pdf` as a file. As the user: reading needs the documents' read right, a file their export
 * right, and every file is in the audit log.
 */
import { type Cell, moneyFormat, renderPdf, type Sheet, workbook } from '@kosh/reporting';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from './.kosh/bindings.js';
import {
  type Band,
  MonthError,
  monthRange,
  type RegisterRow,
  type Return91,
  register,
  return91,
  VAT_CATEGORIES,
  type VatCategory,
} from './mushak.js';

type Decimal = RegisterRow['value'];
export type MushakForm = '6.1' | '6.2' | '9.1';

const TITLES: Record<MushakForm, string> = {
  '6.1': 'Purchase register',
  '6.2': 'Sales register',
  '9.1': 'Monthly return (summary)',
};
const BANDS: Record<VatCategory, string> = {
  standard: 'Standard rate (15 %)',
  reduced: 'Reduced rates',
  zero: 'Zero-rated',
  exempt: 'Exempt',
  unclassified: 'Without a Mushak VAT kind',
};

const money = (d: Decimal): string => d.toFixed(2);

/** The JSON of a register row. */
const rowJson = (r: RegisterRow) => ({
  ...r,
  quantity: r.quantity.toString(),
  value: money(r.value),
  sd: money(r.sd),
  vat: money(r.vat),
  total: money(r.total),
});

const bandJson = (b: Band) => ({ value: money(b.value), sd: money(b.sd), vat: money(b.vat) });
const bandsJson = (bs: Readonly<Record<VatCategory, Band>>) =>
  Object.fromEntries(VAT_CATEGORIES.map((c) => [c, bandJson(bs[c])]));

const returnJson = (r: Return91) => ({
  month: r.month,
  supplies: bandsJson(r.supplies),
  purchases: bandsJson(r.purchases),
  vdsDeducted: money(r.vdsDeducted),
  vdsByCustomers: money(r.vdsByCustomers),
  advanceTax: money(r.advanceTax),
  outputVat: money(r.outputVat),
  inputVat: money(r.inputVat),
  sdPayable: money(r.sdPayable),
  netVat: money(r.netVat),
});

/** The form as a table: a header row, then rows of text and amounts. */
function table(form: MushakForm, data: readonly RegisterRow[] | Return91): (string | Decimal)[][] {
  if (form !== '9.1') {
    const partner = form === '6.2' ? 'Customer' : 'Supplier';
    return [
      [
        'No.',
        'Date',
        'Invoice or note',
        partner,
        'BIN',
        'Description',
        'Quantity',
        'Value',
        'SD',
        'VAT',
        'Total',
        'VAT band',
      ],
      ...(data as readonly RegisterRow[]).map((r, i) => [
        String(i + 1),
        r.date,
        r.number,
        r.partner,
        r.bin ?? '',
        r.description,
        r.quantity.toString(),
        r.value,
        r.sd,
        r.vat,
        r.total,
        BANDS[r.category],
      ]),
    ];
  }
  const r = data as Return91;
  const bandRows = (bs: Readonly<Record<VatCategory, Band>>) =>
    VAT_CATEGORIES.map((c) => [BANDS[c], bs[c].value, bs[c].sd, bs[c].vat]);
  return [
    ['', 'Value', 'SD', 'VAT'],
    ['Part 3 — supplies (output tax)', '', '', ''],
    ...bandRows(r.supplies),
    ['Part 4 — purchases (input tax)', '', '', ''],
    ...bandRows(r.purchases),
    ['Part 5 — increasing adjustments', '', '', ''],
    ['VAT deducted at source from suppliers', '', '', r.vdsDeducted],
    ['Part 6 — decreasing adjustments', '', '', ''],
    ['VAT deducted at source by customers', '', '', r.vdsByCustomers],
    ['Advance tax paid on imports', '', '', r.advanceTax],
    ['Part 7 — net tax', '', '', ''],
    ['Output VAT', '', '', r.outputVat],
    ['Input VAT', '', '', r.inputVat],
    ['Supplementary duty payable', '', r.sdPayable, ''],
    ['Net VAT payable (negative: carried forward)', '', '', r.netVat],
  ];
}

const isDecimal = (v: string | Decimal): v is Decimal => typeof v !== 'string';

function sheet(
  form: MushakForm,
  month: string,
  rows: (string | Decimal)[][],
  currency: string,
): Sheet {
  const format = moneyFormat(currency);
  return {
    name: `Mushak ${form} ${month}`,
    rows: rows.map((row, i) =>
      row.map((v): Cell => {
        if (isDecimal(v)) return { decimal: v.toFixed(2), format };
        // 9.1's part headings (a text in the first column only) are bold.
        if (i > 0 && form === '9.1' && v.startsWith('Part ')) return { text: v, bold: true };
        return v;
      }),
    ),
    widths: form === '9.1' ? [48, 16, 16, 16] : [6, 12, 18, 28, 16, 32, 10, 14, 12, 12, 14, 22],
  };
}

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  );

function html(
  form: MushakForm,
  month: string,
  company: { name: string; bin: string | null },
  rows: (string | Decimal)[][],
  locale: string,
): string {
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const cell = (v: string | Decimal, tag: 'td' | 'th') =>
    isDecimal(v)
      ? `<${tag} class="n">${number.format(Number(v.toFixed(2)))}</${tag}>`
      : `<${tag}>${esc(v)}</${tag}>`;
  const [head, ...body] = rows;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mushak ${form} ${month}</title><style>
body { font: 9pt system-ui, sans-serif; color: #111; }
h1 { font-size: 14pt; margin: 0 0 2mm; } p { margin: 0 0 4mm; }
table { width: 100%; border-collapse: collapse; }
th, td { border-bottom: 1px solid #ccc; padding: 1.2mm 1.5mm; text-align: start; vertical-align: top; }
th { background: #f2f2f2; } .n { text-align: end; white-space: nowrap; }
</style></head><body><h1>Mushak ${form} — ${TITLES[form]}</h1><p>${esc(company.name)}${
    company.bin === null ? '' : ` · BIN ${esc(company.bin)}`
  } · ${month}</p><table><thead><tr>${(head ?? []).map((v) => cell(v, 'th')).join('')}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((v) => cell(v, 'td')).join('')}</tr>`)
    .join('')}</tbody></table></body></html>`;
}

export function registerMushakRoutes(context: ModuleContext): void {
  context.app.get('/api/v1/l10n_bd/mushak/:form', async (request, reply) => {
    const form = (request.params as { form?: string }).form;
    if (form !== '6.1' && form !== '6.2' && form !== '9.1')
      throw new HttpProblem(404, 'unknown-form', 'Unknown form', 'The forms are 6.1, 6.2 and 9.1.');
    const query = request.query as { month?: unknown; format?: unknown };
    const month = typeof query.month === 'string' ? query.month : '';
    const format = query.format === 'xlsx' || query.format === 'pdf' ? query.format : 'json';
    try {
      monthRange(month);
    } catch (error) {
      if (error instanceof MonthError)
        throw new HttpProblem(400, 'invalid-month', 'Invalid month', error.message);
      throw error;
    }
    const out = await request.env(
      async (raw) => {
        const env = raw as unknown as Env;
        env.access.check('account.move', format === 'json' ? 'read' : 'export');
        const data =
          form === '9.1'
            ? await return91(env, month)
            : await register(env, form === '6.2' ? 'sales' : 'purchases', month);
        if (format === 'json')
          return {
            json:
              form === '9.1'
                ? returnJson(data as Return91)
                : { rows: (data as RegisterRow[]).map(rowJson) },
          };
        await audit(raw, {
          kind: 'data.export',
          summary: `Exported Mushak ${form} for ${month} as ${format}.`,
          targetModel: 'account.move',
          details: { form, month },
          ip: request.ip,
        });
        const [company] = await env
          .model('res.company')
          .search({ where: { id: env.companyRef }, limit: 1 })
          .then((c) => c.load({ currency: ['name'] }));
        return {
          rows: table(form, data),
          company: {
            name: company?.name ?? '',
            bin: company?.bin ?? null,
            currency: company?.currency.name ?? 'BDT',
            locale: company?.numberGrouping === 'lakh' ? 'en-IN' : 'en-US',
          },
        };
        // A file is an export: its audit event is written.
      },
      { write: format !== 'json' },
    );
    if ('json' in out) return out.json;
    const filename = `mushak-${form}-${month}.${format}`;
    const content =
      format === 'xlsx'
        ? workbook([sheet(form, month, out.rows, out.company.currency)])
        : await renderPdf(html(form, month, out.company, out.rows, out.company.locale), {
            paper: 'A4',
            orientation: form === '9.1' ? 'portrait' : 'landscape',
            blocks: [],
          });
    await reply
      .type(
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
      )
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(content);
    return reply;
  });
}
