/**
 * "Refresh the figures" on a project (RFC 0026 step 4), a node component of the project form: the booked and
 * committed costs from the bridges and the health, now, through `POST /api/v1/projects/refresh`; the form reloads.
 * Shown to Projects managers (the money fields are theirs to see); the server decides.
 */
import { Alert, Button, type NodeComponentProps } from '@kosh/ui';
import { useMutation } from '@tanstack/react-query';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';

export function Refresh({
  api,
  record,
  model,
  served,
  reload,
}: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('project');
  const [error, setError] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: () =>
      api.call<{ refreshed: number }>('POST', '/api/v1/projects/refresh', {
        projects: [record?.id],
      }),
    onSuccess: () => {
      setError(null);
      reload();
    },
    onError: (e) => setError(e.message),
  });
  if (record === null || typeof record.id !== 'number') return null;
  if (served.fields[model]?.['budget'] === undefined) return null;
  return (
    <div className="grid gap-2">
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      <div>
        <Button busy={refresh.isPending} onClick={() => refresh.mutate()}>
          {t('refresh.button')}
        </Button>
      </div>
    </div>
  );
}
