/**
 * "Register payment" on a posted document that is not fully paid (a node component of the invoice form): a
 * dialog with the journal, the date, the withholdings the partner's documents call for (VDS, TDS — proposed by the
 * server, each amount editable), the amount (what is due less what is withheld, by default) and a memo, posted
 * through `POST /api/v1/accounting/payments/register`; the form reloads afterwards.
 */
import {
  Alert,
  Button,
  Dialog,
  Input,
  Label,
  type NodeComponentProps,
  Select,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Proposal {
  readonly residual: string;
  readonly currency: string;
  readonly withholdings: readonly {
    readonly withholding: number;
    readonly name: string;
    readonly base: string;
    readonly amount: string;
  }[];
  readonly amount: string;
}

/** Exact decimal subtraction of decimal strings (no floats): `a - Σ b`, to the cent. */
function less(a: string, bs: readonly string[]): string {
  const cents = (v: string) => {
    const [w = '0', f = ''] = v.trim().split('.');
    return BigInt(w === '' ? '0' : w) * 100n + BigInt(`${f}00`.slice(0, 2));
  };
  const r = bs.reduce((s, b) => s - (/^\d+(\.\d+)?$/.test(b) ? cents(b) : 0n), cents(a));
  const sign = r < 0n ? '-' : '';
  const abs = r < 0n ? -r : r;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export function RegisterPayment({ api, record, reload }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('accounting');
  const { format } = useKosh();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [journal, setJournal] = useState<string | null>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState<string | null>(null);
  const [memo, setMemo] = useState('');
  const [kept, setKept] = useState<Readonly<Record<number, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const journals = useQuery({
    queryKey: ['accounting', 'journals', 'cash-bank'],
    queryFn: () =>
      api.list('account.journal', {
        filter: { type: { in: ['cash', 'bank'] } },
        fields: ['id', 'code', 'name'],
      }),
    enabled: open,
  });
  const proposal = useQuery({
    queryKey: ['accounting', 'withholdings', record?.id],
    queryFn: () =>
      api.call<Proposal>('POST', '/api/v1/accounting/payments/propose', { moves: [record?.id] }),
    enabled: open,
  });
  const withholdings = (proposal.data?.withholdings ?? []).map((w) => ({
    ...w,
    amount: kept[w.withholding] ?? w.amount,
  }));
  const due =
    proposal.data?.residual ??
    (record?.['amountResidual'] as { amount?: string } | null)?.amount ??
    '';
  const net = less(
    due,
    withholdings.map((w) => w.amount),
  );
  const pay = useMutation({
    mutationFn: () =>
      api.call<{ name: string }>('POST', '/api/v1/accounting/payments/register', {
        moves: [record?.id],
        journal: Number(journal),
        date,
        amount: amount ?? net,
        withholdings: withholdings
          .filter((w) => /^\d+(\.\d+)?$/.test(w.amount) && Number(w.amount) > 0)
          .map((w) => ({ withholding: w.withholding, amount: w.amount })),
        ...(memo === '' ? {} : { memo }),
      }),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      setKept({});
      reload();
    },
    onError: (e) => setError(e.message),
  });
  if (record === null || record['state'] !== 'posted' || record['kind'] === 'entry') return null;
  if (record['paymentState'] === 'paid') return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('pay.button')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('pay.title')}
        footer={
          <Button
            variant="primary"
            busy={pay.isPending}
            disabled={journal === null}
            onClick={() => pay.mutate()}
          >
            {t('pay.confirm')}
          </Button>
        }
      >
        <div className="grid gap-3">
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <Select
            id={`${id}-journal`}
            label={t('pay.journal')}
            value={journal}
            options={(journals.data?.items ?? []).map((j) => ({
              value: String(j.id),
              label: `${String(j['code'])} ${String(j['name'])}`,
            }))}
            onChange={setJournal}
          />
          <div className="grid gap-1">
            <Label htmlFor={`${id}-date`}>{t('pay.date')}</Label>
            <Input
              id={`${id}-date`}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          {withholdings.length === 0 ? null : (
            <fieldset className="grid gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{t('pay.withheld')}</legend>
              {withholdings.map((w) => (
                <div key={w.withholding} className="grid gap-1">
                  <Label htmlFor={`${id}-w${w.withholding}`}>
                    {w.name} ({format.decimal(w.base, 2)})
                  </Label>
                  <Input
                    id={`${id}-w${w.withholding}`}
                    inputMode="decimal"
                    value={w.amount}
                    onChange={(e) => setKept((k) => ({ ...k, [w.withholding]: e.target.value }))}
                  />
                </div>
              ))}
            </fieldset>
          )}
          <div className="grid gap-1">
            <Label htmlFor={`${id}-amount`}>{t('pay.amount')}</Label>
            <Input
              id={`${id}-amount`}
              inputMode="decimal"
              value={amount ?? net}
              onChange={(e) => setAmount(e.target.value)}
            />
            {withholdings.length === 0 ? null : (
              <p className="text-xs text-muted-foreground">
                {t('pay.due', {
                  amount: format.decimal(due, 2),
                  withheld: format.decimal(
                    less(
                      '0',
                      withholdings.map((w) => w.amount),
                    ).replace('-', ''),
                    2,
                  ),
                })}
              </p>
            )}
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-memo`}>{t('pay.memo')}</Label>
            <Input id={`${id}-memo`} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
        </div>
      </Dialog>
    </>
  );
}
