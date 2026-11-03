/**
 * Stockroom › Replenishment (RFC 0024 §2.6): every reorder rule with its forecast, what it proposes and why, in
 * words. Quantities can be changed before ordering; the chosen rules are ordered by their method (a transfer, a
 * request for quotation, a production order) or snoozed. The server reckons and orders; this page only shows it.
 */
import { Alert, Button, Checkbox, Input, Label, type PageProps, useKosh } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Rule {
  readonly id: number;
  readonly name: string;
  readonly method: 'buy' | 'make' | 'transfer' | 'dropship';
  readonly minimum: string;
  readonly maximum: string;
  readonly onHand: string | null;
  readonly forecast: string | null;
  readonly proposed: string | null;
  readonly explanation: string | null;
  readonly snoozedUntil: string | null;
  readonly lastOrder: string | null;
}
interface Ordered {
  readonly ordered: { rule: number; document: string; quantity: string }[];
  readonly skipped: { rule: number; reason: string }[];
}

const FIELDS = [
  'id',
  'name',
  'method',
  'minimum',
  'maximum',
  'onHand',
  'forecast',
  'proposed',
  'explanation',
  'snoozedUntil',
  'lastOrder',
];

export function Replenishment({ api }: PageProps): ReactElement {
  const { t } = useTranslation('stock');
  const { format } = useKosh();
  const id = useId();
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [quantities, setQuantities] = useState<Readonly<Record<number, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rules = useQuery({
    queryKey: ['stock', 'replenishment', all],
    queryFn: async () =>
      (
        await api.list('stock.reorder', {
          ...(all ? {} : { filter: { proposed: { gt: 0 } } }),
          fields: FIELDS,
          order: ['name asc'],
          limit: 500,
        })
      ).items as unknown as Rule[],
  });
  const done = async (text: string) => {
    setError(null);
    setMessage(text);
    setSelected(new Set());
    setQuantities({});
    await rules.refetch();
  };
  const refresh = useMutation({
    mutationFn: () =>
      api.call<{ rules: number }>('POST', '/api/v1/stockroom/replenishment/refresh', {}),
    onSuccess: (r) => done(t('replenish.refreshed', { count: r.rules })),
    onError: (e) => setError(e.message),
  });
  const order = useMutation({
    mutationFn: () =>
      api.call<Ordered>('POST', '/api/v1/stockroom/replenishment/order', {
        rules: [...selected],
        quantities: Object.fromEntries(
          Object.entries(quantities).filter(([id, q]) => selected.has(Number(id)) && q !== ''),
        ),
      }),
    onSuccess: (r) =>
      done(
        [
          ...r.ordered.map((o) =>
            t('replenish.ordered', { quantity: o.quantity, document: o.document }),
          ),
          ...r.skipped.map((s) => s.reason),
        ].join(' '),
      ),
    onError: (e) => setError(e.message),
  });
  const snooze = useMutation({
    mutationFn: () =>
      api.call<{ rules: number }>('POST', '/api/v1/stockroom/replenishment/snooze', {
        rules: [...selected],
        days: 7,
      }),
    onSuccess: (r) => done(t('replenish.snoozed', { count: r.rules })),
    onError: (e) => setError(e.message),
  });
  const rows = rules.data ?? [];
  const busy = refresh.isPending || order.isPending || snooze.isPending;
  const toggle = (id: number, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <div className="grid gap-4 p-4">
      <h1 className="text-xl font-semibold">{t('replenish.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('replenish.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={busy || selected.size === 0}
          onClick={() => order.mutate()}
        >
          {t('replenish.order', { count: selected.size })}
        </Button>
        <Button disabled={busy || selected.size === 0} onClick={() => snooze.mutate()}>
          {t('replenish.snooze')}
        </Button>
        <Button disabled={busy} onClick={() => refresh.mutate()}>
          {t('replenish.refresh')}
        </Button>
        <div className="ms-auto flex items-center gap-2 text-sm">
          <Checkbox id={`${id}-all`} checked={all} onCheckedChange={(c) => setAll(c === true)} />
          <Label htmlFor={`${id}-all`}>{t('replenish.all')}</Label>
        </div>
      </div>
      {message === null ? null : <Alert tone="info">{message}</Alert>}
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {rules.isLoading ? t('replenish.loading') : t('replenish.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="w-10 px-2 py-1" />
                <th className="px-2 py-1 text-start">{t('replenish.rule')}</th>
                <th className="px-2 py-1 text-start">{t('replenish.method')}</th>
                <th className="px-2 py-1 text-end">{t('replenish.onHand')}</th>
                <th className="px-2 py-1 text-end">{t('replenish.forecast')}</th>
                <th className="px-2 py-1 text-end">{t('replenish.minMax')}</th>
                <th className="px-2 py-1 text-end">{t('replenish.toOrder')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b align-top">
                  <td className="px-2 py-2">
                    <Checkbox
                      aria-label={r.name}
                      checked={selected.has(r.id)}
                      onCheckedChange={(c) => toggle(r.id, c === true)}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">{r.explanation ?? ''}</div>
                    {r.snoozedUntil === null ? null : (
                      <div className="text-xs text-muted-foreground">
                        {t('replenish.snoozedUntil', { date: format.date(r.snoozedUntil) })}
                      </div>
                    )}
                    {r.lastOrder === null ? null : (
                      <div className="text-xs text-muted-foreground">
                        {t('replenish.last', { document: r.lastOrder })}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2">{t(`replenish.${r.method}`)}</td>
                  <td className="px-2 py-2 text-end tabular-nums">
                    {format.decimal(r.onHand ?? '0')}
                  </td>
                  <td className="px-2 py-2 text-end tabular-nums">
                    {format.decimal(r.forecast ?? '0')}
                  </td>
                  <td className="px-2 py-2 text-end tabular-nums">
                    {format.decimal(r.minimum)} – {format.decimal(r.maximum)}
                  </td>
                  <td className="px-2 py-2 text-end">
                    <Input
                      aria-label={t('replenish.quantityOf', { name: r.name })}
                      inputMode="decimal"
                      className="ms-auto w-24 text-end"
                      value={quantities[r.id] ?? String(Number(r.proposed ?? 0))}
                      onChange={(e) => setQuantities((q) => ({ ...q, [r.id]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
