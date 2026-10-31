/**
 * The register (RFC 0021, Counter): a page for a tablet or a phone. The shop's products as tiles with pictures,
 * search and a barcode box (a scanner types into it; Enter adds the match), the cart, the payment screen with
 * several methods and the change, the receipt to print, the session opened with its cash and closed with its
 * count. Totals here are the register's own arithmetic for the cashier's eye; the server computes the sale.
 */
import {
  Alert,
  Button,
  Dialog,
  Input,
  Label,
  NetworkError,
  type PageProps,
  Spinner,
  useKosh,
} from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Shop {
  readonly id: number;
  readonly name: string;
  readonly pricesIncludeTax: boolean;
  readonly methods: readonly {
    readonly id: number;
    readonly name: string;
    readonly kind: string;
  }[];
}
interface Session {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly openingCash: string;
  readonly expectedCash: string | null;
  readonly closingCash: string | null;
  readonly closingDifference: string | null;
  readonly orderCount: number;
  readonly total: string;
}
interface Product {
  readonly id: number;
  readonly name: string;
  readonly code: string | null;
  readonly barcode: string | null;
  readonly price: string;
  readonly category: string | null;
  readonly image: number | null;
  readonly taxes: readonly {
    readonly amountType: string;
    readonly rate: string;
    readonly fixedAmount: string;
  }[];
}
interface CartLine {
  readonly product: Product;
  quantity: number;
}
interface Sale {
  readonly id: number;
  readonly name: string;
  readonly total: string;
  readonly amountTax: string;
  readonly amountPaid: string;
  readonly change: string;
}

const money = (n: number): string => n.toFixed(2);

/** The line's amount as the customer pays it (taxes added when the shop's prices do not include them). */
function lineAmount(line: CartLine, pricesIncludeTax: boolean): number {
  const gross = Number(line.product.price) * line.quantity;
  if (pricesIncludeTax) return gross;
  const percent = line.product.taxes
    .filter((t) => t.amountType === 'percent')
    .reduce((sum, t) => sum + Number(t.rate), 0);
  const fixed = line.product.taxes
    .filter((t) => t.amountType === 'fixed')
    .reduce((sum, t) => sum + Number(t.fixedAmount) * line.quantity, 0);
  return gross + (gross * percent) / 100 + fixed;
}

