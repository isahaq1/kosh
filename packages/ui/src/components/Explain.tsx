/**
 * Explain popovers (RFC 0031 §3.1). With Developer mode on, a field label, a list column, a button, a stat tile or a
 * page title opens — on hover or keyboard focus — a dark card saying what it is: the field's kind, what it points to
 * (a link to that model's list) and back through which field, whether it is stored or computed and from what, its
 * default and rules, the module that declared it; a button's states and guard; a model's relations in and out. The
 * facts come from `GET /api/v1/meta/explain/:model` (developers and administrators only). Off, nothing changes.
 */
import { useQuery } from '@tanstack/react-query';
import { HoverCard } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useKosh } from '../context.js';

export interface ExplainedField {
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly help: string | null;
  readonly target: string | null;
  readonly inverse: string | null;
  readonly required: boolean;
  readonly readonly: boolean;
  readonly stored: boolean;
  readonly computed: boolean;
  readonly depends: readonly string[];
  readonly hasDefault: boolean;
  readonly default: string | null;
  readonly ondelete: string | null;
  readonly translate: boolean;
  readonly index: boolean;
  readonly options: readonly (readonly [string, string])[] | null;
  readonly module: string | null;
}

export interface Explained {
  readonly model: string;
  readonly label: string;
  readonly module: string | null;
  readonly extendedBy: readonly string[];
  readonly fields: readonly ExplainedField[];
  readonly transitions: readonly {
    readonly name: string;
    readonly field: string;
    readonly from: readonly string[];
    readonly to: string;
    readonly guarded: boolean;
    readonly message: string | null;
    readonly requires: string | null;
  }[];
  readonly incoming: readonly {
    readonly model: string;
    readonly field: string;
    readonly label: string;
    readonly kind: string;
  }[];
}

