/**
 * "Register payment" on a posted document that is not fully paid (a node component of the invoice form): a
 * dialog with the journal, the date, the amount (the amount due by default) and a memo, posted through
 * `POST /api/v1/accounting/payments/register`; the form reloads afterwards.
 */
import { Alert, Button, Dialog, Input, Label, type NodeComponentProps, Select } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function RegisterPayment({ api, record, reload }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('accounting');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [journal, setJournal] = useState<string | null>(null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState<string | null>(null);
  const [memo, setMemo] = useState('');
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
  const pay = useMutation({
    mutationFn: () =>
      api.call<{ name: string }>('POST', '/api/v1/accounting/payments/register', {
        moves: [record?.id],
        journal: Number(journal),
        date,
        ...(amount === null ? {} : { amount }),
        ...(memo === '' ? {} : { memo }),
      }),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      reload();
    },
    onError: (e) => setError(e.message),
  });
  if (record === null || record['state'] !== 'posted' || record['kind'] === 'entry') return null;
  if (record['paymentState'] === 'paid') return null;
  const due = (record['amountResidual'] as { amount?: string } | null)?.amount ?? '';
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
          <div className="grid gap-1">
            <Label htmlFor={`${id}-amount`}>{t('pay.amount')}</Label>
            <Input
              id={`${id}-amount`}
              inputMode="decimal"
              value={amount ?? due}
              onChange={(e) => setAmount(e.target.value)}
            />
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