export function Register({ api }: PageProps): ReactElement {
  const { t } = useTranslation('pos');
  const { format, offline } = useKosh();
  const queryClient = useQueryClient();
  const [queued, setQueued] = useState(0);
  const shops = useQuery({
    queryKey: ['counter', 'shops'],
    queryFn: () => api.call<{ shops: Shop[] }>('GET', '/api/v1/counter/shops').then((r) => r.shops),
  });
  const [shopId, setShopId] = useState<number | null>(null);
  const shop =
    (shops.data ?? []).find((s) => s.id === shopId) ??
    (shops.data?.length === 1 ? shops.data[0] : undefined);
  const session = useQuery({
    queryKey: ['counter', 'session', shop?.id],
    queryFn: () =>
      api
        .call<{ session: Session | null }>('GET', `/api/v1/counter/session?shop=${shop?.id ?? 0}`)
        .then((r) => r.session),
    enabled: shop !== undefined,
  });
  const catalogue = useQuery({
    queryKey: ['counter', 'catalogue', shop?.id],
    queryFn: () =>
      api
        .call<{ products: Product[] }>('GET', `/api/v1/counter/catalogue?shop=${shop?.id ?? 0}`)
        .then((r) => r.products),
    enabled: shop !== undefined,
  });
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paying, setPaying] = useState(false);
  const [closing, setClosing] = useState(false);
  const [opening, setOpening] = useState('0');
  const [closingCash, setClosingCash] = useState('');
  const [reason, setReason] = useState('');
  const [payments, setPayments] = useState<Record<number, string>>({});
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientId = useRef<string>(crypto.randomUUID());
  const search = useRef<HTMLInputElement>(null);

  const products = catalogue.data ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return products.slice(0, 200);
    return products
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.code ?? '').toLowerCase().includes(q) ||
          (p.barcode ?? '').toLowerCase() === q,
      )
      .slice(0, 200);
  }, [products, query]);
  const total = cart.reduce((sum, l) => sum + lineAmount(l, shop?.pricesIncludeTax ?? true), 0);
  const paid = Object.values(payments).reduce((sum, v) => sum + (Number(v) || 0), 0);
  const change = Math.max(0, paid - total);

  const add = (p: Product): void => {
    setCart((lines) => {
      const i = lines.findIndex((l) => l.product.id === p.id);
      if (i < 0) return [...lines, { product: p, quantity: 1 }];
      const next = [...lines];
      next[i] = { product: p, quantity: (next[i]?.quantity ?? 0) + 1 };
      return next;
    });
  };
  const setQuantity = (id: number, quantity: number): void =>
    setCart((lines) =>
      lines
        .map((l) => (l.product.id === id ? { product: l.product, quantity } : l))
        .filter((l) => l.quantity > 0),
    );
  // A scanner types the barcode and sends Enter: the exact match goes to the cart, the box clears.
  const onSearchKey = (key: string): void => {
    if (key !== 'Enter') return;
    const q = query.trim().toLowerCase();
    const hit =
      products.find((p) => (p.barcode ?? '').toLowerCase() === q) ??
      (shown.length === 1 ? shown[0] : undefined);
    if (hit !== undefined) {
      add(hit);
      setQuery('');
    }
  };
  useEffect(() => {
    search.current?.focus();
  }, []);

  const open = useMutation({
    mutationFn: () =>
      api.call<{ session: Session }>('POST', '/api/v1/counter/sessions', {
        shop: shop?.id,
        openingCash: opening,
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['counter', 'session'] }),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const sell = useMutation({
    mutationFn: async (): Promise<{ order: Sale | null; queued: boolean }> => {
      const body = {
        session: session.data?.id,
        clientId: clientId.current,
        lines: cart.map((l) => ({ product: l.product.id, quantity: String(l.quantity) })),
        payments: Object.entries(payments)
          .filter(([, amount]) => Number(amount) > 0)
          .map(([method, amount]) => ({ method: Number(method), amount })),
      };
      try {
        const r = await api.call<{ order: Sale }>('POST', '/api/v1/counter/orders', body);
        return { order: r.order, queued: false };
      } catch (error) {
        // Offline: the sale waits on the device, sent in order when the network is back, accepted once by
        // its device reference (offline/queue.ts).
        if (!(error instanceof NetworkError) || offline === undefined) throw error;
        await offline.add({
          kind: 'request',
          method: 'POST',
          path: '/api/v1/counter/orders',
          model: 'pos.order',
          modelLabel: t('cart'),
          recordId: null,
          title: `${t('cart')} ${format.decimal(money(total))}`,
          values: body,
          etag: null,
        });
        return { order: null, queued: true };
      }
    },
    onSuccess: (r) => {
      if (r.queued) setQueued((n) => n + 1);
      setLastSale(r.order);
      setCart([]);
      setPayments({});
      setPaying(false);
      setError(null);
      clientId.current = crypto.randomUUID();
      void queryClient.invalidateQueries({ queryKey: ['counter', 'session'] });
      search.current?.focus();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const close = useMutation({
    mutationFn: () =>
      api.call<{ session: Session }>('POST', `/api/v1/counter/sessions/${session.data?.id}/close`, {
        closingCash,
        differenceReason: reason,
      }),
    onSuccess: (r) => {
      setClosing(false);
      setLastSale(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['counter', 'session'] });
      setClosedInfo(r.session);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const [closedInfo, setClosedInfo] = useState<Session | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [sentNote, setSentNote] = useState<string | null>(null);
  // The receipt by email or text: an address with an @ is an email, anything else a phone number.
  const sendReceipt = useMutation({
    mutationFn: (id: number) =>
      api.call<{ sent: string[] }>('POST', `/api/v1/counter/orders/${id}/receipt`, {
        ...(sendTo.includes('@') ? { email: sendTo.trim() } : { phone: sendTo.trim() }),
      }),
    onSuccess: (r) => {
      setSentNote(t('sent', { how: r.sent.join(', ') }));
      setSendTo('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const printReceipt = async (sale: Sale): Promise<void> => {
    try {
      const { templates } = await api.call<{
        templates: { id: number; name: string; scope: string }[];
      }>('GET', '/api/v1/models/pos.order/documents');
      const template =
        templates.find((tpl) => tpl.name === 'Receipt') ??
        templates.find((tpl) => tpl.scope === 'record');
      if (template === undefined) throw new Error(t('noReceiptTemplate'));
      const file = await api.download(`/api/v1/models/pos.order/documents/${template.id}`, {
        ids: [sale.id],
      });
      const url = URL.createObjectURL(file.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (shops.isPending) return <Spinner label={t('loading')} />;
  if ((shops.data ?? []).length === 0) return <Alert tone="info">{t('noShops')}</Alert>;
  if (shop === undefined)
    return (
      <div className="grid gap-3">
        <h2 className="text-base font-semibold">{t('chooseShop')}</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
          {(shops.data ?? []).map((s) => (
            <Button key={s.id} size="sm" variant="secondary" onClick={() => setShopId(s.id)}>
              {s.name}
            </Button>
          ))}
        </div>
      </div>
    );
  if (session.isPending) return <Spinner label={t('loading')} />;
  if (session.data === null || session.data === undefined)
    return (
      <div className="mx-auto grid max-w-sm gap-3">
        <h2 className="text-base font-semibold">{t('openSession', { shop: shop.name })}</h2>
        {closedInfo === null ? null : (
          <Alert tone="info">
            {t('closedSummary', {
              name: closedInfo.name,
              total: format.decimal(closedInfo.total),
              difference: format.decimal(closedInfo.closingDifference ?? '0'),
            })}
          </Alert>
        )}
        <div className="grid gap-1">
          <Label htmlFor="counter-opening">{t('openingCash')}</Label>
          <Input
            id="counter-opening"
            inputMode="decimal"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
          />
        </div>
        {error === null ? null : <Alert>{error}</Alert>}
        <Button variant="primary" busy={open.isPending} onClick={() => open.mutate()}>
          {t('open')}
        </Button>
      </div>
    );

  const current = session.data;
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_22rem]">
      <section aria-label={t('products')} className="grid content-start gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={search}
            aria-label={t('search')}
            placeholder={t('searchHint')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => onSearchKey(e.key)}
            className="max-w-md"
          />
          <span className="ms-auto text-xs text-muted-foreground">
            {t('sessionLine', {
              name: current.name,
              count: current.orderCount,
              total: format.decimal(current.total),
            })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
            {t('closeSession')}
          </Button>
        </div>
        {catalogue.isPending ? <Spinner label={t('loading')} /> : null}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
          {shown.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="grid w-full gap-1 rounded-lg border bg-surface p-2 text-start hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => add(p)}
              >
                {p.image === null ? (
                  <span className="aspect-square w-full rounded bg-muted" aria-hidden />
                ) : (
                  <img
                    src={`/api/v1/attachments/${p.image}/download?inline=true&w=256`}
                    alt=""
                    className="aspect-square w-full rounded object-cover"
                  />
                )}
                <span className="line-clamp-2 text-sm font-medium">{p.name}</span>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {format.decimal(p.price)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <aside
        aria-label={t('cart')}
        className="grid content-start gap-3 rounded-lg border bg-surface p-3"
      >
        <h2 className="text-sm font-semibold">{t('cart')}</h2>
        {cart.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('emptyCart')}</p>
        ) : null}
        <ul className="grid gap-2">
          {cart.map((l) => (
            <li
              key={l.product.id}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-sm"
            >
              <span className="truncate">{l.product.name}</span>
              <span className="inline-flex items-center gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('less', { name: l.product.name })}
                  onClick={() => setQuantity(l.product.id, l.quantity - 1)}
                >
                  −
                </Button>
                <span className="w-6 text-center tabular-nums">{l.quantity}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('more', { name: l.product.name })}
                  onClick={() => setQuantity(l.product.id, l.quantity + 1)}
                >
                  +
                </Button>
              </span>
              <span className="tabular-nums">
                {format.decimal(money(lineAmount(l, shop.pricesIncludeTax)))}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t pt-2">
          <span className="text-sm font-semibold">{t('total')}</span>
          <span className="text-xl font-semibold tabular-nums" aria-live="polite">
            {format.decimal(money(total))}
          </span>
        </div>
        <Button variant="primary" disabled={cart.length === 0} onClick={() => setPaying(true)}>
          {t('pay')}
        </Button>
        {queued === 0 ? null : (
          <p role="status" className="text-xs text-muted-foreground">
            {t('queued', { count: queued })}
          </p>
        )}
        {lastSale === null ? null : (
          <div role="status" className="grid gap-1 rounded-md border bg-muted/40 p-2 text-sm">
            <span>
              {t('soldLine', { name: lastSale.name, total: format.decimal(lastSale.total) })}
            </span>
            {Number(lastSale.change) > 0 ? (
              <span className="font-semibold">
                {t('changeLine', { change: format.decimal(lastSale.change) })}
              </span>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => void printReceipt(lastSale)}>
              {t('printReceipt')}
            </Button>
            <div className="grid grid-cols-[1fr_auto] gap-1">
              <Input
                aria-label={t('sendTo')}
                placeholder={t('sendToHint')}
                value={sendTo}
                onChange={(e) => setSendTo(e.target.value)}
              />
              <Button
                size="sm"
                variant="ghost"
                busy={sendReceipt.isPending}
                disabled={sendTo.trim() === ''}
                onClick={() => sendReceipt.mutate(lastSale.id)}
              >
                {t('send')}
              </Button>
            </div>
            {sentNote === null ? null : (
              <span className="text-xs text-muted-foreground">{sentNote}</span>
            )}
          </div>
        )}
        {error === null ? null : <Alert>{error}</Alert>}
      </aside>

      <Dialog
        open={paying}
        onOpenChange={setPaying}
        title={t('payTitle', { total: format.decimal(money(total)) })}
      >
        <div className="grid gap-3">
          {shop.methods.map((m) => (
            <div key={m.id} className="grid grid-cols-[1fr_8rem] items-center gap-2">
              <Label htmlFor={`pay-${m.id}`}>{m.name}</Label>
              <Input
                id={`pay-${m.id}`}
                inputMode="decimal"
                value={payments[m.id] ?? ''}
                onFocus={() => {
                  if ((payments[m.id] ?? '') === '' && paid < total)
                    setPayments({ ...payments, [m.id]: money(total - paid) });
                }}
                onChange={(e) => setPayments({ ...payments, [m.id]: e.target.value })}
              />
            </div>
          ))}
          <div className="flex justify-between text-sm">
            <span>{t('paid')}</span>
            <span className="tabular-nums">{format.decimal(money(paid))}</span>
          </div>
          <div className="flex justify-between text-sm font-semibold">
            <span>{t('change')}</span>
            <span className="tabular-nums">{format.decimal(money(change))}</span>
          </div>
          {error === null ? null : <Alert>{error}</Alert>}
          <Button
            variant="primary"
            disabled={paid + 0.004 < total}
            busy={sell.isPending}
            onClick={() => sell.mutate()}
          >
            {t('confirmSale')}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={closing}
        onOpenChange={setClosing}
        title={t('closeTitle', { name: current.name })}
      >
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            {t('expectedCash', { amount: format.decimal(current.expectedCash ?? '0') })}
          </p>
          <div className="grid gap-1">
            <Label htmlFor="counter-closing">{t('closingCash')}</Label>
            <Input
              id="counter-closing"
              inputMode="decimal"
              value={closingCash}
              onChange={(e) => setClosingCash(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="counter-reason">{t('differenceReason')}</Label>
            <Input id="counter-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error === null ? null : <Alert>{error}</Alert>}
          <Button variant="primary" busy={close.isPending} onClick={() => close.mutate()}>
            {t('closeSession')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
