/**
 * The data layer of payment providers at the Counter (RFC 0021, Counter step 4): a payment method of a shop may be
 * given a **payment provider** (bKash, a card gateway, …). Such a method is not typed in by the cashier: the till
 * asks the provider for a payment, the customer opens the provider's page from a QR code and pays, and the sale
 * counts that money only once the provider confirmed it — each confirmed payment for one sale, never two.
 * The money is booked by the session's entry, in the method's journal, like every payment of the Counter.
 */
import { askProvider, paymentShutro, paymentUrls, settle, startPayment } from '@kosh/payment';
import { type PaymentAsked, posShutro } from '@kosh/pos';
import { type Module, type ModuleBase, orm } from '@kosh/server/orm';
import { check, defineModule, type Env, extendModel, f, type Records } from './.kosh/bindings.js';

// Only the server writes these.
const SYSTEM = ['base.admin'] as const;
/** Where the customer lands once the provider is done: a page that sends them back to the counter. */
export const PAID_PATH = '/api/v1/public/counter/paid';
/** A pending payment is asked of its provider when it has waited this long for the callback. */
const ASK_AFTER_MS = 4000;

/** The methods (of these) whose journal is not their provider's: the session's entry would book elsewhere. */
async function otherJournal(env: Env, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const methods = await env
    .model('pos.payment.method')
    .browse([...ids] as never)
    .load({ provider: true, journal: true });
  return [...methods]
    .filter((m) => m.provider !== null && m.journal?.id !== m.provider.journal.id)
    .map((m) => m.id as number);
}

export const MethodProvider = extendModel('pos.payment.method', {
  fields: {
    provider: f.many2one('payment.provider', {
      ondelete: 'restrict',
      label: 'Payment provider',
      help: 'With a provider, this method is paid on the provider’s page, which the customer opens from a QR code at the till; the sale counts the money once the provider confirmed it. Its journal is the provider’s.',
    }),
  },
  constraints: {
    // The session's entry books a method in its journal: the provider's money arrives in the provider's.
    providerJournal: {
      ...check('pos.payment.method', ['provider', 'journal'], (methods) =>
        otherJournal(methods.env as unknown as Env, methods.ids as readonly number[]),
      ),
      message:
        'A method paid through a provider books in the provider’s journal: choose that journal.',
    },
  },
});

export const CounterTransaction = extendModel('payment.transaction', {
  fields: {
    posSession: f.many2one('pos.session', {
      ondelete: 'set null',
      label: 'Counter session',
      groups: { write: [...SYSTEM] },
    }),
    posMethod: f.many2one('pos.payment.method', {
      ondelete: 'set null',
      label: 'Counter method',
      groups: { write: [...SYSTEM] },
    }),
    posOrder: f.many2one('pos.order', {
      ondelete: 'set null',
      label: 'Counter sale',
      groups: { write: [...SYSTEM] },
      help: 'The sale this payment paid: a confirmed payment pays one sale.',
    }),
  },
  overrides: {
    // Taken at the till: the session's entry books it, so being paid registers no payment of its own.
    bookedElsewhere: async function (
      this: unknown,
      next: () => Promise<number[]>,
    ): Promise<number[]> {
      const transactions = this as Records<'payment.transaction'>;
      const mine = [...(await transactions.load(['posSession']))]
        .filter((t) => t.posSession !== null)
        .map((t) => t.id as number);
      return [...new Set([...(await next()), ...mine])];
    },
  },
});

/**
 * A pending payment whose callback has not come: the provider's own word settles it now, once. The callback then
 * finds it settled. Returns whether anything changed.
 */
async function askNow(su: Env, reference: string): Promise<boolean> {
  const [t] = await su
    .model('payment.transaction')
    .search({ where: { reference } as never, limit: 1 })
    .then((found) => found.load({ provider: true }));
  if (t === undefined || t.state !== 'pending') return false;
  const word = await askProvider({
    code: t.provider.code,
    mode: t.provider.state === 'live' ? 'live' : 'test',
    reference,
    providerReference: t.providerReference ?? null,
  });
  if (word === null || word.status === 'pending') return false;
  await settle(su as never, word);
  return true;
}

