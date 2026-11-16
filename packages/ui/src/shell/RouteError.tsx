/**
 * What a page shows when it fails to render (RFC 0034 §2.2): what happened in the user's language, the reference
 * of a failed request to quote to support, Try again (the page renders anew) and Reload (the app loads anew) —
 * instead of the router's own English error box.
 */
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, NetworkError } from '../api.js';
import { Alert, Button } from '../components/primitives.js';

export function RouteError({ error, reset }: ErrorComponentProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const detail =
    error instanceof ApiError || error instanceof NetworkError
      ? error.message
      : t('app.errorUnexpected');
  const reference = error instanceof ApiError ? error.reference : undefined;
  return (
    <div className="mx-auto max-w-xl p-6" role="alert" data-kosh-route-error="">
      <Alert
        action={
          <span className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                reset();
                void router.invalidate();
              }}
            >
              {t('app.retry')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
              {t('app.reload')}
            </Button>
          </span>
        }
      >
        <strong className="block">{t('app.error')}</strong>
        <span className="block">{detail}</span>
        {reference === undefined ? null : (
          <span className="block text-xs opacity-75">{t('app.reference', { reference })}</span>
        )}
      </Alert>
    </div>
  );
}
