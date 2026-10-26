/**
 * Accounting › Reconciliation: the open items of a reconcilable account (optionally one partner), lines selected
 * by hand and matched; the difference can be written off to an account. The server matches and refuses.
 */
import { Alert, Button, Checkbox, Input, Label, type PageProps, Select, useKosh } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Account {
  readonly id: number;
  readonly code: string;
  readonly name: string;
}
interface OpenItem {
  readonly id: number;
  readonly partner: number | null;
  readonly dateMaturity: string;
  readonly residual: string;
}

export function ReconcilePage({ api }: PageProps): ReactElement {
  const { t } = useTranslation('accounting');
  const { format } = useKosh();
  const id = useId();
  const [account, setAccount] = useState<string | null>(null);
  const [partner, setPartner] = useState('');
  const [writeOff, setWriteOff] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accounts = useQuery({
    queryKey: ['accounting', 'accounts', 'reconcilable'],
    queryFn: () =>
      api.list('account.account', {
        filter: { reconcile: true },
        fields: ['id', 'code', 'name'],
        order: ['code asc'],
        limit: 200,
      }),
  });
  const allAccounts = useQuery({
    queryKey: ['accounting', 'accounts', 'all'],
    queryFn: () =>
      api.list('account.account', {
        fields: ['id', 'code', 'name'],
        order: ['code asc'],
        limit: 500,
      }),
  });
  const partners = useQuery({
    queryKey: ['accounting', 'partners', partner],
    queryFn: () => api.names('res.partner', { q: partner, limit: 1 }),
    enabled: partner.trim() !== '',
  });
  const partnerId = partner.trim() === '' ? undefined : partners.data?.[0]?.id;
  const items = useQuery({
    queryKey: ['accounting', 'open-items', account, partnerId ?? null],
    queryFn: () =>
      api.call<{ items: OpenItem[] }>(
        'GET',
        `/api/v1/accounting/open-items?account=${account}${partnerId === undefined ? '' : `&partner=${partnerId}`}`,
      ),
    enabled: account !== null,
  });
  const balance = useMemo(
    () =>
      (items.data?.items ?? [])
        .filter((i) => selected.has(i.id))
        .reduce((n, i) => n + Number(i.residual), 0),
    [items.data, selected],
  );
  const reconcile = useMutation({
    mutationFn: () =>
      api.call<{ partials: number[] }>('POST', '/api/v1/accounting/reconcile', {
        lines: [...selected],
        ...(writeOff === null || balance === 0 ? {} : { writeOff: { account: Number(writeOff) } }),
      }),
    onSuccess: async (r) => {
      setError(null);
      setMessage(t('reconcile.done', { count: r.partials.length }));
      setSelected(new Set());
      await items.refetch();
    },
    onError: (e) => setError(e.message),
  });
  const options = (rows: readonly { id: number; code: string; name: string }[] | undefined) =>
    (rows ?? []).map((a) => ({ value: String(a.id), label: `${a.code} ${a.name}` }));
  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('reconcile.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('reconcile.hint')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Select
          id={`${id}-account`}
          label={t('reconcile.account')}
          className="w-72"
          value={account}
          options={options(accounts.data?.items as unknown as Account[] | undefined)}
          onChange={(v) => {
            setAccount(v);
            setSelected(new Set());
          }}
        />
        <div className="grid gap-1">
          <Label htmlFor={`${id}-partner`}>{t('reconcile.partner')}</Label>
          <Input
            id={`${id}-partner`}
            value={partner}
            onChange={(e) => setPartner(e.target.value)}
          />
        </div>
      </div>
      {message === null ? null : <Alert tone="info">{message}</Alert>}
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      {account === null ? null : (items.data?.items ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('reconcile.empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted text-start">
            <tr>
              <th className="w-10 px-2 py-1" />
              <th className="px-2 py-1 text-start">{t('reconcile.date')}</th>
              <th className="px-2 py-1 text-start">{t('reconcile.label')}</th>
              <th className="px-2 py-1 text-end">{t('reconcile.residual')}</th>
            </tr>
          </thead>
          <tbody>
            {(items.data?.items ?? []).map((i) => (
              <tr key={i.id} className="border-b">
                <td className="px-2 py-1">
                  <Checkbox
                    aria-label={`#${i.id}`}
                    checked={selected.has(i.id)}
                    onCheckedChange={(c) =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (c === true) next.add(i.id);
                        else next.delete(i.id);
                        return next;
                      })
                    }
                  />
                </td>
                <td className="px-2 py-1">{format.date(i.dateMaturity)}</td>
                <td className="px-2 py-1">#{i.id}</td>
                <td className="px-2 py-1 text-end tabular-nums">{format.decimal(i.residual)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected.size === 0 ? null : (
        <div className="flex flex-wrap items-end gap-2">
          <span className="text-sm" aria-live="polite">
            {t('reconcile.selected', {
              count: selected.size,
              balance: format.decimal(balance.toFixed(2)),
            })}
          </span>
          {balance === 0 ? null : (
            <Select
              id={`${id}-writeoff`}
              label={t('reconcile.writeOff')}
              className="w-72"
              value={writeOff}
              options={options(allAccounts.data?.items as unknown as Account[] | undefined)}
              onChange={setWriteOff}
            />
          )}
          <Button
            variant="primary"
            busy={reconcile.isPending}
            disabled={balance !== 0 && writeOff === null}
            onClick={() => reconcile.mutate()}
          >
            {t('reconcile.reconcile')}
          </Button>
        </div>
      )}
    </div>
  );
}
