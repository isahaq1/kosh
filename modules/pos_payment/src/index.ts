/**
 * @packageDocumentation
 * `@kosh/pos_payment` (RFC 0021, Counter step 4): payment providers at the Counter. Proposed whenever the Counter
 * and online payments are installed.
 *
 * - A shop's payment method is given a **payment provider**; at the till it shows a QR code the customer scans
 *   to pay on the provider's page — or, by the method's way, the provider sends the request to the customer's
 *   **phone**, or to the **card terminal** on the counter (step 5).
 * - The sale counts that payment once the provider **confirmed** it — by its callback, or asked when the callback
 *   is late — for the amount asked, in the cashier's session, and for one sale only.
 * - The session's entry books it in the method's journal, like every payment of the Counter.
 *
 * - `GET /api/v1/public/counter/paid`   where the provider sends the customer back: "go back to the counter"
 */
import { defineModule } from '@kosh/modules-sdk';
import { payment } from '@kosh/payment';
import { pos } from '@kosh/pos';
import type { ModuleContext } from '@kosh/server';
import { field } from '@kosh/views';
import { PAID_PATH, posPaymentShutro } from './module.js';

export {
  CounterTransaction,
  MethodProvider,
  PAID_PATH,
  posPaymentShutro,
  SalePayments,
  ShopPayments,
} from './module.js';

const PAGE = (lang: 'en' | 'bn'): string => {
  const text =
    lang === 'bn'
      ? ['পরিশোধ', 'ধন্যবাদ। এখন কাউন্টারে ফিরে যান: বিক্রেতা আপনার পরিশোধ দেখতে পাবেন।']
      : ['Payment', 'Thank you. Go back to the counter now: the cashier sees your payment.'];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${text[0]}</title><style>:root{color-scheme:light dark}body{font:18px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center}</style></head>
<body><main><p role="status">${text[1]}</p></main></body></html>`;
};

export const posPayment: ReturnType<typeof defineModule> = defineModule({
  shutro: posPaymentShutro,
  kosh: '^0.1.0',
  depends: [pos, payment],
  bridge: [pos, payment],
  // Bangla for the labels it serves (RFC 0023 §3.1; `pnpm i18n:extract`).
  i18n: { bn: () => import('./i18n/bn.js') },
  accessLevels: {
    user: { label: 'Payment providers at the Counter', groups: ['pos_payment.user'] },
  },
  viewExtensions: [
    {
      view: 'pos.shop.form',
      operations: [
        // A column of the shop's payment methods, after the journal.
        {
          insertAfter: 'journal',
          nodes: [
            field({ field: 'provider', id: 'method_provider' }),
            field({ field: 'payWay', id: 'method_pay_way' }),
            field({ field: 'terminal', id: 'method_terminal' }),
          ],
        },
      ],
    },
  ],
  routes: (context: ModuleContext) => {
    // Where a provider sends the customer once they paid or gave up: nothing of the payment is said here.
    for (const method of ['GET', 'POST'] as const)
      context.app.route({
        method,
        url: PAID_PATH,
        config: { auth: false },
        handler: async (request, reply) => {
          const bangla = /^\s*bn\b/i.test(String(request.headers['accept-language'] ?? ''));
          return reply
            .type('text/html; charset=utf-8')
            .headers({
              'content-security-policy':
                "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            })
            .send(PAGE(bangla ? 'bn' : 'en'));
        },
      });
  },
});
