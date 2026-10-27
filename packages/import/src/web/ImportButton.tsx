/**
 * "Import" next to every list's "New" (RFC 0014 §5.8): shown when the user may import into the model and the import
 * module answers; it opens the import screen.
 */
import { Button, type CreateAssistProps } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { type ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImportWizard } from './ImportWizard.js';

export function ImportButton({ api, model }: CreateAssistProps): ReactElement | null {
  const { t } = useTranslation('import');
  const [open, setOpen] = useState(false);
  const meta = useQuery({
    queryKey: ['meta', model],
    queryFn: () => api.meta(model),
    staleTime: 60_000,
  });
  // The import module may not be installed, or the user may lack Import data: then the button stays hidden.
  const available = useQuery({
    queryKey: ['import', 'mappings', model],
    queryFn: () =>
      api.call<{ mappings: unknown[] }>(
        'GET',
        `/api/v1/import-mappings?model=${encodeURIComponent(model)}`,
      ),
    enabled: meta.data?.operations.import === true,
    retry: false,
    staleTime: 60_000,
  });
  if (meta.data?.operations.import !== true || available.data === undefined) return null;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Upload aria-hidden />
        {t('import')}
      </Button>
      <ImportWizard api={api} model={model} open={open} onOpenChange={setOpen} />
    </>
  );
}
