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
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
    /** Paid on a provider's page the customer opens from a QR code: not typed in by the cashier. */
    readonly provider?: boolean;
  }[];
}
/** A payment asked of a provider for the sale being rung up, by method. */
interface Asked {
  readonly reference: string;
  readonly url: string;
  readonly qr: string;
  readonly amount: string;
  readonly state: string;
  readonly error: string | null;
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
  /** The family of a variant and the values that tell it apart (RFC 0030 §3.4). */
  readonly template: { readonly id: number; readonly name: string } | null;
  readonly values: readonly string[];
  readonly taxes: readonly {
    readonly amountType: string;
    readonly rate: string;
    readonly fixedAmount: string;
  }[];
}
/** A tile: a product, or a family of variants chosen from a dialog. */
type Tile =
  | { readonly kind: 'product'; readonly product: Product }
  | {
      readonly kind: 'family';
      readonly id: number;
      readonly name: string;
      readonly image: number | null;
      readonly from: string;
      readonly variants: readonly Product[];
    };
interface CartLine {
  readonly product: Product;
  quantity: number;
}
/** The customer named on the sale being rung up; `note` is what an app says about them (a loyalty card). */
interface Customer {
  readonly partner: number;
  readonly name: string;
  readonly note: string | null;
  /** They have a price list of their own: the till shows the catalogue at their prices. */
  readonly ownPrices: boolean;
}
/** What the server says the sale would come to, with what other apps take off it and the inputs they offer. */
interface Quote {
  readonly subtotal: string;
  readonly total: string;
  readonly extras: {
    readonly fields: readonly {
      readonly key: string;
      readonly label: string;
      readonly kind: 'text' | 'number';
      readonly hint: string | null;
      readonly max: number | null;
    }[];
    readonly lines: readonly {
      readonly kind: string;
      readonly name: string;
      readonly amount: string;
    }[];
    readonly problems: readonly { readonly field: string; readonly say: string }[];
  };
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
  // The customer of the sale being rung up: found by what they say — a phone number, an email, a card number.
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerMissing, setCustomerMissing] = useState(false);
  // A customer with prices of their own sees them: the catalogue is asked for again at their price list.
  const pricedFor = customer?.ownPrices === true ? customer.partner : null;
  const catalogue = useQuery({
    queryKey: ['counter', 'catalogue', shop?.id, pricedFor],
    queryFn: () =>
      api
        .call<{ products: Product[] }>(
          'GET',
          `/api/v1/counter/catalogue?shop=${shop?.id ?? 0}${pricedFor === null ? '' : `&partner=${pricedFor}`}`,
        )
        .then((r) => r.products),
    enabled: shop !== undefined,
    // The tiles stay while the other prices load.
    placeholderData: keepPreviousData,
  });
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paying, setPaying] = useState(false);
  const [closing, setClosing] = useState(false);
  const [opening, setOpening] = useState('0');
  const [closingCash, setClosingCash] = useState('');
  const [reason, setReason] = useState('');
  const [payments, setPayments] = useState<Record<number, string>>({});
  // Payments asked of a provider for this sale: followed until the provider confirms them.
  const [askedOf, setAskedOf] = useState<Record<number, Asked>>({});
  const [lastSale, setLastSale] = useState<Sale | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientId = useRef<string>(crypto.randomUUID());
  const search = useRef<HTMLInputElement>(null);

  const products = catalogue.data ?? [];
  const [family, setFamily] = useState<Extract<Tile, { kind: 'family' }> | null>(null);
  // Without a search, variants of one template fold into a family tile; a search finds variants by name.
  const shown = useMemo((): Tile[] => {
    const q = query.trim().toLowerCase();
    if (q !== '')
      return products
        .filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.code ?? '').toLowerCase().includes(q) ||
            (p.barcode ?? '').toLowerCase() === q,
        )
        .slice(0, 200)
        .map((product) => ({ kind: 'product', product }));
    const tiles: Tile[] = [];
    const families = new Map<number, Extract<Tile, { kind: 'family' }>>();
    for (const p of products) {
      if (p.template === null) {
        tiles.push({ kind: 'product', product: p });
        continue;
      }
      const have = families.get(p.template.id);
      if (have === undefined) {
        const made: Extract<Tile, { kind: 'family' }> = {
          kind: 'family',
          id: p.template.id,
          name: p.template.name,
          image: p.image,
          from: p.price,
          variants: [p],
        };
        families.set(p.template.id, made);
        tiles.push(made);
      } else
        families.set(p.template.id, {
          ...have,
          image: have.image ?? p.image,
          from: Number(p.price) < Number(have.from) ? p.price : have.from,
          variants: [...have.variants, p],
        });
    }
    return tiles.map((t) => (t.kind === 'family' ? (families.get(t.id) ?? t) : t)).slice(0, 200);
  }, [products, query]);
  // What other apps take off the sale — promotions, points, a gift card (RFC 0034 §2.6) — is the server's to
  // work out: the till asks for a quote of what is in the cart, shows it, and asks for the same with the sale.
  // Without the network there is no quote: the sale is then what the till itself adds up.
  const [asked, setAsked] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const cartKey = cart.map((l) => `${l.product.id}:${l.quantity}`).join(',');
  const sessionId = session.data?.id ?? null;
  const quote = useQuery({
    queryKey: ['counter', 'quote', sessionId, customer?.partner ?? null, cartKey, asked],
    queryFn: () =>
      api.call<Quote>('POST', '/api/v1/counter/quote', {
        session: sessionId,
        ...(customer === null ? {} : { partner: customer.partner }),
        lines: cart.map((l) => ({ product: l.product.id, quantity: String(l.quantity) })),
        extras: asked,
      }),
    enabled: sessionId !== null && cart.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const extras = cart.length === 0 || quote.isError ? undefined : quote.data?.extras;
  const own = cart.reduce((sum, l) => sum + lineAmount(l, shop?.pricesIncludeTax ?? true), 0);
  const total =
    extras === undefined || quote.data === undefined ? own : Number(quote.data.total) || 0;
  // Points are a customer's: another customer, another question.
  const customerId = customer?.partner ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: asked again when the customer changes
  useEffect(() => {
    setAsked({});
    setTyped({});
  }, [customerId]);
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
        .filter((l) => l.quantity > 0 || l.quantity === 0),
    );
  const removeLine = (id: number): void =>
    setCart((lines) => lines.filter((l) => l.product.id !== id));
  // A scanner types the barcode and sends Enter: the exact match goes to the cart, the box clears.
  const onSearchKey = (key: string): void => {
    if (key !== 'Enter') return;
    const q = query.trim().toLowerCase();
    const only = shown.length === 1 ? shown[0] : undefined;
    const hit =
      products.find((p) => (p.barcode ?? '').toLowerCase() === q) ??
      (only?.kind === 'product' ? only.product : undefined);
    if (hit !== undefined) {
      add(hit);
      setQuery('');
    } else if (only?.kind === 'family') setFamily(only);
    // Nothing on sale answers to it: the reference of a receipt, perhaps.
    else if (shown.length === 0 && query.trim().length >= 3) findSale.mutate(query.trim());
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
  const priced = catalogue.data;
  useEffect(() => {
    if (priced === undefined) return;
    const byId = new Map(priced.map((p) => [p.id, p]));
    setCart((lines) =>
      lines.some((l) => (byId.get(l.product.id)?.price ?? l.product.price) !== l.product.price)
        ? lines.map((l) => ({ ...l, product: byId.get(l.product.id) ?? l.product }))
        : lines,
    );
  }, [priced]);
  const askPayment = useMutation({
    mutationFn: (method: number) =>
      api
        .call<{ reference: string; url: string; qr: string }>('POST', '/api/v1/counter/payments', {
          session: session.data?.id,
          method,
          amount: payments[method] ?? '',
        })
        .then((r) => ({ method, ...r })),
    onSuccess: (r) => {
      setError(null);
      setAskedOf((all) => ({
        ...all,
        [r.method]: {
          reference: r.reference,
          url: r.url,
          qr: r.qr,
          amount: payments[r.method] ?? '',
          state: 'pending',
          error: null,
        },
      }));
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  // The provider's word, asked every two seconds while a payment is pending.
  const pending = Object.entries(askedOf).filter(([, a]) => a.state === 'pending');
  const waiting = pending.length > 0;
  const pendingKey = pending.map(([, a]) => a.reference).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the pending references, not their objects
  useEffect(() => {
    if (pendingKey === '' || session.data?.id === undefined) return;
    const sessionId = session.data.id;
    const timer = setInterval(() => {
      for (const [method, a] of pending)
        void api
          .call<{ state: string; error: string | null }>(
            'GET',
            `/api/v1/counter/payments/${encodeURIComponent(a.reference)}?session=${sessionId}`,
          )
          .then((r) => {
            if (r.state !== 'pending')
              setAskedOf((all) => ({
                ...all,
                [Number(method)]: { ...a, state: r.state, error: r.error },
              }));
          })
          .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingKey, session.data?.id]);
  // A receipt scanned into the search box: its sale comes back, to print again or to refund.
  const findSale = useMutation({
    mutationFn: (name: string) =>
      api.call<{ order: Sale }>('GET', `/api/v1/counter/sales?name=${encodeURIComponent(name)}`),
    onSuccess: (r) => {
      setLastSale(r.order);
      setQuery('');
      setError(null);
    },
    onError: () => setError(t('noSale')),
  });
  const findCustomer = useMutation({
    mutationFn: (typed: string) =>
      api.call<{ customer: Customer }>(
        'GET',
        `/api/v1/counter/customers?shop=${shop?.id ?? 0}&q=${encodeURIComponent(typed)}`,
      ),
    onSuccess: (r) => {
      setCustomer(r.customer);
      setCustomerQuery('');
      setCustomerMissing(false);
    },
    onError: () => setCustomerMissing(true),
  });
  const sell = useMutation({
    mutationFn: async (): Promise<{ order: Sale | null; queued: boolean }> => {
      const body = {
        session: session.data?.id,
        clientId: clientId.current,
        ...(customer === null ? {} : { partner: customer.partner }),
        lines: cart.map((l) => ({ product: l.product.id, quantity: String(l.quantity) })),
        // What the server quoted is asked for again with the sale; without a quote, the sale is as shown.
        ...(extras === undefined ? {} : { extras: asked }),
        payments: Object.entries(payments)
          .filter(([, amount]) => Number(amount) > 0)
          .map(([method, amount]) => {
            const proof = askedOf[Number(method)];
            return {
              method: Number(method),
              amount,
              ...(proof === undefined ? {} : { reference: proof.reference }),
            };
          }),
      };
      try {
        const r = await api.call<{ order: Sale }>('POST', '/api/v1/counter/orders', body);
        return { order: r.order, queued: false };
      } catch (error) {
        // Offline: the sale waits on the device, sent in order when the network is back, accepted once by
        // its device reference (offline/queue.ts).
        if (!(error instanceof NetworkError) || offline === undefined) throw error;
        // Something was taken off it by the server: it cannot wait on the device, where nobody can check
        // that the points or the gift card are still there.
        if ((extras?.lines.length ?? 0) > 0) throw new Error(t('needsNetwork'));
        await offline.add({
          kind: 'request',
          method: 'POST',
          path: '/api/v1/counter/orders',
          model: 'pos.order',
          modelLabel: t('cart'),
          recordId: null,
          title: `${t('cart')} ${format.decimal(money(total))}`,
          // Kept as it was paid: nothing is taken off it when it is sent later.
          values: { ...body, extras: undefined },
          etag: null,
        });
        return { order: null, queued: true };
      }
    },
    onSuccess: (r) => {
      if (r.queued) setQueued((n) => n + 1);
      setLastSale(r.order);
      setCart([]);
      setAsked({});
      setTyped({});
      setCustomer(null);
      setCustomerQuery('');
      setCustomerMissing(false);
      setPayments({});
      setAskedOf({});
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
  const [refundReason, setRefundReason] = useState('');
  // The whole last sale taken back, paid back in cash, with its reason.
  const refund = useMutation({
    mutationFn: (id: number) =>
      api.call<{ order: Sale }>('POST', `/api/v1/counter/orders/${id}/refund`, {
        session: session.data?.id,
        reason: refundReason.trim(),
      }),
    onSuccess: (r) => {
      setLastSale(r.order);
      setRefundReason('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['counter', 'session'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
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
      // The shop's receipt (a Mushak 6.3 receipt where the shop issues them).
      const template = await api.call<{ id: number; name: string }>(
        'GET',
        `/api/v1/counter/orders/${sale.id}/receipt-template`,
      );
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
          {shown.map((tile) => {
            const p = tile.kind === 'product' ? tile.product : null;
            const fam = tile.kind === 'family' ? tile : null;
            const name = fam !== null ? fam.name : (p?.name ?? '');
            const image = fam !== null ? fam.image : (p?.image ?? null);
            const price =
              fam !== null
                ? t('variantsFrom', { price: format.decimal(fam.from) })
                : format.decimal(p?.price ?? '0');
            return (
              <li key={tile.kind === 'product' ? tile.product.id : `family-${tile.id}`}>
                <button
                  type="button"
                  className="grid w-full gap-1 rounded-lg border bg-surface p-2 text-start hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => (fam !== null ? setFamily(fam) : p === null ? undefined : add(p))}
                >
                  {image === null ? (
                    <span className="aspect-square w-full rounded bg-muted" aria-hidden />
                  ) : (
                    <img
                      src={`/api/v1/attachments/${image}/download?inline=true&w=256`}
                      alt=""
                      className="aspect-square w-full rounded object-cover"
                    />
                  )}
                  <span className="line-clamp-2 text-sm font-medium">{name}</span>
                  <span className="tabular-nums text-xs text-muted-foreground">{price}</span>
                  {fam !== null ? (
                    <span className="text-xs text-muted-foreground">
                      {t('variantCount', { count: fam.variants.length })}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        <Dialog
          open={family !== null}
          onOpenChange={(o) => {
            if (!o) setFamily(null);
          }}
          title={t('chooseVariant', { name: family?.name ?? '' })}
        >
          <ul className="grid gap-1">
            {(family?.variants ?? []).map((v) => (
              <li key={v.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between"
                  onClick={() => {
                    add(v);
                    setFamily(null);
                  }}
                >
                  <span>{v.values.join(' / ') || v.name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {format.decimal(v.price)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </Dialog>
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
                  onClick={() =>
                    l.quantity <= 1
                      ? removeLine(l.product.id)
                      : setQuantity(l.product.id, l.quantity - 1)
                  }
                >
                  −
                </Button>
                <input
                  aria-label={t('quantityOf', { name: l.product.name })}
                  inputMode="decimal"
                  className="w-14 rounded border bg-surface px-1 text-center tabular-nums"
                  value={String(l.quantity)}
                  onChange={(e) => {
                    const q = Number(e.target.value);
                    if (Number.isFinite(q) && q >= 0) setQuantity(l.product.id, q);
                  }}
                />
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
        {extras === undefined || extras.lines.length === 0 ? null : (
          <ul aria-label={t('takenOff')} className="grid gap-1 border-t pt-2 text-sm">
            {extras.lines.map((l, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: the server's lines have no id, and their order is theirs
                key={`${l.kind}-${index}`}
                className="flex items-baseline justify-between gap-2"
              >
                <span>{l.name}</span>
                <span className="tabular-nums">−{format.decimal(l.amount)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-baseline justify-between border-t pt-2">
          <span className="text-sm font-semibold">{t('total')}</span>
          <span className="text-xl font-semibold tabular-nums" aria-live="polite">
            {format.decimal(money(total))}
          </span>
        </div>
        {extras === undefined || extras.fields.length === 0 ? null : (
          <form
            aria-label={t('extras')}
            className="grid gap-2 rounded-md border p-2"
            onSubmit={(e) => {
              e.preventDefault();
              setAsked(
                Object.fromEntries(
                  Object.entries(typed).filter(([, value]) => value.trim() !== ''),
                ),
              );
            }}
          >
            {extras.fields.map((f) => {
              const problem = extras.problems.find((x) => x.field === f.key);
              return (
                <div key={f.key} className="grid gap-1">
                  <Label htmlFor={`extra-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`extra-${f.key}`}
                    type={f.kind === 'number' ? 'number' : 'text'}
                    inputMode={f.kind === 'number' ? 'numeric' : undefined}
                    min={f.kind === 'number' ? 0 : undefined}
                    max={f.kind === 'number' && f.max !== null ? f.max : undefined}
                    value={typed[f.key] ?? ''}
                    aria-describedby={f.hint === null ? undefined : `extra-${f.key}-hint`}
                    onChange={(e) => setTyped({ ...typed, [f.key]: e.target.value })}
                  />
                  {f.hint === null ? null : (
                    <p id={`extra-${f.key}-hint`} className="text-xs text-muted-foreground">
                      {f.hint}
                    </p>
                  )}
                  {problem === undefined ? null : (
                    <p role="alert" className="text-xs text-destructive">
                      {problem.say}
                    </p>
                  )}
                </div>
              );
            })}
            <div>
              <Button type="submit" size="sm" busy={quote.isFetching}>
                {t('apply')}
              </Button>
            </div>
          </form>
        )}
        {customer === null ? (
          <form
            className="grid gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (customerQuery.trim().length >= 4) findCustomer.mutate(customerQuery.trim());
            }}
          >
            <div className="flex gap-2">
              <Input
                aria-label={t('customer')}
                placeholder={t('customerHint')}
                value={customerQuery}
                onChange={(e) => {
                  setCustomerQuery(e.target.value);
                  setCustomerMissing(false);
                }}
              />
              <Button
                type="submit"
                disabled={customerQuery.trim().length < 4}
                busy={findCustomer.isPending}
              >
                {t('findCustomer')}
              </Button>
            </div>
            {customerMissing ? (
              <p role="alert" className="text-xs text-muted-foreground">
                {t('noCustomer')}
              </p>
            ) : null}
          </form>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: a named group of the sale, not a form's fieldset
          <div
            role="group"
            aria-label={t('customer')}
            className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
          >
            <span>
              <span className="font-semibold">{customer.name}</span>
              {customer.note === null ? null : (
                <span className="block text-xs text-muted-foreground">{customer.note}</span>
              )}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setCustomer(null)}>
              {t('clearCustomer')}
            </Button>
          </div>
        )}
        <Button
          variant="primary"
          disabled={cart.length === 0 || quote.isFetching}
          onClick={() => setPaying(true)}
        >
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
            <div className="grid grid-cols-[1fr_auto] gap-1">
              <Input
                aria-label={t('refundReason')}
                placeholder={t('refundReasonHint')}
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
              />
              <Button
                size="sm"
                variant="ghost"
                busy={refund.isPending}
                disabled={refundReason.trim() === ''}
                onClick={() => refund.mutate(lastSale.id)}
              >
                {t('refund')}
              </Button>
            </div>
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
          {shop.methods.map((m) => {
            const proof = askedOf[m.id];
            return (
              <div key={m.id} className="grid gap-2">
                <div className="grid grid-cols-[1fr_8rem] items-center gap-2">
                  <Label htmlFor={`pay-${m.id}`}>{m.name}</Label>
                  <Input
                    id={`pay-${m.id}`}
                    inputMode="decimal"
                    value={payments[m.id] ?? ''}
                    // What a provider was asked for is what it pays: the amount stays as it was asked.
                    disabled={proof !== undefined && proof.state !== 'failed'}
                    onFocus={() => {
                      if ((payments[m.id] ?? '') === '' && paid < total)
                        setPayments({ ...payments, [m.id]: money(total - paid) });
                    }}
                    onChange={(e) => setPayments({ ...payments, [m.id]: e.target.value })}
                  />
                </div>
                {m.provider !== true ? null : proof === undefined || proof.state === 'failed' ? (
                  <div className="grid gap-1">
                    {proof?.state === 'failed' ? (
                      <p role="alert" className="text-xs text-destructive">
                        {t('paymentFailed')}
                      </p>
                    ) : null}
                    <div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!(Number(payments[m.id] ?? '') > 0)}
                        busy={askPayment.isPending && askPayment.variables === m.id}
                        onClick={() => askPayment.mutate(m.id)}
                      >
                        {t('askToPay')}
                      </Button>
                    </div>
                  </div>
                ) : proof.state === 'done' ? (
                  <p role="status" className="text-sm font-medium">
                    {t('paymentDone', { reference: proof.reference })}
                  </p>
                ) : (
                  <div className="grid justify-items-center gap-1 rounded-md border p-2">
                    <img
                      src={proof.qr}
                      width={200}
                      height={200}
                      alt={t('qrOf', { amount: format.decimal(proof.amount), method: m.name })}
                      className="bg-white"
                    />
                    <p className="text-center text-xs text-muted-foreground">
                      {t('scanToPay', { amount: format.decimal(proof.amount), method: m.name })}
                    </p>
                    <p role="status" className="text-sm">
                      {t('waitingPayment')}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
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
            disabled={paid + 0.004 < total || waiting}
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
