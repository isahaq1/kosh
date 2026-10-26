/**
 * Studio mode (RFC 0012 §5.6): a header button for Administrators and Studio managers (the server says who: anyone
 * else gets 403 and sees nothing). While it is on, forms and lists offer "Add field" / "Add column"; the spot the
 * user chooses opens this dialog: which module saves it, a new field or one the model has, then the review. After
 * Apply the page reloads: the views come back from the server with the change.
 */
import {
  Alert,
  Button,
  type DesignSpot,
  Dialog,
  type HeaderItemProps,
  type KoshApi,
  Label,
  Select,
  useDesign,
  type ViewField,
} from '@kosh/ui';
import { type UseQueryResult, useMutation, useQuery } from '@tanstack/react-query';
import { PencilRuler } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StudioEdit } from '../edit.js';
import type { StudioSpec } from '../spec.js';
import { EMPTY_FIELD, type FieldDraft, FieldEditor, fieldOf } from './FieldEditor.js';
import { message, ReviewDialog, type StudioMode } from './Review.js';

export interface StudioInfo {
  readonly mode: StudioMode;
  readonly git: {
    readonly provider: 'github' | 'gitlab';
    readonly repository: string;
    readonly base: string;
  } | null;
  readonly modules: readonly {
    readonly name: string;
    readonly label: string;
    readonly version: string;
  }[];
}

/** Studio's mode and modules; undefined for users without Studio. */
export function useStudioInfo(api: KoshApi): UseQueryResult<StudioInfo> {
  return useQuery({
    queryKey: ['studio', 'info'],
    queryFn: () => api.call<StudioInfo>('GET', '/api/v1/studio'),
    retry: false,
    staleTime: 60_000,
  });
}

/** The module a change is saved in: an existing Studio module, or a new `custom` one. */
export function ModuleSelect({
  info,
  value,
  onChange,
}: {
  readonly info: StudioInfo;
  readonly value: string;
  readonly onChange: (name: string) => void;
}): ReactElement {
  const { t } = useTranslation('studio');
  const id = useId();
  const options = [
    ...info.modules.map((m) => ({ value: m.name, label: `${m.label} (${m.name})` })),
    ...(info.modules.some((m) => m.name === 'custom')
      ? []
      : [{ value: 'custom', label: t('newModule') }]),
  ];
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{t('module')}</Label>
      <Select id={id} label={t('module')} value={value} options={options} onChange={onChange} />
    </div>
  );
}

export const reloadSoon = (): void => {
  window.setTimeout(() => window.location.reload(), 900);
};

function AddDialog({
  api,
  info,
  spot,
  onClose,
}: {
  readonly api: KoshApi;
  readonly info: StudioInfo;
  readonly spot: DesignSpot;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation('studio');
  const id = useId();
  const [module, setModule] = useState(info.modules[0]?.name ?? 'custom');
  const [draft, setDraft] = useState<FieldDraft>(EMPTY_FIELD);
  const [existing, setExisting] = useState<string | null>(null);
  const [spec, setSpec] = useState<StudioSpec | null>(null);
  const meta = useQuery({
    queryKey: ['studio', 'meta', spot.model],
    queryFn: () =>
      api.call<{ fields: readonly ViewField[] }>(
        'GET',
        `/api/v1/meta/${encodeURIComponent(spot.model)}`,
      ),
    enabled: spot.kind === 'list',
  });
  const hidden =
    spot.kind === 'list'
      ? (meta.data?.fields ?? []).filter(
          (f) => !spot.shown.includes(f.key) && f.kind !== 'one2many',
        )
      : [];
  const anchor = spot.kind === 'form' ? { append: spot.group } : { insertAfter: spot.after };
  const edit = useMutation({
    mutationFn: () => {
      const change: StudioEdit =
        existing !== null && spot.kind === 'list'
          ? { kind: 'show', view: spot.view, field: existing, anchor }
          : { kind: 'field', model: spot.model, field: fieldOf(draft), view: spot.view, anchor };
      return api.call<{ spec: StudioSpec }>('POST', '/api/v1/studio/edit', {
        module,
        edit: change,
      });
    },
    onSuccess: (result) => setSpec(result.spec),
  });
  if (spec !== null)
    return (
      <ReviewDialog
        api={api}
        spec={spec}
        mode={info.mode}
        git={info.git}
        onClose={() => setSpec(null)}
        onApplied={reloadSoon}
      />
    );
  const where = spot.kind === 'form' ? (spot.groupLabel ?? t('section')) : '';
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={spot.kind === 'form' ? t('addFieldTitle', { where }) : t('addColumnTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            busy={edit.isPending}
            disabled={existing === null && draft.label.trim() === ''}
            onClick={() => edit.mutate()}
          >
            {t('review')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ModuleSelect info={info} value={module} onChange={setModule} />
        {spot.kind === 'list' && hidden.length > 0 ? (
          <div className="space-y-1">
            <Label htmlFor={`${id}-existing`}>{t('field')}</Label>
            <Select
              id={`${id}-existing`}
              label={t('field')}
              value={existing ?? ''}
              options={[
                { value: '', label: t('newField') },
                ...hidden.map((f) => ({ value: f.key, label: f.label })),
              ]}
              onChange={(v) => setExisting(v === '' ? null : v)}
            />
          </div>
        ) : null}
        {existing === null ? <FieldEditor value={draft} onChange={setDraft} /> : null}
        {edit.isError ? <Alert>{message(edit.error)}</Alert> : null}
      </div>
    </Dialog>
  );
}

/** The header button (registered as `studio.Toggle`). */
export function StudioToggle({ api }: HeaderItemProps): ReactElement | null {
  const { t } = useTranslation('studio');
  const design = useDesign();
  const info = useStudioInfo(api);
  if (info.data === undefined) return null;
  return (
    <>
      <Button
        size="sm"
        variant={design.active ? 'primary' : 'ghost'}
        aria-pressed={design.active}
        title={design.active ? t('banner') : t('toggleOff')}
        onClick={() => design.setActive(!design.active)}
      >
        <PencilRuler aria-hidden />
        <span className="hidden sm:inline">{t('studio')}</span>
      </Button>
      {design.spot === null ? null : (
        <AddDialog
          api={api}
          info={info.data}
          spot={design.spot}
          onClose={() => design.choose(null)}
        />
      )}
    </>
  );
}
