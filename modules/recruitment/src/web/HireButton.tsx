/**
 * "Hire" on an applicant in progress (a node component of the applicant form): a confirmation that names what
 * happens — the Workforce employee is made from the applicant, the applicant moves to the hired stage, and the
 * opening closes when its headcount is reached — through `POST /api/v1/hiring/applicants/:id/hire`; the form
 * reloads afterwards. Shown to hiring managers (the expected salary, theirs only, is the hint); the server decides.
 */
import { Alert, Button, Dialog, type NodeComponentProps } from '@kosh/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function HireButton({
  api,
  record,
  model,
  served,
  reload,
}: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('recruitment');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hire = useMutation({
    mutationFn: () =>
      api.call<{ employee: number; openingClosed: boolean }>(
        'POST',
        `/api/v1/hiring/applicants/${String(record?.id)}/hire`,
        {},
      ),
    onSuccess: () => {
      setOpen(false);
      setError(null);
      reload();
    },
    onError: (e) => setError(e.message),
  });
  if (record === null || typeof record.id !== 'number') return null;
  if (record['status'] !== 'active') return null;
  if (served.fields[model]?.['expectedSalary'] === undefined) return null;
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        {t('hire.button')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('hire.title', { name: String(record['name'] ?? '') })}
        footer={
          <Button variant="primary" busy={hire.isPending} onClick={() => hire.mutate()}>
            {t('hire.confirm')}
          </Button>
        }
      >
        <div className="grid gap-3">
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <p className="text-sm">{t('hire.explain')}</p>
        </div>
      </Dialog>
    </>
  );
}
