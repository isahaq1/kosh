/**
 * Set the kiosk PIN on an employee's form (RFC 0024 §2.2), placed by a view extension. Shown to those who may read
 * the person's attendance details (Attendance managers); the PIN goes to the server, which stores only its hash.
 */
import { Alert, Button, Dialog, Input, Label, type NodeComponentProps } from '@kosh/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function PinButton({ record, api }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('attendance');
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.call('POST', `/api/v1/attendance/employees/${String(record?.['id'])}/pin`, { pin }),
    onSuccess: () => {
      setPin('');
      setOpen(false);
    },
  });
  // The badge is readable by Attendance managers only: without it, nothing to set here.
  if (record === null || typeof record['id'] !== 'number' || !('attendanceBadge' in record))
    return null;
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {t('setPin')}
      </Button>
      {save.isSuccess ? (
        <span className="text-sm text-muted-foreground">{t('pinSaved')}</span>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen} title={t('setPin')} description={t('pinHelp')}>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Label htmlFor={id}>{t('newPin')}</Label>
          <Input
            id={id}
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]{4,8}"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
          />
          {save.error === null ? null : <Alert tone="danger">{save.error.message}</Alert>}
          <Button type="submit" variant="primary" busy={save.isPending} disabled={pin.length < 4}>
            {t('savePin')}
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
