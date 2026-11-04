/**
 * A project's structure (RFC 0026 §3.2), a node component of the project form: its phases (nested), each phase's
 * work packages, and the tasks in them, as a tree with progress bars — read through the API as the user, so the
 * record rules decide what shows. Each row opens its record; tasks outside any phase are listed last.
 */
import { type NodeComponentProps, type Row, useKosh } from '@kosh/ui';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const idOf = (value: unknown): number | null => {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && typeof (value as Row)['id'] === 'number')
    return (value as Row)['id'] as number;
  return null;
};

const percent = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
};

function Bar({ value, label }: { value: unknown; label: string }): ReactElement {
  const { format } = useKosh();
  const n = percent(value);
  return (
    <span className="inline-flex w-36 shrink-0 items-center gap-2">
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={n}
        aria-label={label}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
      >
        <span
          className={`block h-full rounded-full ${n >= 100 ? 'bg-success' : 'bg-primary'}`}
          style={{ width: `${n}%` }}
        />
      </span>
      <span className="w-10 text-end tabular-nums text-xs text-muted-foreground">
        {format.number(n)}%
      </span>
    </span>
  );
}

function Item({
  href,
  kind,
  name,
  progress,
  extra,
  children,
}: {
  href: string;
  kind: string;
  name: string;
  progress: unknown;
  extra?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  const { t } = useTranslation('project');
  return (
    <li>
      <div className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60">
        <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
          {kind}
        </span>
        <a href={href} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">
          {name}
        </a>
        {extra}
        <Bar value={progress} label={t('structure.progressOf', { name })} />
      </div>
      {children === undefined ? null : (
        <ul className="ms-6 border-s border-border ps-2">{children}</ul>
      )}
    </li>
  );
}

export function Structure({ api, record, version }: NodeComponentProps): ReactElement | null {
  const { t } = useTranslation('project');
  const projectId = typeof record?.id === 'number' ? record.id : null;
  const data = useQuery({
    queryKey: ['project.structure', projectId, version],
    enabled: projectId !== null,
    queryFn: async () => {
      const where = { project: projectId };
      const [phases, packages, tasks] = await Promise.all([
        api.list('project.phase', {
          filter: where,
          fields: ['id', 'name', 'parentPhase', 'progress', 'status'],
          order: ['sequence asc', 'id asc'],
          limit: 500,
        }),
        api.list('project.work.package', {
          filter: where,
          fields: ['id', 'name', 'phase', 'progress', 'status'],
          order: ['sequence asc', 'id asc'],
          limit: 500,
        }),
        api.list('project.task', {
          filter: { project: projectId, parentTask: { isNull: true } },
          fields: ['id', 'name', 'phase', 'workPackage', 'progress', 'milestone', 'blocked'],
          limit: 1000,
        }),
      ]);
      return { phases: phases.items, packages: packages.items, tasks: tasks.items };
    },
  });
  if (projectId === null) return null;
  if (data.isPending)
    return <p className="text-sm text-muted-foreground">{t('structure.loading')}</p>;
  if (data.isError) return <p className="text-sm text-danger">{data.error.message}</p>;
  const { phases, packages, tasks } = data.data;
  if (phases.length === 0 && packages.length === 0)
    return <p className="text-sm text-muted-foreground">{t('structure.empty')}</p>;

  const href = (action: string, id: unknown) => `/projects/a/projects.${action}/${String(id)}`;
  const taskItem = (task: Row) => (
    <Item
      key={`t${String(task.id)}`}
      href={href('action_tasks', task.id)}
      kind={task['milestone'] === true ? t('structure.milestone') : t('structure.task')}
      name={String(task['name'] ?? '')}
      progress={task['progress']}
      extra={
        task['blocked'] === true ? (
          <span className="rounded bg-warning/15 px-1.5 text-xs text-warning">
            {t('structure.waiting')}
          </span>
        ) : undefined
      }
    />
  );
  const packageItem = (wp: Row) => {
    const inside = tasks.filter((x) => idOf(x['workPackage']) === wp.id);
    return (
      <Item
        key={`w${String(wp.id)}`}
        href={href('action_work_packages', wp.id)}
        kind={t('structure.workPackage')}
        name={String(wp['name'] ?? '')}
        progress={wp['progress']}
      >
        {inside.length === 0 ? undefined : inside.map(taskItem)}
      </Item>
    );
  };
  const phaseItem = (phase: Row): ReactElement => {
    const subs = phases.filter((x) => idOf(x['parentPhase']) === phase.id);
    const wps = packages.filter((x) => idOf(x['phase']) === phase.id);
    const direct = tasks.filter(
      (x) => idOf(x['phase']) === phase.id && idOf(x['workPackage']) === null,
    );
    const children = [...subs.map(phaseItem), ...wps.map(packageItem), ...direct.map(taskItem)];
    return (
      <Item
        key={`p${String(phase.id)}`}
        href={href('action_phases', phase.id)}
        kind={t('structure.phase')}
        name={String(phase['name'] ?? '')}
        progress={phase['progress']}
      >
        {children.length === 0 ? undefined : children}
      </Item>
    );
  };
  const top = phases.filter((x) => idOf(x['parentPhase']) === null);
  const loosePackages = packages.filter((x) => idOf(x['phase']) === null);
  const loose = tasks.filter((x) => idOf(x['phase']) === null && idOf(x['workPackage']) === null);
  return (
    <section aria-label={t('structure.title')} className="grid gap-2">
      <h3 className="text-sm font-semibold">{t('structure.title')}</h3>
      <ul className="grid gap-0.5">
        {top.map(phaseItem)}
        {loosePackages.map(packageItem)}
      </ul>
      {loose.length === 0 ? null : (
        <>
          <h4 className="mt-2 text-xs font-medium text-muted-foreground">
            {t('structure.outside')}
          </h4>
          <ul className="grid gap-0.5">{loose.map(taskItem)}</ul>
        </>
      )}
    </section>
  );
}
