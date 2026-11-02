/**
 * The kiosk (RFC 0024 §2.2): a tablet at the gate, signed in with the kiosk role. A badge scanned into the box (a
 * scanner types its code and Enter), or a name chosen and a PIN typed on the pad, checks the person in or out;
 * the screen greets them and clears itself after a few seconds. Five wrong PINs lock the person for 15 minutes.
 */
import { Alert, Button, Input, type PageProps } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Result {
  readonly action: 'in' | 'out';
  readonly at: string;
  readonly employee: { readonly id: number; readonly name: string };
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'] as const;

export function Kiosk({ api }: PageProps): ReactElement {
  const { t } = useTranslation('attendance');
  const people = useQuery({
    queryKey: ['attendance', 'kiosk', 'people'],
    queryFn: () =>
      api
        .call<{ people: { id: number; name: string }[] }>('GET', '/api/v1/attendance/kiosk/people')
        .then((r) => r.people),
  });
  const [badge, setBadge] = useState('');
  const [person, setPerson] = useState<{ id: number; name: string } | null>(null);
  const [pin, setPin] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const punch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.call<Result>('POST', '/api/v1/attendance/kiosk/punch', body),
    onSettled: () => {
      setBadge('');
      setPin('');
      setPerson(null);
    },
  });
  // The greeting clears itself; the badge box keeps the focus for the next scan.
  useEffect(() => {
    if (punch.data === undefined && punch.error === null) return;
    const timer = window.setTimeout(() => {
      punch.reset();
      box.current?.focus();
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [punch]);
  const press = (key: (typeof KEYS)[number]) => {
    if (key === '⌫') setPin((p) => p.slice(0, -1));
    else if (key === '✓') {
      if (person !== null && pin.length >= 4) punch.mutate({ employee: person.id, pin });
    } else if (pin.length < 8) setPin((p) => p + key);
  };
  return (
    <div className="mx-auto grid max-w-2xl gap-6 p-4">
      <h1 className="text-center text-2xl font-semibold">{t('kioskTitle')}</h1>
      {punch.data === undefined ? null : (
        <p role="status" className="rounded-lg bg-success/10 p-6 text-center text-xl font-semibold">
          {t(punch.data.action === 'in' ? 'welcome' : 'goodbye', {
            name: punch.data.employee.name,
          })}
        </p>
      )}
      {punch.error === null ? null : <Alert tone="danger">{punch.error.message}</Alert>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (badge.trim() !== '') punch.mutate({ badge: badge.trim() });
        }}
      >
        <Input
          ref={box}
          autoFocus
          aria-label={t('badge')}
          placeholder={t('badgeHint')}
          value={badge}
          onChange={(e) => setBadge(e.target.value)}
          className="h-12 text-center text-lg"
        />
      </form>
      <div className="grid gap-4 md:grid-cols-2">
        <nav aria-label={t('people')} className="max-h-80 overflow-y-auto rounded-lg border">
          <ul>
            {(people.data ?? []).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  aria-pressed={person?.id === p.id}
                  onClick={() => {
                    setPerson(p);
                    setPin('');
                  }}
                  className={`w-full px-3 py-2 text-start hover:bg-muted ${person?.id === p.id ? 'bg-accent text-accent-foreground' : ''}`}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="grid gap-2">
          <p aria-live="polite" className="text-center text-sm text-muted-foreground">
            {person === null ? t('choose') : t('pinFor', { name: person.name })}
          </p>
          <output aria-label={t('pin')} className="h-10 text-center text-2xl tracking-[0.5em]">
            {'•'.repeat(pin.length)}
          </output>
          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => (
              <Button
                key={k}
                variant={k === '✓' ? 'primary' : 'secondary'}
                className="h-14 text-xl"
                aria-label={k === '⌫' ? t('erase') : k === '✓' ? t('enter') : k}
                disabled={person === null || punch.isPending}
                onClick={() => press(k)}
              >
                {k}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
