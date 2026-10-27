/**
 * Accounting › Reporting › Mushak returns (RFC 0016 §5.3): the sales register (6.2), the purchase register (6.1) and
 * the monthly return's summary (9.1) of a month, as the server computes them, with their XLSX and PDF files.
 */
import { ApiError, Button, Input, Label, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Form = '6.2' | '6.1' | '9.1';
const FORMS: readonly Form[] = ['6.2', '6.1', '9.1'];
const BANDS = ['standard', 'reduced', 'zero', 'exempt', 'unclassified'] as const;
type Band = (typeof BANDS)[number];

interface Row {
  readonly date: string;
  readonly number: string;
  readonly refund: boolean;
  readonly partner: string;
  readonly bin: string | null;
  readonly description: string;
  readonly value: string;
  readonly sd: string;
  readonly vat: string;
  readonly total: string;
  readonly category: Band;
}
interface Amounts {
  readonly value: string;
  readonly sd: string;
  readonly vat: string;
}
interface Return91 {
  readonly supplies: Readonly<Record<Band, Amounts>>;
  readonly purchases: Readonly<Record<Band, Amounts>>;
  readonly vdsDeducted: string;
  readonly vdsByCustomers: string;
  readonly advanceTax: string;
  readonly outputVat: string;
  readonly inputVat: string;
  readonly sdPayable: string;
  readonly netVat: string;
}

function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const cell = 'px-2 py-1';
const amount = `${cell} text-end tabular-nums`;

export function MushakPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('l10n_bd');
  const { format } = useKosh();
  const id = useId();
  const [form, setForm] = useState<Form>('6.2');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const path = `/api/v1/l10n_bd/mushak/${form}?month=${month}`;
  const data = useQuery({
    queryKey: ['l10n_bd', 'mushak', form, month],
    queryFn: () => api.call<{ rows: Row[] } | Return91>('GET', path),
    enabled: /^\d{4}-\d{2}$/.test(month),
  });
  const download = useMutation({
    mutationFn: async (kind: 'xlsx' | 'pdf') => {
      const { blob, filename } = await api.download(`${path}&format=${kind}`, undefined, 'GET');
      saveFile(blob, filename);
    },
  });
  const error = data.error ?? download.error;
  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('mushak.title')}</h1>
      <div className="flex flex-wrap items-end gap-2">
        <fieldset className="flex flex-wrap gap-1">
          <legend className="sr-only">{t('mushak.form')}</legend>
          {FORMS.map((f) => (
            <Button
              key={f}
              variant={form === f ? 'primary' : 'secondary'}
              aria-pressed={form === f}
              onClick={() => setForm(f)}
            >
              {t(`mushak.forms.${f.replace('.', '_')}`)}
            </Button>
          ))}
        </fieldset>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-month`}>{t('mushak.month')}</Label>
          <Input
            id={`${id}-month`}
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          disabled={download.isPending}
          onClick={() => download.mutate('xlsx')}
        >
          {t('mushak.xlsx')}
        </Button>
        <Button
          variant="secondary"
          disabled={download.isPending}
          onClick={() => download.mutate('pdf')}
        >
          {t('mushak.pdf')}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('mushak.hint')}</p>
      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {error instanceof ApiError ? error.message : String(error)}
        </p>
      )}
      {data.data === undefined ? null : 'rows' in data.data ? (
        <Register rows={data.data.rows} purchases={form === '6.1'} />
      ) : (
        <Summary data={data.data} />
      )}
    </div>
  );

  function Register({
    rows,
    purchases,
  }: {
    readonly rows: readonly Row[];
    readonly purchases: boolean;
  }): ReactElement {
    if (rows.length === 0)
      return <p className="text-sm text-muted-foreground">{t('mushak.empty')}</p>;
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className={`${cell} text-start`}>{t('mushak.date')}</th>
              <th className={`${cell} text-start`}>{t('mushak.number')}</th>
              <th className={`${cell} text-start`}>
                {t(purchases ? 'mushak.supplier' : 'mushak.customer')}
              </th>
              <th className={`${cell} text-start`}>{t('mushak.bin')}</th>
              <th className={`${cell} text-start`}>{t('mushak.description')}</th>
              <th className={`${cell} text-end`}>{t('mushak.value')}</th>
              <th className={`${cell} text-end`}>{t('mushak.sd')}</th>
              <th className={`${cell} text-end`}>{t('mushak.vat')}</th>
              <th className={`${cell} text-end`}>{t('mushak.total')}</th>
              <th className={`${cell} text-start`}>{t('mushak.band')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: register rows have no id of their own
              <tr key={i} className="border-b">
                <td className={cell}>{format.date(r.date)}</td>
                <td className={cell}>
                  {r.number}
                  {r.refund ? ` (${t('mushak.creditNote')})` : ''}
                </td>
                <td className={cell}>{r.partner}</td>
                <td className={`${cell} tabular-nums`}>{r.bin ?? ''}</td>
                <td className={cell}>{r.description}</td>
                <td className={amount}>{format.decimal(r.value, 2)}</td>
                <td className={amount}>{format.decimal(r.sd, 2)}</td>
                <td className={amount}>{format.decimal(r.vat, 2)}</td>
                <td className={amount}>{format.decimal(r.total, 2)}</td>
                <td className={cell}>{t(`mushak.bands.${r.category}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function Summary({ data }: { readonly data: Return91 }): ReactElement {
    const heading = (key: string) => (
      <tr className="bg-muted font-semibold">
        <th colSpan={4} scope="colgroup" className={`${cell} text-start`}>
          {t(key)}
        </th>
      </tr>
    );
    const bands = (rows: Readonly<Record<Band, Amounts>>) =>
      BANDS.map((b) => (
        <tr key={b} className="border-b">
          <th scope="row" className={`${cell} text-start font-normal`}>
            {t(`mushak.bands.${b}`)}
          </th>
          <td className={amount}>{format.decimal(rows[b].value, 2)}</td>
          <td className={amount}>{format.decimal(rows[b].sd, 2)}</td>
          <td className={amount}>{format.decimal(rows[b].vat, 2)}</td>
        </tr>
      ));
    const line = (key: string, value: string, column: 'sd' | 'vat' = 'vat') => (
      <tr className="border-b">
        <th scope="row" className={`${cell} text-start font-normal`}>
          {t(key)}
        </th>
        <td className={amount} />
        <td className={amount}>{column === 'sd' ? format.decimal(value, 2) : ''}</td>
        <td className={amount}>{column === 'vat' ? format.decimal(value, 2) : ''}</td>
      </tr>
    );
    return (
      <table className="w-full max-w-3xl text-sm">
        <thead>
          <tr>
            <th className={`${cell} text-start`}>
              <span className="sr-only">{t('mushak.form')}</span>
            </th>
            <th className={`${cell} text-end`}>{t('mushak.value')}</th>
            <th className={`${cell} text-end`}>{t('mushak.sd')}</th>
            <th className={`${cell} text-end`}>{t('mushak.vat')}</th>
          </tr>
        </thead>
        <tbody>
          {heading('mushak.r91.supplies')}
          {bands(data.supplies)}
          {heading('mushak.r91.purchases')}
          {bands(data.purchases)}
          {heading('mushak.r91.increasing')}
          {line('mushak.r91.vdsDeducted', data.vdsDeducted)}
          {heading('mushak.r91.decreasing')}
          {line('mushak.r91.vdsByCustomers', data.vdsByCustomers)}
          {line('mushak.r91.advanceTax', data.advanceTax)}
          {heading('mushak.r91.net')}
          {line('mushak.r91.outputVat', data.outputVat)}
          {line('mushak.r91.inputVat', data.inputVat)}
          {line('mushak.r91.sdPayable', data.sdPayable, 'sd')}
        </tbody>
        <tfoot className="font-semibold">
          <tr>
            <th scope="row" className={`${cell} text-start`}>
              {t('mushak.r91.netVat')}
            </th>
            <td className={amount} />
            <td className={amount} />
            <td className={amount}>{format.decimal(data.netVat, 2)}</td>
          </tr>
        </tfoot>
      </table>
    );
  }
}
