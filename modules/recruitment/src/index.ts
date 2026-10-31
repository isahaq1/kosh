/**
 * @packageDocumentation
 * `@kosh/recruitment` (RFC 0021): the **Hiring** app. Openings for Workforce positions with their headcount,
 * applicants on a board of stages, independent scorecards (each interviewer sees only their own; the average shows
 * to all), and hiring in one step: the applicant becomes a Workforce employee, and a filled opening closes itself.
 *
 * - `POST /api/v1/hiring/applicants/:id/hire`   hiring managers: the employee made, the applicant hired
 */
import { hr } from '@kosh/hr';
import { defineModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { audit, HttpProblem, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { action, form, kanban, list, search } from '@kosh/views';
import { recruitmentDemo } from './demo.js';
import {
  HiringApplicant,
  HiringOpening,
  HiringScorecard,
  HiringStage,
  recruitmentShutro,
} from './module.js';

export {
  HiringApplicant,
  HiringOpening,
  HiringScorecard,
  HiringStage,
  recruitmentShutro,
} from './module.js';

type Row = Record<string, unknown>;
interface Records {
  readonly length: number;
  readonly ids: readonly number[];
  load(keys: readonly string[]): Promise<Records>;
  read(keys: readonly string[]): Row[];
  write(values: Row): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Records>;
  browse(ids: readonly number[]): Records;
  create(rows: readonly Row[]): Promise<Records>;
}
/** Today in the server's time zone (a date, not an instant). */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const ref = (env: Env, model: string) => env.model(model as never) as unknown as Ref;
const one = async (env: Env, model: string, where: unknown, keys: readonly string[]) => {
  const set = await ref(env, model).search({ where, limit: 1 });
  return set.length === 0 ? undefined : (await set.load(keys)).read(['id', ...keys])[0];
};

function registerHiringRoutes({ app }: ModuleContext): void {
  app.post('/api/v1/hiring/applicants/:id/hire', async (request) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new HttpProblem(400, 'invalid-id', 'Invalid id', 'An applicant id.');
    return request.env(
      async (env) => {
        if (!env.administrator && !env.groups.has('hiring.manager'))
          throw new HttpProblem(
            403,
            'access',
            'Hiring managers only',
            'Hiring needs the Hiring manager access.',
          );
        return env.asSuperuser({ reason: 'hire' }, async (su) => {
          const applicant = await one(su, 'hiring.applicant', { id }, [
            'name',
            'email',
            'phone',
            'opening',
            'refused',
            'employee',
            'company',
          ]);
          if (applicant === undefined)
            throw new HttpProblem(
              404,
              'missing-record',
              'Not found',
              `There is no applicant ${id}.`,
            );
          if (applicant['employee'] !== null)
            throw new HttpProblem(
              409,
              'already-hired',
              'Already hired',
              'This applicant is already an employee.',
            );
          if (applicant['refused'] === true)
            throw new HttpProblem(409, 'refused', 'Refused', 'A refused applicant is not hired.');
          const opening = await one(su, 'hiring.opening', { id: applicant['opening'] }, [
            'name',
            'job',
            'department',
            'headcount',
            'hiredCount',
            'state',
          ]);
          if (opening === undefined || opening['state'] !== 'open')
            throw new HttpProblem(
              409,
              'opening-closed',
              'Opening closed',
              'The opening is closed.',
            );
          if (Number(opening['hiredCount']) >= Number(opening['headcount']))
            throw new HttpProblem(
              409,
              'opening-filled',
              'Opening filled',
              'The opening’s headcount is already hired.',
            );
          const employee = (
            await ref(su, 'hr.employee').create([
              {
                name: applicant['name'],
                workEmail: applicant['email'],
                workPhone: applicant['phone'] ?? null,
                job: opening['job'] ?? null,
                department: opening['department'] ?? null,
                company: applicant['company'],
                hireDate: today(),
              },
            ])
          ).ids[0] as number;
          const hired = await one(su, 'hiring.stage', { hired: true }, ['name']);
          await ref(su, 'hiring.applicant')
            .browse([id])
            .write({ employee, ...(hired === undefined ? {} : { stage: hired['id'] }) });
          // A filled opening closes itself.
          const filled = Number(opening['hiredCount']) + 1 >= Number(opening['headcount']);
          if (filled) {
            const target = ref(su, 'hiring.opening').browse([
              opening['id'] as number,
            ]) as unknown as Records & {
              close(): Promise<void>;
            };
            await target.close();
          }
          await audit(env, {
            kind: 'hiring.hired',
            summary: `${String(applicant['name'])} hired for ${String(opening['name'])}.`,
            targetModel: 'hiring.applicant',
            targetId: id,
            details: { employee, openingClosed: filled },
            ip: request.ip,
          });
          await su.flush();
          return { applicant: id, employee, openingClosed: filled };
        });
      },
      { write: true },
    );
  });
}

export const recruitment: ReturnType<typeof defineModule> = defineModule({
  shutro: recruitmentShutro,
  kosh: '^0.1.0',
  hooks: { demo: recruitmentDemo },
  depends: [hr, reporting],
  app: {
    code: 'hiring',
    label: 'Hiring',
    icon: 'hiring',
    sequence: 21,
    category: 'People',
    summary: 'Openings, applicants on a board, independent scorecards, hire in one step',
  },
  accessLevels: {
    user: { label: 'Interviewer (applicants, own scorecards)', groups: ['hiring.user'] },
    manager: {
      label: 'Hiring manager (everything, salaries, hiring)',
      groups: ['hiring.manager'],
      implies: ['user'],
    },
  },
  routes: (context: ModuleContext) => registerHiringRoutes(context),
  // The Overview (RFC 0022 step 2).
  overview: {
    cards: [
      {
        id: 'openings_open',
        title: 'Open openings',
        kind: 'kpi',
        model: 'hiring.opening',
        measure: 'count',
        filter: { state: 'open' },
        w: 3,
      },
      {
        id: 'to_hire',
        title: 'People to hire',
        kind: 'kpi',
        model: 'hiring.opening',
        measure: 'sum:headcount',
        filter: { state: 'open' },
        w: 3,
      },
      {
        id: 'in_process',
        title: 'Applicants in process',
        kind: 'kpi',
        model: 'hiring.applicant',
        measure: 'count',
        filter: { refused: false, 'stage.hired': false },
        w: 3,
      },
      {
        id: 'hired',
        title: 'Hired',
        kind: 'kpi',
        model: 'hiring.applicant',
        measure: 'count',
        filter: { 'stage.hired': true },
        w: 3,
      },
      {
        id: 'by_stage',
        title: 'Applicants by stage',
        kind: 'chart',
        model: 'hiring.applicant',
        measure: 'count',
        groupBy: 'stage',
        filter: { refused: false },
        chart: 'bar',
        w: 6,
      },
      {
        id: 'by_source',
        title: 'Where applicants come from',
        kind: 'chart',
        model: 'hiring.applicant',
        measure: 'count',
        groupBy: 'source',
        chart: 'pie',
        w: 6,
      },
      {
        id: 'top_rated',
        title: 'Best rated applicants',
        kind: 'list',
        model: 'hiring.applicant',
        measure: 'sum:rating',
        filter: { refused: false },
        w: 6,
      },
      {
        id: 'by_opening',
        title: 'Applicants by opening',
        kind: 'pivot',
        model: 'hiring.applicant',
        measure: 'count',
        groupBy: 'opening',
        filter: { refused: false },
        w: 6,
      },
    ],
  },
  actions: {
    'hiring.action_applicants': action(HiringApplicant, {
      label: 'Applicants',
      views: ['kanban', 'list', 'form'],
      defaultFilters: ['active'],
    }),
    'hiring.action_openings': action(HiringOpening, {
      label: 'Openings',
      views: ['list', 'form'],
      defaultFilters: ['open'],
    }),
    'hiring.action_scorecards': action(HiringScorecard, {
      label: 'Scorecards',
      views: ['list', 'form'],
    }),
    'hiring.action_stages': action(HiringStage, { label: 'Stages', views: ['list', 'form'] }),
  },
  menus: [
    { id: 'hiring.root', label: 'Hiring', app: 'hiring' },
    {
      id: 'hiring.applicants',
      parent: 'hiring.root',
      label: 'Applicants',
      action: 'hiring.action_applicants',
      sequence: 1,
    },
    {
      id: 'hiring.openings',
      parent: 'hiring.root',
      label: 'Openings',
      action: 'hiring.action_openings',
      sequence: 2,
    },
    {
      id: 'hiring.scorecards',
      parent: 'hiring.root',
      label: 'Scorecards',
      action: 'hiring.action_scorecards',
      sequence: 3,
    },
    { id: 'hiring.configuration', parent: 'hiring.root', label: 'Configuration', sequence: 9 },
    {
      id: 'hiring.stages',
      parent: 'hiring.configuration',
      label: 'Stages',
      action: 'hiring.action_stages',
      sequence: 1,
    },
  ],
  views: {
    'hiring.applicant.kanban': kanban(HiringApplicant, {
      groupBy: 'stage',
      card: {
        title: 'name',
        subtitle: 'opening',
        footer: [{ field: 'rating', widget: 'rating' }, 'source'],
        badges: [{ field: 'status', widget: 'badge' }],
      },
    }),
    'hiring.applicant.list': list(HiringApplicant, {
      columns: [
        'name',
        'opening',
        'stage',
        { field: 'email', widget: 'email' },
        { field: 'rating', widget: 'rating' },
        { field: 'status', widget: 'badge' },
      ],
      inlineEdit: ['stage'],
    }),
    'hiring.applicant.form': form(HiringApplicant, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.component('hire', 'hiring.Hire'),
        k.group('candidate', ['name', 'email', 'phone', 'source']),
        k.group('application', [
          'opening',
          'stage',
          'rating',
          'status',
          'employee',
          'expectedSalary',
        ]),
        k.group('outcome', ['refused', 'refuseReason']),
        k.lines('scorecards', [
          'interviewer',
          'score',
          'recommendation',
          { field: 'notes', id: 'card_notes' },
        ]),
        k.group('about', ['notes'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'hiring.opening.list': list(HiringOpening, {
      columns: [
        'name',
        'job',
        'department',
        'manager',
        'headcount',
        'hiredCount',
        { field: 'state', widget: 'badge' },
      ],
    }),
    'hiring.opening.form': form(HiringOpening, (k) => ({
      header: {
        statusbar: 'state',
        buttons: [k.button('close', { label: 'Close' }), k.button('reopen', { label: 'Reopen' })],
      },
      sheet: [
        k.stats('related', [
          {
            id: 'opening_applicants',
            label: 'Applicants',
            model: HiringApplicant,
            where: { opening: { $record: 'id' } },
            action: 'hiring.action_applicants',
          },
          {
            id: 'opening_in_process',
            label: 'In process',
            model: HiringApplicant,
            where: { opening: { $record: 'id' }, refused: false, 'stage.hired': false },
            action: 'hiring.action_applicants',
            tone: 'info',
          },
          {
            id: 'opening_hired',
            label: 'Hired',
            model: HiringApplicant,
            where: { opening: { $record: 'id' }, 'stage.hired': true },
            action: 'hiring.action_applicants',
            tone: 'success',
          },
        ]),
        k.group('main', ['name', 'job', 'department', 'manager']),
        k.group('count', ['headcount', 'hiredCount']),
        k.group('about', ['description'], { columns: 1 }),
      ],
      chatter: true,
    })),
    'hiring.scorecard.list': list(HiringScorecard, {
      columns: ['applicant', 'interviewer', 'score', 'recommendation'],
    }),
    'hiring.scorecard.form': form(HiringScorecard, (k) => ({
      header: { buttons: [] },
      sheet: [
        k.group('main', ['applicant', 'interviewer', 'score', 'recommendation']),
        k.group('about', ['notes'], { columns: 1 }),
      ],
    })),
    'hiring.stage.list': list(HiringStage, {
      columns: ['sequence', 'name', 'fold', 'hired'],
      inlineEdit: ['name', 'fold', 'hired'],
    }),
    'hiring.stage.form': form(HiringStage, (k) => ({
      header: { buttons: [] },
      sheet: [k.group('main', ['name', 'sequence', 'fold', 'hired'])],
    })),
  },
  search: {
    'hiring.applicant': search(HiringApplicant, {
      fields: ['name', 'email', 'opening.name'],
      filters: {
        active: { label: 'In progress', domain: { status: 'active' }, group: 'status' },
        hired: { label: 'Hired', domain: { status: 'hired' }, group: 'status' },
        refused: { label: 'Refused', domain: { status: 'refused' }, group: 'status' },
      },
      groupBy: ['opening', 'stage', 'source'],
    }),
    'hiring.opening': search(HiringOpening, {
      fields: ['name', 'job.name'],
      filters: { open: { label: 'Open', domain: { state: 'open' } } },
      groupBy: ['department', 'manager'],
    }),
    'hiring.scorecard': search(HiringScorecard, {
      fields: ['applicant.name'],
      groupBy: ['applicant', 'recommendation'],
    }),
    'hiring.stage': search(HiringStage, { fields: ['name'] }),
  },
});
