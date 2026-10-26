/**
 * The user's notification settings (RFC 0006 §8, step 3), opened from the bell: quiet hours (in their time zone)
 * and days off, the daily digest's hour, the fallback channel, and per kind the channels it reaches — email as
 * instant, daily (in the digest) or off. The server validates and stores everything; this dialog shows its answer.
 */
import { Alert, Button, Checkbox, Dialog, Input, type KoshApi, Label, Select } from '@kosh/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Settings {
  readonly quietFrom: string | null;
  readonly quietTo: string | null;
  readonly quietDays: readonly string[];
  readonly digestHour: string;
  readonly fallback: string;
  readonly timezone?: string;
}
interface KindPrefs {
  readonly kind: string;
  readonly channels: Readonly<Record<string, boolean>>;
  readonly emailMode: 'instant' | 'daily' | 'off';
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const SWITCHED = ['inapp', 'webpush', 'sms', 'whatsapp'] as const;
const FALLBACKS = ['email', 'webpush', 'sms', 'whatsapp', 'none'] as const;

const problem = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function NotificationSettings({
  api,
  open,
  onOpenChange,
}: {
  readonly api: KoshApi;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useTranslation('notify');
  const id = useId();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['notifications', 'settings'],
    queryFn: () => api.call<Settings>('GET', '/api/v1/notifications/settings'),
    enabled: open,
  });
  const prefs = useQuery({
    queryKey: ['notifications', 'preferences'],
    queryFn: () => api.call<{ kinds: KindPrefs[] }>('GET', '/api/v1/notifications/preferences'),
    enabled: open,
  });
  const [draft, setDraft] = useState<Settings | null>(null);
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    if (settings.data === undefined) return;
    setDraft(settings.data);
    setQuiet(settings.data.quietFrom !== null);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (values: Settings) =>
      api.call<Settings>('PUT', '/api/v1/notifications/settings', {
        quietFrom: quiet ? values.quietFrom : null,
        quietTo: quiet ? values.quietTo : null,
        quietDays: values.quietDays,
        digestHour: values.digestHour,
        fallback: values.fallback,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications', 'settings'] }),
  });
  const setPref = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.call('PUT', '/api/v1/notifications/preferences', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications', 'preferences'] }),
  });
  const set = (patch: Partial<Settings>) => {
    if (draft !== null) setDraft({ ...draft, ...patch });
    save.reset();
  };
  const kindLabel = (kind: string) => t(`kindNames.${kind}`, { defaultValue: kind });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={t('settings.title')}
      {...(draft?.timezone === undefined
        ? {}
        : { description: t('settings.timezone', { zone: draft.timezone }) })}
    >
      {settings.isError ? <Alert>{problem(settings.error)}</Alert> : null}
      {draft === null ? null : (
        <form
          className="space-y-4"
          aria-label={t('settings.schedule')}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(draft);
          }}
        >
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">{t('settings.quiet')}</legend>
            <p className="text-xs text-muted-foreground">{t('settings.quietHelp')}</p>
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-quiet`}
                checked={quiet}
                onCheckedChange={(checked) => {
                  setQuiet(checked === true);
                  if (checked === true && draft.quietFrom === null)
                    set({ quietFrom: '22:00', quietTo: '07:00' });
                  save.reset();
                }}
              />
              <Label htmlFor={`${id}-quiet`}>{t('settings.quietOn')}</Label>
            </div>
            {quiet ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`${id}-from`}>{t('settings.from')}</Label>
                  <Input
                    id={`${id}-from`}
                    type="time"
                    required
                    value={draft.quietFrom ?? ''}
                    onChange={(e) => set({ quietFrom: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-to`}>{t('settings.to')}</Label>
                  <Input
                    id={`${id}-to`}
                    type="time"
                    required
                    value={draft.quietTo ?? ''}
                    onChange={(e) => set({ quietTo: e.target.value })}
                  />
                </div>
              </div>
            ) : null}
            <fieldset className="space-y-1">
              <legend className="text-sm">{t('settings.daysOff')}</legend>
              <div className="flex flex-wrap gap-3">
                {DAYS.map((day) => (
                  <div key={day} className="flex items-center gap-1.5">
                    <Checkbox
                      id={`${id}-${day}`}
                      checked={draft.quietDays.includes(day)}
                      onCheckedChange={(checked) =>
                        set({
                          quietDays:
                            checked === true
                              ? [...draft.quietDays, day]
                              : draft.quietDays.filter((d) => d !== day),
                        })
                      }
                    />
                    <Label htmlFor={`${id}-${day}`}>{t(`days.${day}`)}</Label>
                  </div>
                ))}
              </div>
            </fieldset>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-digest`}>{t('settings.digestHour')}</Label>
              <Input
                id={`${id}-digest`}
                type="time"
                required
                value={draft.digestHour}
                onChange={(e) => set({ digestHour: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-fallback`}>{t('settings.fallback')}</Label>
              <Select
                id={`${id}-fallback`}
                label={t('settings.fallback')}
                value={draft.fallback}
                options={FALLBACKS.map((c) => ({ value: c, label: t(`channels.${c}`) }))}
                onChange={(fallback) => set({ fallback })}
              />
            </div>
          </div>
          {save.isError ? <Alert>{problem(save.error)}</Alert> : null}
          <div className="flex items-center justify-end gap-3">
            {save.isSuccess ? (
              <span role="status" className="text-sm text-success">
                {t('settings.saved')}
              </span>
            ) : null}
            <Button type="submit" variant="primary" busy={save.isPending}>
              {t('settings.save')}
            </Button>
          </div>
        </form>
      )}

      <section aria-labelledby={`${id}-kinds`} className="mt-6 space-y-2">
        <h3 id={`${id}-kinds`} className="text-sm font-semibold">
          {t('settings.byKind')}
        </h3>
        {setPref.isError ? <Alert>{problem(setPref.error)}</Alert> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b text-start text-xs text-muted-foreground">
                <th scope="col" className="py-2 pe-2 text-start font-medium">
                  {t('settings.kind')}
                </th>
                <th scope="col" className="px-2 py-2 text-start font-medium">
                  {t('channels.email')}
                </th>
                {SWITCHED.map((c) => (
                  <th key={c} scope="col" className="px-2 py-2 text-center font-medium">
                    {t(`channels.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(prefs.data?.kinds ?? []).map((k) => (
                <tr key={k.kind} className="border-b last:border-0">
                  <th scope="row" className="py-2 pe-2 text-start font-normal">
                    {kindLabel(k.kind)}
                  </th>
                  <td className="px-2 py-1">
                    <Select
                      className="h-8 w-32"
                      label={`${kindLabel(k.kind)}: ${t('channels.email')}`}
                      value={k.emailMode}
                      options={(['instant', 'daily', 'off'] as const).map((m) => ({
                        value: m,
                        label: t(`modes.${m}`),
                      }))}
                      onChange={(mode) => setPref.mutate({ kind: k.kind, channel: 'email', mode })}
                    />
                  </td>
                  {SWITCHED.map((c) => (
                    <td key={c} className="px-2 py-1 text-center">
                      <Checkbox
                        aria-label={`${kindLabel(k.kind)}: ${t(`channels.${c}`)}`}
                        checked={k.channels[c] === true}
                        onCheckedChange={(checked) =>
                          setPref.mutate({ kind: k.kind, channel: c, enabled: checked === true })
                        }
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.optIn')}</p>
      </section>
    </Dialog>
  );
}
