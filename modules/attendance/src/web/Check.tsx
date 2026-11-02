/**
 * Check in from the phone (RFC 0024 §2.2): one large button that checks in, or out when checked in. The phone's
 * location goes with it when the browser gives it; the server decides whether it is on site (the site's geofence)
 * and keeps only inside or outside and the distance. Today's worked hours and lateness under it.
 */
import { Alert, Button, type PageProps, Spinner, useKosh } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';

interface Me {
  readonly employee: { readonly id: number; readonly name: string };
  readonly checkedInSince: string | null;
  readonly today: {
    readonly status: string;
    readonly workedHours: string;
    readonly lateMinutes: number;
    readonly overtimeHours: string;
  } | null;
}

/** The phone's position, or nothing when the browser has none or it is refused (the server then decides). */
function position(): Promise<{ latitude: number; longitude: number } | null> {
  if (typeof navigator === 'undefined' || navigator.geolocation === undefined)
    return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    ),
  );
}

export function Check({ api }: PageProps): ReactElement {
  const { t } = useTranslation('attendance');
  const { format } = useKosh();
  const queryClient = useQueryClient();
  const me = useQuery({
    queryKey: ['attendance', 'me'],
    queryFn: () => api.call<Me>('GET', '/api/v1/attendance/me'),
    retry: false,
  });
  const tap = useMutation({
    mutationFn: async () => {
      const where = await position();
      return api.call<{ action: 'in' | 'out'; at: string }>(
        'POST',
        '/api/v1/attendance/punch',
        where ?? {},
      );
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['attendance', 'me'] }),
  });
  if (me.isPending) return <Spinner label={t('loading')} />;
  if (me.error !== null) return <Alert tone="danger">{me.error.message}</Alert>;
  const since = me.data.checkedInSince;
  return (
    <div className="mx-auto grid max-w-md gap-6 p-4 text-center">
      <div>
        <h1 className="text-xl font-semibold">{me.data.employee.name}</h1>
        <p role="status" className="text-sm text-muted-foreground">
          {since === null ? t('notIn') : t('inSince', { time: format.datetime(since) })}
        </p>
      </div>
      <Button
        variant="primary"
        className="h-32 text-2xl"
        busy={tap.isPending}
        onClick={() => tap.mutate()}
      >
        {since === null ? t('checkIn') : t('checkOut')}
      </Button>
      {tap.error === null ? null : <Alert tone="danger">{tap.error.message}</Alert>}
      {tap.data === undefined ? null : (
        <p className="text-sm">
          {t(tap.data.action === 'in' ? 'doneIn' : 'doneOut', {
            time: format.datetime(tap.data.at),
          })}
        </p>
      )}
      {me.data.today === null ? null : (
        <dl className="grid grid-cols-3 gap-2 rounded-lg border p-3 text-sm">
          <div>
            <dt className="text-muted-foreground">{t('worked')}</dt>
            <dd className="font-semibold tabular-nums">{me.data.today.workedHours}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('late')}</dt>
            <dd className="font-semibold tabular-nums">{me.data.today.lateMinutes}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('overtime')}</dt>
            <dd className="font-semibold tabular-nums">{me.data.today.overtimeHours}</dd>
          </div>
        </dl>
      )}
      <p className="text-xs text-muted-foreground">{t('locationNote')}</p>
    </div>
  );
}
