/**
 * The Studio app's page (`studio.Studio`, RFC 0012 §5.6): the Studio modules of the project with their versions,
 * the mode (write or propose), and "New model": a model of the module's own with its fields and a menu entry in
 * the module's app, reviewed and applied (or proposed) like every Studio change.
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  type PageProps,
  Spinner,
} from '@kosh/ui';
import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StudioEdit } from '../edit.js';
import type { StudioSpec } from '../spec.js';
import { EMPTY_FIELD, type FieldDraft, FieldEditor, fieldOf } from './FieldEditor.js';
import { message, ReviewDialog } from './Review.js';
import { ApprovalSection, type Proposed, RulesSection } from './Sections.js';
import { ModuleSelect, reloadSoon, useStudioInfo } from './StudioToggle.js';

export function StudioPage({ api, label }: PageProps): ReactElement {
  const { t } = useTranslation('studio');
  const id = useId();
  const info = useStudioInfo(api);
  const [module, setModule] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState('');
  const [menuLabel, setMenuLabel] = useState('');
  const [fields, setFields] = useState<readonly FieldDraft[]>([{ ...EMPTY_FIELD }]);
  const [proposed, setProposed] = useState<Proposed | null>(null);
  const edit = useMutation({
    mutationFn: (target: string) => {
      const change: StudioEdit = {
        kind: 'model',
        model: { label: modelLabel.trim(), fields: fields.map(fieldOf) },
        menu: { label: menuLabel.trim() === '' ? modelLabel.trim() : menuLabel.trim() },
      };
      return api.call<{ spec: StudioSpec }>('POST', '/api/v1/studio/edit', {
        module: target,
        edit: change,
      });
    },
    onSuccess: (result) => setProposed({ spec: result.spec, retire: [] }),
  });

  if (info.isPending) return <Spinner label={t('studio')} />;
  if (info.data === undefined) return <Alert>{message(info.error)}</Alert>;
  const data = info.data;
  const target = module ?? data.modules[0]?.name ?? 'custom';
  const ready = modelLabel.trim() !== '' && fields.every((f) => f.label.trim() !== '');

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{label ?? t('modulesTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('modulesIntro')}</p>
      </header>
      <Alert tone="info">{data.mode === 'write' ? t('modeWrite') : t('modePropose')}</Alert>

      <section aria-labelledby={`${id}-modules`} className="space-y-2">
        <h2 id={`${id}-modules`} className="text-base font-semibold">
          {t('modulesTitle')}
        </h2>
        {data.modules.length === 0 ? (
          <EmptyState title={t('none')} />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.modules.map((m) => (
              <li key={m.name}>
                <Card className="flex items-center justify-between gap-2 p-3">
                  <div>
                    <div className="font-medium">{m.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{m.name}</div>
                  </div>
                  <Badge>{t('version', { version: m.version })}</Badge>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${id}-new`} className="space-y-4">
        <h2 id={`${id}-new`} className="text-base font-semibold">
          {t('newModel')}
        </h2>
        <Card className="space-y-4 p-4">
          <ModuleSelect info={data} value={target} onChange={setModule} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-model`}>{t('modelLabel')}</Label>
              <Input
                id={`${id}-model`}
                value={modelLabel}
                maxLength={60}
                onChange={(e) => setModelLabel(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-menu`}>{t('menuLabel')}</Label>
              <Input
                id={`${id}-menu`}
                value={menuLabel}
                maxLength={60}
                onChange={(e) => setMenuLabel(e.target.value)}
              />
            </div>
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">{t('fields')}</legend>
            {fields.map((f, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place and never reordered
                key={i}
                className="flex items-start gap-2 rounded-md border p-3"
              >
                <div className="flex-1">
                  <FieldEditor
                    value={f}
                    onChange={(next) => setFields(fields.map((x, j) => (j === i ? next : x)))}
                  />
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('removeRow', { n: i + 1 })}
                  disabled={fields.length === 1}
                  onClick={() => setFields(fields.filter((_, j) => j !== i))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFields([...fields, { ...EMPTY_FIELD }])}
            >
              <Plus aria-hidden />
              {t('addRow')}
            </Button>
          </fieldset>
          {edit.isError ? <Alert>{message(edit.error)}</Alert> : null}
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!ready}
              busy={edit.isPending}
              onClick={() => edit.mutate(target)}
            >
              {t('review')}
            </Button>
          </div>
        </Card>
      </section>

      <ApprovalSection api={api} module={target} onPropose={setProposed} />
      <RulesSection api={api} module={target} onPropose={setProposed} />

      {proposed === null ? null : (
        <ReviewDialog
          api={api}
          spec={proposed.spec}
          retire={proposed.retire}
          mode={data.mode}
          git={data.git}
          onClose={() => setProposed(null)}
          onApplied={reloadSoon}
        />
      )}
    </div>
  );
}
