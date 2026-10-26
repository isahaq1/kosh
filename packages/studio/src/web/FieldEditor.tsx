/** The inputs of a new field (label, type, options, target, required, tracking), shared by Studio's dialogs. */
import { Checkbox, Input, Label, Select, Textarea } from '@kosh/ui';
import { type ReactElement, useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { FieldType, StudioField } from '../spec.js';

/** The types Studio mode offers (decimal and monetary details, many2many: in studio.json). */
export const EDITOR_TYPES: readonly [
  'char',
  'text',
  'integer',
  'decimal',
  'date',
  'datetime',
  'boolean',
  'selection',
  'many2one',
] = [
  'char',
  'text',
  'integer',
  'decimal',
  'date',
  'datetime',
  'boolean',
  'selection',
  'many2one',
] as const satisfies readonly FieldType[];

export interface FieldDraft {
  readonly label: string;
  readonly type: (typeof EDITOR_TYPES)[number];
  readonly required: boolean;
  readonly tracking: boolean;
  /** `selection`: one per line, `value = Label` (or a label alone). */
  readonly options: string;
  /** `many2one`: the related model. */
  readonly target: string;
}

export const EMPTY_FIELD: FieldDraft = {
  label: '',
  type: 'char',
  required: false,
  tracking: false,
  options: '',
  target: '',
};

/** The field as Studio's API takes it (its name comes from the server). */
export function fieldOf(draft: FieldDraft): Omit<StudioField, 'name'> {
  const options: Record<string, string> = {};
  for (const line of draft.options.split('\n')) {
    const [rawValue, ...rest] = line.split('=');
    const label = (rest.length === 0 ? (rawValue ?? '') : rest.join('=')).trim();
    const value = (rawValue ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (label !== '' && value !== '') options[value] = label;
  }
  return {
    label: draft.label.trim(),
    type: draft.type,
    ...(draft.required ? { required: true } : {}),
    ...(draft.tracking ? { tracking: true } : {}),
    ...(draft.type === 'selection' ? { options } : {}),
    ...(draft.type === 'many2one' ? { target: draft.target.trim() } : {}),
  };
}

export function FieldEditor({
  value,
  onChange,
}: {
  readonly value: FieldDraft;
  readonly onChange: (next: FieldDraft) => void;
}): ReactElement {
  const { t } = useTranslation('studio');
  const id = useId();
  const set = (patch: Partial<FieldDraft>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={`${id}-label`}>{t('label')}</Label>
        <Input
          id={`${id}-label`}
          value={value.label}
          maxLength={80}
          onChange={(e) => set({ label: e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-type`}>{t('type')}</Label>
        <Select
          id={`${id}-type`}
          label={t('type')}
          value={value.type}
          options={EDITOR_TYPES.map((type) => ({ value: type, label: t(`types.${type}`) }))}
          onChange={(type) => set({ type: type as FieldDraft['type'] })}
        />
      </div>
      {value.type === 'selection' ? (
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`${id}-options`}>{t('options')}</Label>
          <Textarea
            id={`${id}-options`}
            rows={4}
            value={value.options}
            onChange={(e) => set({ options: e.target.value })}
          />
        </div>
      ) : null}
      {value.type === 'many2one' ? (
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`${id}-target`}>{t('target')}</Label>
          <Input
            id={`${id}-target`}
            value={value.target}
            onChange={(e) => set({ target: e.target.value })}
          />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-required`}
          checked={value.required}
          onCheckedChange={(checked) => set({ required: checked === true })}
        />
        <Label htmlFor={`${id}-required`}>{t('required')}</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-tracking`}
          checked={value.tracking}
          onCheckedChange={(checked) => set({ tracking: checked === true })}
        />
        <Label htmlFor={`${id}-tracking`}>{t('tracking')}</Label>
      </div>
    </div>
  );
}
