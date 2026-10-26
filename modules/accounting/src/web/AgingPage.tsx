/** Accounting › Reporting › Aged balances: receivables or payables per partner in buckets of days overdue. */
import { Button, Input, Label, type PageProps, useKosh } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Row {
  readonly partner: number | null;
  readonly name: string;
  readonly notDue: string;
  readonly d30: string;
  readonly d60: string;
  readonly d90: string;
  readonly older: string;
  readonly total: string;
}

const COLUMNS = ['notDue', 'd30', 'd60', 'd90', 'older', 'total'] as const;

export function AgingPage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('accounting');
  const { format } = useKosh();
  const id = useId();
  const [type, setType] = useState<'receivable' | 'payable'>('receivable');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const report = useQuery({
    queryKey: ['accounting', 'aging', type, date],
    queryFn: () =>
      api.call<{ rows: Row[]; total: Row }>(
        'GET',
        `/api/v1/accounting/reports/aging?type=${type}&date=${date}`,
      ),
  });
  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('aging.title')}</h1>
      <div className="flex flex-wrap items-end gap-2">
        <fieldset className="flex gap-1">
          <legend className="sr-only">{t('aging.title')}</legend>
          <Button
            variant={type === 'receivable' ? 'primary' : 'secondary'}
            aria-pressed={type === 'receivable'}
            onClick={() => setType('receivable')}
          >
            {t('aging.receivable')}
          </Button>
          <Button
            variant={type === 'payable' ? 'primary' : 'secondary'}
            aria-pressed={type === 'payable'}
            onClick={() => setType('payable')}
          >
            {t('aging.payable')}
          </Button>
        </fieldset>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-date`}>{t('aging.asOf')}</Label>
          <Input
            id={`${id}-date`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>
      {(report.data?.rows ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('aging.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-2 py-1 text-start">{t('aging.partner')}</th>
              {COLUMNS.map((c) => (
                <th key={c} className="px-2 py-1 text-end">
                  {t(`aging.${c}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(report.data?.rows ?? []).map((r) => (
              <tr key={r.partner ?? 'none'} className="border-b">
                <td className="px-2 py-1">{r.name}</td>
                {COLUMNS.map((c) => (
                  <td key={c} className="px-2 py-1 text-end tabular-nums">
                    {format.decimal(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {report.data === undefined ? null : (
            <tfoot className="font-semibold">
              <tr>
                <td className="px-2 py-1">{t('aging.total')}</td>
                {COLUMNS.map((c) => (
                  <td key={c} className="px-2 py-1 text-end tabular-nums">
                    {format.decimal(report.data.total[c])}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      )}
    </div>
  );
}
