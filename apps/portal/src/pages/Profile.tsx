/** The user's language and theme, and their password. */
import { Alert, Button, Card, Input, Label, Select, type ThemeChoice, useTheme } from '@kosh/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePortal } from '../portal.js';

export function Profile(): ReactElement {
  const { t } = useTranslation('portal');
  const { api, lang, setLang } = usePortal();
  const [theme, setTheme] = useTheme();
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({
    mutationFn: () => api.call('POST', '/api/v1/auth/password', { current, next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
    },
  });
  return (
    <>
      <h1 className="text-xl font-semibold">{t('profile')}</h1>
      <Card className="grid max-w-md gap-3 p-4">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-lang`}>{t('language')}</Label>
          <Select
            id={`${id}-lang`}
            value={lang.startsWith('bn') ? 'bn_BD' : 'en_US'}
            options={[
              { value: 'en_US', label: 'English' },
              { value: 'bn_BD', label: 'বাংলা' },
            ]}
            onChange={setLang}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-theme`}>{t('theme')}</Label>
          <Select
            id={`${id}-theme`}
            value={theme}
            options={[
              { value: 'light', label: t('light') },
              { value: 'dark', label: t('dark') },
              { value: 'system', label: t('system') },
            ]}
            onChange={(value) => setTheme(value as ThemeChoice)}
          />
        </div>
      </Card>
      <Card className="max-w-md p-4">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <h2 className="font-semibold">{t('changePassword')}</h2>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-current`}>{t('current')}</Label>
            <Input
              id={`${id}-current`}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-next`}>{t('next')}</Label>
            <Input
              id={`${id}-next`}
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </div>
          {change.error === null ? null : <Alert>{change.error.message}</Alert>}
          {change.isSuccess ? <Alert tone="info">{t('changed')}</Alert> : null}
          <Button type="submit" className="justify-self-start" busy={change.isPending}>
            {t('changePassword')}
          </Button>
        </form>
      </Card>
    </>
  );
}
