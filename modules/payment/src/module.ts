/**
 * The data layer of online payments (RFC 0017 §5.5): a company's payment providers (the adapter, its mode, the
 * journal the money arrives in, the inbound webhook its callbacks come through) and the transactions customers
 * start from the portal (the invoice, the amount, the provider's reference, the state, the `account.payment` that
 * settled it). Credentials are never in records: an adapter reads them from the environment; the callbacks' secret
 * is the endpoint's.
 */
import { randomBytes } from 'node:crypto';
import { accountPortalShutro } from '@kosh/account_portal';
import { integrationsShutro } from '@kosh/integrations';
import { defineModel, defineModule, f } from './.kosh/bindings.js';

const ALL = ['read', 'write', 'create', 'unlink', 'export', 'import'] as const;

/** A transaction's reference: what the provider is told and gives back. */
export const newReference = (): string => `PAY-${randomBytes(9).toString('base64url')}`;

/** The adapters Kosh ships; a module adding one extends this selection. */
export const PROVIDERS = {
  fake: 'Test provider (no money moves)',
  sslcommerz: 'SSLCommerz',
  bkash: 'bKash',
  razorpay: 'Razorpay',
  stripe: 'Stripe',
} as const;

export const PaymentProvider = defineModel('payment.provider', {
  label: 'Payment provider',
  recName: 'name',
  companyScoped: { required: true },
  order: ['sequence asc', 'id asc'],
  tracking: ['state', 'journal'],
  access: { 'account.user': ['read'], 'account.manager': ALL },
  fields: {
    name: f.char({ required: true }),
    code: f.selection(PROVIDERS, { required: true, default: 'fake', label: 'Provider' }),
    state: f.selection(
      { disabled: 'Disabled', test: 'Test', live: 'Live' },
      { required: true, default: 'test', label: 'Mode' },
    ),
    /** Where the money arrives: the payments are registered in this bank (or cash) journal. */
    journal: f.many2one('account.journal', { required: true, checkCompany: true }),
    /** The inbound webhook the provider's callbacks come through (made with the provider). */
    endpoint: f.many2one('webhook.endpoint', { label: 'Callback endpoint' }),
    sequence: f.integer({ required: true, default: 10 }),
  },
});

export const PaymentTransaction = defineModel('payment.transaction', {
  label: 'Payment transaction',
  recName: 'reference',
  companyScoped: { required: true },
  order: ['id desc'],
  tracking: ['state'],
  access: {
    'account.invoicing': ['read'],
    'account.user': ['read', 'export'],
    'account.manager': ['read', 'export'],
  },
  fields: {
    reference: f.char({ required: true, index: 'unique', default: newReference }),
    provider: f.many2one('payment.provider', { required: true, checkCompany: true }),
    move: f.many2one('account.move', { required: true, label: 'Invoice', checkCompany: true }),
    partner: f.many2one('res.partner', { label: 'Customer' }),
    currency: f.many2one('res.currency', { required: true }),
    amount: f.monetary({ currency: 'currency', required: true }),
    state: f.selection(
      {
        pending: 'Pending',
        done: 'Paid',
        failed: 'Failed',
        cancelled: 'Cancelled',
      },
      { required: true, default: 'pending' },
    ),
    providerReference: f.char({ label: 'Provider reference' }),
    /** The payment registered when the provider confirmed. */
    payment: f.many2one('account.payment', { label: 'Payment' }),
    error: f.text(),
    doneAt: f.datetime({ label: 'Paid at' }),
  },
});

export const paymentShutro = defineModule({
  name: 'payment',
  version: '0.1.0',
  depends: [accountPortalShutro, integrationsShutro],
  models: [PaymentProvider, PaymentTransaction],
});
