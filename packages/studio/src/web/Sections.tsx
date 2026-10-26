/**
 * The Studio page's sections for approval policies and automation rules (RFC 0012 step 5): a rule made in the
 * Automation app moves into a Studio module (the module ships it; the original is archived on apply), and an
 * approval policy with its levels is added to a module. The server merges, checks and plans; these forms only
 * collect what the user wants.
 */
import { Alert, Button, Card, EmptyState, Input, type KoshApi, Label } from '@kosh/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type ReactElement, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { StudioEdit } from '../edit.js';
import type { StudioApproval, StudioSpec } from '../spec.js';
import { message } from './Review.js';

/** What a section hands to the page: the spec to review, and the rules to archive after apply. */
export interface Proposed {
  readonly spec: StudioSpec;
  readonly retire: readonly number[];
}

const editOf = (
  api: KoshApi,
  module: string,
  edit: StudioEdit | { kind: 'move-rule'; rule: number },
) =>
  api.call<{ spec: StudioSpec; retire: number[] }>('POST', '/api/v1/studio/edit', { module, edit });

interface RuleRow {
  readonly id: number;
  readonly name: string;
  readonly targetModel: string;
  readonly trigger: string;
  readonly enabled: boolean;
}

export function RulesSection({
  api,
  module,
  onPropose,
}: {
  readonly api: KoshApi;
  readonly module: string;
  readonly onPropose: (proposed: Proposed) => void;
}): ReactElement {
  const { t } = useTranslation('studio');
  const id = useId();
  const rules = useQuery({
    queryKey: ['studio', 'rules'],
    queryFn: () => api.call<{ rules: RuleRow[] }>('GET', '/api/v1/studio/rules'),
  });
  const move = useMutation({
    mutationFn: (rule: number) => editOf(api, module, { kind: 'move-rule', rule }),
    onSuccess: onPropose,
  });
  const list = rules.data?.rules ?? [];
  return (
    <section aria-labelledby={`${id}-rules`} className="space-y-2">
      <h2 id={`${id}-rules`} className="text-base font-semibold">
        {t('rulesTitle')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('rulesIntro')}</p>
      {rules.isError ? <Alert>{message(rules.error)}</Alert> : null}
      {move.isError ? <Alert>{message(move.error)}</Alert> : null}
      {rules.isSuccess && list.length === 0 ? (
        <EmptyState title={t('noRules')} />
      ) : (
        <ul className="space-y-2">
          {list.map((r) => (
            <li key={r.id}>
              <Card className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {r.targetModel} · {r.trigger}
                  </div>
                </div>
                <Button
                  size="sm"
                  aria-label={`${t('moveRule')}: ${r.name}`}
                  busy={move.isPending && move.variables === r.id}
                  onClick={() => move.mutate(r.id)}
                >
                  {t('moveRule')}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface LevelDraft {
  readonly name: string;
  readonly approverRole: string;
  readonly field: string;
  readonly above: string;
}
const EMPTY_LEVEL: LevelDraft = { name: '', approverRole: '', field: '', above: '' };

export function ApprovalSection({
  api,
  module,
  onPropose,
}: {
  readonly api: KoshApi;
  readonly module: string;
  readonly onPropose: (proposed: Proposed) => void;
}): ReactElement {
  const { t } = useTranslation('studio');
  const id = useId();
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [levels, setLevels] = useState<readonly LevelDraft[]>([EMPTY_LEVEL]);
  const add = useMutation({
    mutationFn: () => {
      const approval: StudioApproval = {
        name: name.trim(),
        model: model.trim(),
        levels: levels.map((l) => ({
          name: l.name.trim(),
          approverRole: l.approverRole.trim(),
          // Amounts stay strings: the server compares them as decimals.
          ...(l.field.trim() === '' || l.above.trim() === ''
            ? {}
            : { condition: { [l.field.trim()]: { gt: l.above.trim() } } }),
        })),
      };
      return editOf(api, module, { kind: 'approval', approval });
    },
    onSuccess: onPropose,
  });
  const ready =
    name.trim() !== '' &&
    model.trim() !== '' &&
    levels.every((l) => l.name.trim() !== '' && l.approverRole.trim() !== '');
  const set = (i: number, patch: Partial<LevelDraft>) =>
    setLevels(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <section aria-labelledby={`${id}-approval`} className="space-y-2">
      <h2 id={`${id}-approval`} className="text-base font-semibold">
        {t('approvalTitle')}
      </h2>
      <Card className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>{t('approvalName')}</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-model`}>{t('approvalModel')}</Label>
            <Input id={`${id}-model`} value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
        </div>
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">{t('levels')}</legend>
          {levels.map((l, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place and never reordered
              key={i}
              className="flex items-start gap-2 rounded-md border p-3"
            >
              <div className="grid flex-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`${id}-${i}-name`}>{t('levelName')}</Label>
                  <Input
                    id={`${id}-${i}-name`}
                    value={l.name}
                    onChange={(e) => set(i, { name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-${i}-role`}>{t('approverRole')}</Label>
                  <Input
                    id={`${id}-${i}-role`}
                    value={l.approverRole}
                    onChange={(e) => set(i, { approverRole: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-${i}-field`}>{t('amountField')}</Label>
                  <Input
                    id={`${id}-${i}-field`}
                    value={l.field}
                    onChange={(e) => set(i, { field: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-${i}-above`}>{t('amountAbove')}</Label>
                  <Input
                    id={`${id}-${i}-above`}
                    inputMode="decimal"
                    value={l.above}
                    onChange={(e) => set(i, { above: e.target.value })}
                  />
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t('removeLevel', { n: i + 1 })}
                disabled={levels.length === 1}
                onClick={() => setLevels(levels.filter((_, j) => j !== i))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setLevels([...levels, EMPTY_LEVEL])}>
            <Plus aria-hidden />
            {t('addLevel')}
          </Button>
        </fieldset>
        {add.isError ? <Alert>{message(add.error)}</Alert> : null}
        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={!ready}
            busy={add.isPending}
            onClick={() => add.mutate()}
          >
            {t('review')}
          </Button>
        </div>
      </Card>
    </section>
  );
}