/** A model's explanation, fetched once per model while Developer mode is on. */
export function useExplain(model: string | null | undefined): Explained | undefined {
  const { api, developer } = useKosh();
  const query = useQuery({
    queryKey: ['kosh', 'explain', model],
    queryFn: () =>
      api.call<Explained>('GET', `/api/v1/meta/explain/${encodeURIComponent(model ?? '')}`),
    enabled: developer && typeof model === 'string' && model !== '',
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return query.data;
}

/** What to explain: a field, a transition (button), a domain (tile or menu), or the model itself. */
export type ExplainTarget =
  | { readonly field: string }
  | { readonly transition: string }
  | { readonly action: string; readonly domain?: unknown }
  | { readonly model: true };

function Row({
  name,
  children,
}: {
  readonly name: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <li className="flex gap-2">
      <span className="shrink-0 text-neutral-400">{name}</span>
      <span className="min-w-0 break-words font-mono text-neutral-100">{children}</span>
    </li>
  );
}

/** A link to a model's records, opened in a new tab (the generic list of the model). */
function ModelLink({ model }: { readonly model: string }): ReactElement {
  return (
    <a
      href={`/open/${encodeURIComponent(model)}`}
      target="_blank"
      rel="noreferrer"
      className="text-sky-300 underline underline-offset-2 hover:text-sky-200"
    >
      {model}
    </a>
  );
}

function Body({
  model,
  target,
}: {
  readonly model: string;
  readonly target: ExplainTarget;
}): ReactElement {
  const { t } = useTranslation();
  const explained = useExplain(model);
  if (explained === undefined) return <p className="text-neutral-400">{t('explain.loading')}</p>;
  const yes = t('explain.yes');
  if ('field' in target) {
    const f = explained.fields.find((x) => x.key === target.field);
    if (f === undefined) return <p className="text-neutral-400">{t('explain.unknown')}</p>;
    return (
      <>
        {f.help === null ? null : (
          <p className="mb-2 rounded bg-sky-900/60 px-2 py-1 text-sky-100">{f.help}</p>
        )}
        <ul className="space-y-0.5">
          <Row name={t('explain.label')}>{f.label}</Row>
          <Row name={t('explain.field')}>{f.key}</Row>
          <Row name={t('explain.model')}>{explained.model}</Row>
          <Row name={t('explain.type')}>{f.kind}</Row>
          {f.target === null ? null : (
            <Row name={t('explain.relation')}>
              <ModelLink model={f.target} />
              {f.inverse === null ? null : ` ← ${f.inverse}`}
            </Row>
          )}
          {f.ondelete === null ? null : <Row name={t('explain.ondelete')}>{f.ondelete}</Row>}
          {f.required ? <Row name={t('explain.required')}>{yes}</Row> : null}
          {f.readonly ? <Row name={t('explain.readonly')}>{yes}</Row> : null}
          <Row name={t('explain.stored')}>{f.stored ? yes : t('explain.no')}</Row>
          {f.computed ? (
            <Row name={t('explain.computed')}>
              {f.depends.length === 0 ? yes : f.depends.join(', ')}
            </Row>
          ) : null}
          {f.hasDefault ? <Row name={t('explain.default')}>{f.default ?? '—'}</Row> : null}
          {f.translate ? <Row name={t('explain.translated')}>{yes}</Row> : null}
          {f.index ? <Row name={t('explain.indexed')}>{yes}</Row> : null}
          {f.options === null ? null : (
            <Row name={t('explain.selection')}>
              {f.options.map(([value, label]) => `[${value}] ${label}`).join(' · ')}
            </Row>
          )}
          {f.module === null ? null : <Row name={t('explain.module')}>{f.module}</Row>}
        </ul>
      </>
    );
  }
  if ('transition' in target) {
    const tr = explained.transitions.find((x) => x.name === target.transition);
    return (
      <ul className="space-y-0.5">
        <Row name={t('explain.button')}>{target.transition}</Row>
        <Row name={t('explain.model')}>{explained.model}</Row>
        {tr === undefined ? null : (
          <>
            <Row name={t('explain.states')}>
              {`${tr.from.join(', ')} → ${tr.to}`} ({tr.field})
            </Row>
            {tr.guarded ? <Row name={t('explain.guard')}>{tr.message ?? yes}</Row> : null}
            {tr.requires === null ? null : <Row name={t('explain.requires')}>{tr.requires}</Row>}
          </>
        )}
      </ul>
    );
  }
  if ('action' in target)
    return (
      <ul className="space-y-0.5">
        <Row name={t('explain.action')}>{target.action}</Row>
        <Row name={t('explain.model')}>
          <ModelLink model={explained.model} />
        </Row>
        {target.domain === undefined ? null : (
          <Row name={t('explain.domain')}>{JSON.stringify(target.domain)}</Row>
        )}
      </ul>
    );
  const outgoing = explained.fields.filter((f) => f.target !== null);
  return (
    <ul className="space-y-0.5">
      <Row name={t('explain.model')}>{explained.model}</Row>
      {explained.module === null ? null : <Row name={t('explain.module')}>{explained.module}</Row>}
      {explained.extendedBy.length === 0 ? null : (
        <Row name={t('explain.extendedBy')}>{explained.extendedBy.join(', ')}</Row>
      )}
      <li className="pt-1 text-neutral-400">{t('explain.out', { count: outgoing.length })}</li>
      {outgoing.map((f) => (
        <li key={f.key} className="font-mono text-neutral-100">
          {f.key} ({f.kind}) → <ModelLink model={f.target as string} />
        </li>
      ))}
      <li className="pt-1 text-neutral-400">
        {t('explain.in', { count: explained.incoming.length })}
      </li>
      {explained.incoming.map((r) => (
        <li key={`${r.model}.${r.field}`} className="font-mono text-neutral-100">
          <ModelLink model={r.model} />.{r.field} ({r.kind})
        </li>
      ))}
    </ul>
  );
}

/**
 * Wraps `children` with the explain popover of `target` on `model` when Developer mode is on; renders them unchanged
 * otherwise.
 */
export function Explain({
  model,
  target,
  asChild = false,
  focusable = true,
  children,
}: {
  readonly model: string;
  readonly target: ExplainTarget;
  /** Attach to the child element itself (a button) instead of wrapping it in a focusable span. */
  readonly asChild?: boolean;
  /** Hover only, no tab stop: inside a control that is itself focusable (a clickable tile). */
  readonly focusable?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  const { developer } = useKosh();
  if (!developer) return <>{children}</>;
  return (
    <HoverCard.Root openDelay={250} closeDelay={150}>
      <HoverCard.Trigger asChild>
        {asChild ? (
          children
        ) : (
          <span
            tabIndex={focusable ? 0 : undefined}
            data-kosh-explain=""
            className="inline-flex cursor-help items-center gap-0.5 underline decoration-dotted decoration-sky-500 underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            {children}
          </span>
        )}
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-h-[70vh] max-w-[min(32rem,calc(100vw-2rem))] overflow-auto rounded-md bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-100 shadow-xl ring-1 ring-white/10"
        >
          <Body model={model} target={target} />
          <HoverCard.Arrow className="fill-neutral-950" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