export const ShopPayments = extendModel('pos.shop', {
  overrides: {
    providerMethods: async function (
      this: unknown,
      next: () => Promise<number[]>,
    ): Promise<number[]> {
      const shops = this as Records<'pos.shop'>;
      const methods = await (shops.env as unknown as Env).model('pos.payment.method').search({
        where: { shop: { in: [...shops.ids] }, provider: { isNull: false } } as never,
      });
      return [...new Set([...(await next()), ...methods.ids.map(Number)])];
    },
    requestPayment: async function (
      this: unknown,
      next: (input: PaymentAsked) => Promise<{ reference: string; url: string } | null>,
      input: PaymentAsked,
    ): Promise<{ reference: string; url: string } | null> {
      const su = (this as Records<'pos.shop'>).env as unknown as Env;
      const [method] = await su
        .model('pos.payment.method')
        .browse([input.method as never])
        .load({ provider: true });
      if (method === undefined || method.provider === null) return next(input);
      const [session] = await su
        .model('pos.session')
        .browse([input.session as never])
        .load({ company: { currency: true } });
      if (session === undefined) return null;
      const currency = session.company.currency;
      const started = await startPayment(su as never, {
        provider: method.provider.id as number,
        move: null,
        partner: null,
        currency: {
          id: currency.id as number,
          name: currency.name,
          decimalPlaces: currency.decimalPlaces ?? 2,
        },
        amount: orm.toDecimal(input.amount),
        company: session.company.id as number,
        description: `${session.name} · ${method.name}`,
        returnUrl: `${paymentUrls()?.api ?? ''}${PAID_PATH}`,
        values: { posSession: input.session, posMethod: input.method },
      });
      // A provider's page is an address of its own; the test provider's is a page of this server.
      const url = started.redirectUrl.startsWith('/')
        ? `${paymentUrls()?.api ?? ''}${started.redirectUrl}`
        : started.redirectUrl;
      return { reference: started.reference, url };
    },
    paymentState: async function (
      this: unknown,
      next: (
        session: number,
        reference: string,
      ) => Promise<{ state: string; amount: string; error: string | null } | null>,
      session: number,
      reference: string,
    ): Promise<{ state: string; amount: string; error: string | null } | null> {
      const su = (this as Records<'pos.shop'>).env as unknown as Env;
      const read = async () => {
        const [t] = await su
          .model('payment.transaction')
          .search({ where: { reference, posSession: session } as never, limit: 1 })
          .then((found) => found.load({ provider: true, currency: true }));
        return t;
      };
      let t = await read();
      if (t === undefined) return next(session, reference);
      // The callback has not come after a moment: the provider is asked (the till asks every few seconds).
      if (
        t.state === 'pending' &&
        Date.now() - new Date(t.createdAt as never).getTime() > ASK_AFTER_MS &&
        (await askNow(su, reference))
      )
        t = (await read()) ?? t;
      return {
        state: t.state,
        amount: t.amount.amount.toFixed(t.currency.decimalPlaces ?? 2),
        error: t.error ?? null,
      };
    },
  },
});

export const SalePayments = extendModel('pos.order', {
  overrides: {
    // A payment by a method that has a provider is the provider's confirmed payment, of this session, for this
    // amount, not used by another sale — and from now on it is this sale's.
    settlePayments: async function (
      this: unknown,
      next: () => Promise<string | null>,
    ): Promise<string | null> {
      const before = await next();
      if (before !== null) return before;
      const orders = this as Records<'pos.order'>;
      const su = orders.env as unknown as Env;
      for (const o of await orders.load({ payments: { method: true }, session: true })) {
        for (const p of o.payments) {
          const [method] = await su
            .model('pos.payment.method')
            .browse([p.method.id as never])
            .load({ provider: true });
          if (method === undefined || method.provider === null) continue;
          const reference = (p.reference ?? '').trim();
          if (reference === '')
            return `${method.name} is paid on the provider’s page: ask the customer to pay first.`;
          const [t] = await su.model('payment.transaction').search({
            where: {
              reference,
              posSession: o.session.id,
              provider: method.provider.id,
            } as never,
            limit: 1,
          });
          if (t === undefined) return `${method.name}: there is no payment ${reference} here.`;
          // The customer says they paid and the callback is late: the provider is asked before refusing.
          if (t.state === 'pending' && (await askNow(su, reference))) {
            const [now] = await su
              .model('payment.transaction')
              .browse([t.id as never])
              .load(['state']);
            if (now?.state !== 'done')
              return `${method.name}: the payment ${reference} is not confirmed yet.`;
          } else if (t.state !== 'done')
            return `${method.name}: the payment ${reference} is not confirmed yet.`;
          if (t.posOrder !== null && (t.posOrder as unknown) !== o.id)
            return `${method.name}: the payment ${reference} already paid another sale.`;
          if (!t.amount.amount.eq(p.amount))
            return `${method.name}: ${reference} was a payment of ${t.amount.amount.toFixed(2)}, not ${p.amount.toFixed(2)}.`;
          await su
            .model('payment.transaction')
            .browse([t.id as never])
            .write({ posOrder: o.id } as never);
        }
      }
      await su.flush();
      return null;
    },
  },
});

// Named so the module's type stays short enough to emit (TS7056) with every model its dependencies carry.
const DEPENDS: readonly ModuleBase[] = [posShutro, paymentShutro];
const MODELS = [] as const;
const EXTENSIONS = [MethodProvider, CounterTransaction, ShopPayments, SalePayments] as const;

export const posPaymentShutro: Module<typeof MODELS, readonly ModuleBase[], typeof EXTENSIONS> =
  defineModule({
    name: 'pos_payment',
    version: '0.1.0',
    depends: DEPENDS,
    groups: [
      orm.defineGroup({
        code: 'pos_payment.user',
        label: 'Payment providers at the Counter',
        implies: ['pos.cashier'],
      }),
    ],
    models: MODELS,
    extensions: EXTENSIONS,
  });
