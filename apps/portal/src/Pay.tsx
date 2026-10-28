/**
 * Paying a document online (RFC 0017 §5.5): Pay now sends the customer to the provider's page; back here
 * (`?payment=<reference>`), the server's word on the payment — asked again while the provider has not confirmed.
 * The server decides what is payable and what was paid; the page shows it.
 */
import { Alert, Button } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { type ReactElement, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { usePortal } from './portal.js';

interface Provider {
  readonly id: number;
  readonly name: string;
  readonly test: boolean;
}
interface PaymentState {
  readonly reference: string;
  readonly state: 'pending' | 'done' | 'failed' | 'cancelled';
  readonly amount: string;
  readonly currency: string;
  readonly error: string | null;
}

/** The Pay now buttons of a payable document (nothing when no provider is offered). */
export function PayButtons({
  document,
  id,
}: {
  readonly document: string;
  readonly id: string;
}): ReactElement | null {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const providers = useQuery({
    queryKey: ['portal', 'payment-providers'],
    queryFn: () => api.call<{ providers: Provider[] }>('GET', '/api/portal/v1/payments/providers'),
    retry: false,
  });
  const start = useMutation({
    mutationFn: (provider: number) =>
      api.call<{ reference: string; redirectUrl: string }>('POST', '/api/portal/v1/payments', {
        document,
        id: Number(id),
        provider,
      }),
    onSuccess: ({ redirectUrl }) => window.location.assign(redirectUrl),
  });
  const offered = providers.data?.providers ?? [];
  if (offered.length === 0) return null;
  const label = (p: Provider) => (p.test ? t('payTest', { name: p.name }) : p.name);
  return (
    <>
      {offered.map((p) => (
        <Button
          key={p.id}
          variant="primary"
          busy={start.isPending && start.variables === p.id}
          onClick={() => start.mutate(p.id)}
        >
          <CreditCard aria-hidden />
          {offered.length === 1 ? t('payNow') : `${t('payWith')} ${label(p)}`}
        </Button>
      ))}
      {start.error === null ? null : <Alert>{start.error.message}</Alert>}
    </>
  );
}

/** The outcome of the payment the customer comes back from. */
export function PaymentOutcome({ reference }: { readonly reference: string }): ReactElement | null {
  const { t } = useTranslation('portal');
  const { api } = usePortal();
  const queryClient = useQueryClient();
  const payment = useQuery({
    queryKey: ['portal', 'payment', reference],
    queryFn: () =>
      api.call<PaymentState>('GET', `/api/portal/v1/payments/${encodeURIComponent(reference)}`),
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? 2000 : false),
  });
  const state = payment.data?.state;
  useEffect(() => {
    // Paid: the document's amounts and state changed.
    if (state === 'done') void queryClient.invalidateQueries({ queryKey: ['portal', 'document'] });
  }, [state, queryClient]);
  if (payment.isError) return <Alert>{payment.error.message}</Alert>;
  const p = payment.data;
  if (p === undefined || p.state === 'pending') return <Alert tone="info">{t('paying')}</Alert>;
  if (p.state === 'done')
    return <Alert tone="info">{t('paid', { amount: p.amount, currency: p.currency })}</Alert>;
  return (
    <Alert>
      {p.state === 'cancelled' ? t('payCancelled') : t('payFailed', { error: p.error ?? '' })}
    </Alert>
  );
}
