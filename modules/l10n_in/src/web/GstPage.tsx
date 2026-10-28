/**
 * Accounting › Reporting › GST returns (RFC 0016 step 5, part 3): GSTR-1 by section and GSTR-3B by table for a
 * month, as the server computes them, with their XLSX and PDF files and GSTR-1's JSON for the GST portal.
 */
import { ApiError, Button, Input, Label, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Form = '1' | '3b';
interface Heads {
  readonly txval: string;
  readonly iamt: string;
  readonly camt: string;
  readonly samt: string;
  readonly csamt: string;
}
interface Gstr1 {
  readonly gstin: string | null;
  readonly unclassified: number;
  readonly summary: readonly (Heads & { readonly section: string; readonly documents: number })[];
}
interface Gstr3b {
  readonly gstin: string | null;
  readonly outwardTaxable: Heads;
  readonly outwardZeroRated: Heads;
  readonly outwardNilExempt: Heads;
  readonly inwardReverseCharge: Heads;
  readonly outwardNonGst: Heads;
  readonly itcReverseCharge: Heads;
  readonly itcOther: Heads;
  readonly inwardExempt: { readonly inter: string; readonly intra: string };
  readonly payable: Readonly<
    Record<
      'igst' | 'cgst' | 'sgst' | 'cess',
      { readonly tax: string; readonly credit: string; readonly net: string }
    >
  >;
}

const HEADS = ['txval', 'iamt', 'camt', 'samt', 'csamt'] as const;
const ROWS_3B = [
  'outwardTaxable',
  'outwardZeroRated',
  'outwardNilExempt',
  'inwardReverseCharge',
  'outwardNonGst',
  'itcReverseCharge',
  'itcOther',
] as const;

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

export function GstPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('l10n_in');
  const { format } = useKosh();
  const id = useId();
  const [form, setForm] = useState<Form>('1');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const path = `/api/v1/l10n_in/gstr/${form}?month=${month}`;
  const data = useQuery({
    queryKey: ['l10n_in', 'gstr', form, month],
    queryFn: () => api.call<Gstr1 | Gstr3b>('GET', path),
    enabled: /^\d{4}-\d{2}$/.test(month),
  });
  const download = useMutation({
    mutationFn: async (kind: 'xlsx' | 'pdf' | 'portal') => {
      const { blob, filename } = await api.download(`${path}&format=${kind}`, undefined, 'GET');
      saveFile(blob, filename);
    },
  });
  const error = data.error ?? download.error;
  const money = (v: string) => format.decimal(v, 2);
  const headCells = (h: Heads) =>
    HEADS.map((k) => (
      <td key={k} className={amount}>
        {money(h[k])}
      </td>
    ));
  const header = (first: string) => (
    <thead className="bg-muted">
      <tr>
        <th className={`${cell} text-start`}>{first}</th>
        {HEADS.map((k) => (
          <th key={k} className={`${cell} text-end`}>
            {t(`gst.heads.${k}`)}
          </th>
        ))}
      </tr>
    </thead>
  );

  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('gst.title')}</h1>
      <div className="flex flex-wrap items-end gap-2">
        <fieldset className="flex gap-1">
          <legend className="sr-only">{t('gst.form')}</legend>
          {(['1', '3b'] as const).map((f) => (
            <Button
              key={f}
              variant={form === f ? 'primary' : 'secondary'}
              aria-pressed={form === f}
              onClick={() => setForm(f)}
            >
              {t(`gst.forms.${f}`)}
            </Button>
          ))}
        </fieldset>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-month`}>{t('gst.month')}</Label>
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
          {t('gst.xlsx')}
        </Button>
        <Button
          variant="secondary"
          disabled={download.isPending}
          onClick={() => download.mutate('pdf')}
        >
          {t('gst.pdf')}
        </Button>
        {form === '1' ? (
          <Button
            variant="secondary"
            disabled={download.isPending}
            onClick={() => download.mutate('portal')}
          >
            {t('gst.portal')}
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {t('gst.hint', { gstin: data.data?.gstin ?? '—' })}
      </p>
      {error === null ? null : (
        <p role="alert" className="text-sm text-danger">
          {error instanceof ApiError ? error.message : String(error)}
        </p>
      )}
      {data.data === undefined ? null : 'summary' in data.data ? (
        <div className="grid gap-2 overflow-x-auto">
          <table className="w-full text-sm">
            {header(t('gst.section'))}
            <tbody>
              {data.data.summary.map((s) => (
                <tr key={s.section} className="border-b">
                  <th scope="row" className={`${cell} text-start font-normal`}>
                    {t(`gst.sections.${s.section}`)}{' '}
                    <span className="text-muted-foreground">({s.documents})</span>
                  </th>
                  {headCells(s)}
                </tr>
              ))}
            </tbody>
          </table>
          {data.data.unclassified > 0 ? (
            <p role="status" className="text-sm text-warning">
              {t('gst.unclassified', { count: data.data.unclassified })}
            </p>
          ) : null}
        </div>
      ) : (
        <Gstr3bTables data={data.data} />
      )}
    </div>
  );

  function Gstr3bTables({ data }: { readonly data: Gstr3b }): ReactElement {
    return (
      <div className="grid gap-4 overflow-x-auto">
        <table className="w-full text-sm">
          {header(t('gst.table'))}
          <tbody>
            {ROWS_3B.map((key) => (
              <tr key={key} className="border-b">
                <th scope="row" className={`${cell} text-start font-normal`}>
                  {t(`gst.r3b.${key}`)}
                </th>
                {headCells(data[key])}
              </tr>
            ))}
            <tr className="border-b">
              <th scope="row" className={`${cell} text-start font-normal`}>
                {t('gst.r3b.inwardExemptInter')}
              </th>
              <td className={amount}>{money(data.inwardExempt.inter)}</td>
              <td colSpan={4} />
            </tr>
            <tr className="border-b">
              <th scope="row" className={`${cell} text-start font-normal`}>
                {t('gst.r3b.inwardExemptIntra')}
              </th>
              <td className={amount}>{money(data.inwardExempt.intra)}</td>
              <td colSpan={4} />
            </tr>
          </tbody>
        </table>
        <table className="w-full max-w-2xl text-sm">
          <thead className="bg-muted">
            <tr>
              <th className={`${cell} text-start`}>{t('gst.r3b.payable')}</th>
              {(['igst', 'cgst', 'sgst', 'cess'] as const).map((k) => (
                <th key={k} className={`${cell} text-end`}>
                  {t(
                    `gst.heads.${k === 'igst' ? 'iamt' : k === 'cgst' ? 'camt' : k === 'sgst' ? 'samt' : 'csamt'}`,
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['tax', 'credit', 'net'] as const).map((row) => (
              <tr key={row} className={row === 'net' ? 'font-semibold' : 'border-b'}>
                <th scope="row" className={`${cell} text-start font-normal`}>
                  {t(`gst.r3b.${row}`)}
                </th>
                {(['igst', 'cgst', 'sgst', 'cess'] as const).map((k) => (
                  <td key={k} className={amount}>
                    {money(data.payable[k][row])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
}
