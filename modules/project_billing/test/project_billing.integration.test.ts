/**
 * Project billing on real PostgreSQL with Accounting (RFC 0034 §2.5): hours are submitted by their author and
 * approved by a Projects manager — never one's own —, priced from the project's rate card and frozen; refused only
 * with a reason; unchanged once submitted. A billing statement makes one invoice of the approved hours and the
 * reached milestones, once: a second statement finds nothing, and a released one gives its hours back. Who may do
 * what, and who may see what an hour is sold for.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { projectBilling } from '../src/index.js';

const T = '/api/v1/models/project.timesheet';
const S = '/api/v1/models/project.statement';
const M = '/api/v1/models/project.billing.milestone';
let erp: TestInstallation;
const ids: Record<string, number> = {};
const users: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  as: string,
  body?: unknown,
) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, as: string, values: Record<string, unknown>) => {
  const made = await call('POST', `/api/v1/models/${model}`, as, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const money = (value: unknown): string | null =>
  value === null || value === undefined ? null : Number(value).toFixed(2);
/** Hours logged by their author on a task. */
const log = async (as: string, task: string, date: string, hours: string, more = {}) =>
  make('project.timesheet', as, { task: ids[task], date, hours, ...more });
const step = (id: number, name: string, as: string) =>
  call('POST', `${T}/${id}/transitions/${name}`, as);
/** Logged, submitted by the author and approved by `approver`. */
const approved = async (
  as: string,
  task: string,
  date: string,
  hours: string,
  approver = 'pia',
) => {
  const id = await log(as, task, date, hours);
  expect((await step(id, 'submit', as)).status).toBe(200);
  const done = await step(id, 'approve', approver);
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  return id;
};
/** What a Projects manager sees of a line. */
const line = async (id: number) => {
  const json = (
    await call('GET', `${T}/${id}?fields=approval,billRate,billAmount,approvedBy,statement`, 'pia')
  ).json as Json;
  return {
    approval: json.approval,
    rate: money(json.billRate),
    amount: money(json.billAmount),
    statement: json.statement?.id ?? json.statement ?? null,
  };
};
/** The invoice of a statement: untaxed amount, state, and its lines (quantity × price). */
const invoiceOf = async (statement: number) => {
  const [move] = await erp.host.server.driver.query<{ id: number; untaxed: string; state: string }>(
    {
      text: `SELECT id, amount_untaxed::text AS untaxed, state FROM account_move
              WHERE project_statement_id = $1 ORDER BY id DESC LIMIT 1`,
      params: [statement],
    },
  );
  if (move === undefined) return null;
  const lines = await erp.host.server.driver.query<{ name: string; q: string; p: string }>({
    text: `SELECT name, quantity::text AS q, price_unit::text AS p FROM account_move_line
            WHERE move_id = $1 AND line_kind = 'product' ORDER BY id`,
    params: [move.id],
  });
  return {
    id: move.id,
    untaxed: money(move.untaxed),
    state: move.state,
    lines: lines.map((l) => `${l.name} | ${Number(l.q)} × ${Number(l.p)}`),
  };
};

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [projectBilling],
    users: {
      mona: ['project_billing.manager', 'account.manager'],
      pia: ['project.manager'],
      rafi: ['project.user'],
      sumi: ['project.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Consulting', currency: 'BDT' },
  });
  expect(
    (await call('POST', '/api/v1/accounting/charts/install', 'mona', { template: 'generic' }))
      .status,
  ).toBe(200);
  for (const u of await erp.host.server.driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  }))
    users[u.login] = Number(u.id);
  ids['service'] = await make('product.product', 'mona', {
    name: 'Consulting',
    kind: 'service',
    listPrice: '2000',
  });
  ids['customer'] = await make('res.partner', 'mona', { name: 'Meghna Textiles' });
  ids['senior'] = await make('project.role', 'pia', { name: 'Senior consultant' });
  ids['travel'] = await make('project.task.category', 'pia', { name: 'Travel', code: 'TRV' });
  ids['card'] = await make('project.rate.card', 'mona', {
    name: 'Standard 2027',
    defaultRate: '1500',
    lines: {
      create: [
        { category: ids['travel'], rate: '500' },
        { role: ids['senior'], rate: '3000' },
        { user: users['rafi'], rate: '4000' },
      ],
    },
  });
  ids['project'] = await make('project.project', 'mona', {
    name: 'ERP rollout',
    partner: ids['customer'],
    billable: true,
    rateCard: ids['card'],
    billingProduct: ids['service'],
  });
  await make('project.member', 'pia', {
    project: ids['project'],
    user: users['sumi'],
    role: ids['senior'],
  });
  ids['analysis'] = await make('project.task', 'pia', {
    name: 'Analysis',
    project: ids['project'],
  });
  ids['visit'] = await make('project.task', 'pia', {
    name: 'Site visit',
    project: ids['project'],
    category: ids['travel'],
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('hours are submitted by their author and approved by a manager, at the card’s rate', async () => {
  const rafis = await log('rafi', 'analysis', '2027-01-04', '2');
  expect((await line(rafis)).approval).toBe('draft');
  // Not before it is submitted; not by its author; not by someone who only logs time.
  expect((await step(rafis, 'approve', 'pia')).status).toBe(409);
  expect((await step(rafis, 'submit', 'rafi')).status).toBe(200);
  expect((await step(rafis, 'approve', 'rafi')).status).toBe(409);
  expect((await step(rafis, 'approve', 'sumi')).status).toBeGreaterThanOrEqual(403);
  const done = await step(rafis, 'approve', 'pia');
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  // Rafi has a rate of his own.
  expect(await line(rafis)).toMatchObject({
    approval: 'approved',
    rate: '4000.00',
    amount: '8000.00',
  });

  // Sumi is a senior on the project: her role's rate, also for travel (a role weighs more than a kind of task).
  const sumis = await approved('sumi', 'analysis', '2027-01-05', '3');
  expect(await line(sumis)).toMatchObject({ rate: '3000.00', amount: '9000.00' });
  const trip = await approved('sumi', 'visit', '2027-01-06', '1.5');
  expect(await line(trip)).toMatchObject({ rate: '3000.00', amount: '4500.00' });

  // A manager's own hours are approved by another one; nobody names her: the card's rate for everyone else.
  const pias = await log('pia', 'analysis', '2027-01-06', '1');
  expect((await step(pias, 'submit', 'pia')).status).toBe(200);
  expect((await step(pias, 'approve', 'pia')).status).toBe(409);
  expect((await step(pias, 'approve', 'mona')).status).toBe(200);
  expect(await line(pias)).toMatchObject({ rate: '1500.00', amount: '1500.00' });
  ids['rafis'] = rafis;
  ids['sumis'] = sumis;
  ids['trip'] = trip;
  ids['pias'] = pias;

  // The rate is frozen: a dearer card tomorrow does not move what was approved.
  const lines = (await call('GET', `/api/v1/models/project.rate.line?fields=user,rate`, 'mona'))
    .json.items as Json[];
  const own = lines.find((l) => l.user !== null);
  expect(
    (await call('PATCH', `/api/v1/models/project.rate.line/${own.id}`, 'mona', { rate: '4500' }))
      .status,
  ).toBe(200);
  expect((await line(rafis)).rate).toBe('4000.00');
});

test('a refusal says why; submitted hours do not change; approved ones are reopened by a manager', async () => {
  const id = await log('rafi', 'analysis', '2027-01-07', '4');
  expect((await step(id, 'submit', 'rafi')).status).toBe(200);
  // Locked while it waits.
  expect((await call('PATCH', `${T}/${id}`, 'rafi', { hours: '8' })).status).toBeGreaterThanOrEqual(
    400,
  );
  expect((await step(id, 'refuse', 'pia')).status).toBe(409);
  expect(
    (await call('PATCH', `${T}/${id}`, 'pia', { refuseReason: 'Four hours for a call?' })).status,
  ).toBe(200);
  expect((await step(id, 'refuse', 'pia')).status).toBe(200);
  // Refused: the author corrects it and submits again.
  expect((await call('PATCH', `${T}/${id}`, 'rafi', { hours: '1' })).status).toBe(200);
  expect((await step(id, 'submit', 'rafi')).status).toBe(200);
  expect((await step(id, 'approve', 'pia')).status).toBe(200);
  // After the change of the card: 4500 an hour now.
  expect(await line(id)).toMatchObject({
    approval: 'approved',
    rate: '4500.00',
    amount: '4500.00',
  });
  expect((await call('PATCH', `${T}/${id}`, 'rafi', { hours: '9' })).status).toBeGreaterThanOrEqual(
    400,
  );
  // Approved hours are not deleted, by their author either.
  expect((await call('DELETE', `${T}/${id}`, 'rafi')).status).toBeGreaterThanOrEqual(400);
  expect((await line(id)).approval).toBe('approved');
  // Reopened by a manager only; the rate goes with it.
  expect((await step(id, 'reopen', 'rafi')).status).toBe(409);
  expect((await step(id, 'reopen', 'pia')).status).toBe(200);
  expect(await line(id)).toMatchObject({ approval: 'draft', rate: null, amount: null });
  expect((await call('DELETE', `${T}/${id}`, 'rafi')).status).toBeLessThan(300);
});

test('what an hour is sold for is the server’s, and not for everyone', async () => {
  // Forged by a manager: refused.
  for (const forged of [{ billRate: '9999' }, { billAmount: '1' }, { statement: 1 }])
    expect(
      (await call('PATCH', `${T}/${ids['rafis']}`, 'pia', forged)).status,
      JSON.stringify(forged),
    ).toBe(403);
  // The author reads his line, without its rate.
  const seen = (await call('GET', `${T}/${ids['rafis']}`, 'rafi')).json as Json;
  expect(seen.approval).toBe('approved');
  expect(seen.billRate).toBeUndefined();
  expect(seen.billAmount).toBeUndefined();
  // Rate cards and statements: not for those who only log time, nor for anyone else.
  for (const who of ['rafi', 'bob']) {
    expect((await call('GET', '/api/v1/models/project.rate.card', who)).status).toBe(403);
    expect((await call('GET', S, who)).status).toBe(403);
  }
  // A Projects manager reads statements and does not make them.
  expect((await call('GET', S, 'pia')).status).toBe(200);
  expect(
    (await call('POST', S, 'pia', { project: ids['project'], dateTo: '2027-01-31' })).status,
  ).toBe(403);
});

test('on a billed project an hour without a rate is not approved; time not billed needs none', async () => {
  const bare = await make('project.project', 'mona', {
    name: 'Audit',
    partner: ids['customer'],
    billable: true,
    billingProduct: ids['service'],
  });
  ids['audit'] = await make('project.task', 'pia', { name: 'Fieldwork', project: bare });
  const id = await log('rafi', 'audit', '2027-01-08', '2');
  expect((await step(id, 'submit', 'rafi')).status).toBe(200);
  expect((await step(id, 'approve', 'pia')).status).toBe(409);
  // Not billable: approved, with nothing to bill.
  expect((await step(id, 'reopen', 'rafi')).status).toBe(200);
  expect((await call('PATCH', `${T}/${id}`, 'rafi', { billable: false })).status).toBe(200);
  expect((await step(id, 'submit', 'rafi')).status).toBe(200);
  expect((await step(id, 'approve', 'pia')).status).toBe(200);
  expect(await line(id)).toMatchObject({ approval: 'approved', rate: null, amount: null });
});

test('a statement makes one invoice of the approved hours and the reached milestones, once', async () => {
  // A fixed price beside the hours; one that waits for its task.
  const design = await make('project.billing.milestone', 'mona', {
    name: 'Blueprint signed off',
    project: ids['project'],
    amount: '50000',
  });
  const golive = await make('project.billing.milestone', 'mona', {
    name: 'Go-live',
    project: ids['project'],
    amount: '120000',
    task: ids['visit'],
  });
  expect((await call('POST', `${M}/${golive}/transitions/reach`, 'pia')).status).toBe(409);
  expect((await call('POST', `${M}/${design}/transitions/reach`, 'pia')).status).toBe(200);
  // Hours waiting for approval, and hours after the day: neither is invoiced.
  const waiting = await log('sumi', 'analysis', '2027-01-07', '2');
  expect((await step(waiting, 'submit', 'sumi')).status).toBe(200);
  const later = await approved('sumi', 'analysis', '2027-02-03', '5');

  const first = await make('project.statement', 'mona', {
    project: ids['project'],
    dateTo: '2027-01-31',
  });
  const billed = await call('POST', `${S}/${first}/transitions/bill`, 'mona');
  expect(billed.status, JSON.stringify(billed.json)).toBe(200);
  const s = (
    await call(
      'GET',
      `${S}/${first}?fields=name,state,hours,amountTime,amountMilestones,amount,partner`,
      'mona',
    )
  ).json as Json;
  expect(s.name).toMatch(/^PBS\/\d{4}\/\d{5}$/);
  // Rafi 2 h × 4000, Sumi 4.5 h × 3000, Pia 1 h × 1500; the blueprint.
  expect({
    state: s.state,
    hours: money(s.hours),
    time: money(s.amountTime),
    milestones: money(s.amountMilestones),
    amount: money(s.amount),
  }).toEqual({
    state: 'invoiced',
    hours: '7.50',
    time: '23000.00',
    milestones: '50000.00',
    amount: '73000.00',
  });
  const invoice = await invoiceOf(first);
  expect(invoice).toMatchObject({ untaxed: '73000.00', state: 'draft' });
  expect(invoice?.lines).toEqual([
    'ERP rollout: rafi, 2027-01-04 | 2 × 4000',
    'ERP rollout: sumi, 2027-01-05 – 2027-01-06 | 4.5 × 3000',
    'ERP rollout: pia, 2027-01-06 | 1 × 1500',
    'ERP rollout: Blueprint signed off | 1 × 50000',
  ]);
  for (const key of ['rafis', 'sumis', 'trip', 'pias'])
    expect((await line(ids[key] as number)).statement).toBe(first);
  expect((await line(waiting)).statement).toBeNull();
  expect((await line(later)).statement).toBeNull();

  // Billed hours and milestones stay as they are.
  expect((await step(ids['rafis'] as number, 'reopen', 'pia')).status).toBe(409);
  expect(
    (await call('PATCH', `${M}/${design}`, 'mona', { amount: '1' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await call('POST', `${M}/${design}/transitions/revert`, 'mona')).status).toBe(409);
  expect(
    (await call('PATCH', `${S}/${first}`, 'mona', { dateTo: '2027-03-31' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await call('PATCH', `${S}/${first}`, 'mona', { amount: '1' })).status).toBe(403);

  // Asked again for the same days: nothing is left.
  const again = await make('project.statement', 'mona', {
    project: ids['project'],
    dateTo: '2027-01-31',
  });
  expect((await call('POST', `${S}/${again}/transitions/bill`, 'mona')).status).toBe(409);
  expect((await call('POST', `${S}/${again}/transitions/discard`, 'mona')).status).toBe(200);
  // The next one takes what came after.
  const second = await make('project.statement', 'mona', {
    project: ids['project'],
    dateTo: '2027-02-28',
  });
  expect((await call('POST', `${S}/${second}/transitions/bill`, 'mona')).status).toBe(200);
  expect(await invoiceOf(second)).toMatchObject({
    untaxed: '15000.00',
    lines: ['ERP rollout: sumi, 2027-02-03 | 5 × 3000'],
  });
  ids['first'] = first;
  ids['later'] = later;
  ids['second'] = second;
});

test('a statement is released only once its invoice is cancelled; its hours are then billed again', async () => {
  const second = ids['second'] as number;
  expect((await call('POST', `${S}/${second}/transitions/release`, 'mona')).status).toBe(409);
  const invoice = await invoiceOf(second);
  expect(
    (await call('POST', `/api/v1/models/account.move/${invoice?.id}/transitions/cancel`, 'mona'))
      .status,
  ).toBe(200);
  expect((await call('POST', `${S}/${second}/transitions/release`, 'mona')).status).toBe(200);
  expect((await line(ids['later'] as number)).statement).toBeNull();
  const third = await make('project.statement', 'mona', {
    project: ids['project'],
    dateTo: '2027-02-28',
  });
  expect((await call('POST', `${S}/${third}/transitions/bill`, 'mona')).status).toBe(200);
  expect(await invoiceOf(third)).toMatchObject({ untaxed: '15000.00', state: 'draft' });
  expect((await line(ids['later'] as number)).statement).toBe(third);
  // The first one's invoice still stands: it is not released.
  expect((await call('POST', `${S}/${ids['first']}/transitions/release`, 'mona')).status).toBe(409);
});

const R = '/api/v1/models/project.recognition';
/** A project's money, as a Projects manager reads it after a refresh. */
const figures = async () => {
  const refreshed = await call('POST', '/api/v1/projects/refresh', 'pia', {
    projects: [ids['project']],
  });
  expect(refreshed.status, JSON.stringify(refreshed.json)).toBe(200);
  const p = (
    await call(
      'GET',
      `/api/v1/models/project.project/${ids['project']}?fields=revenue,unbilled,profit,margin,labourCost`,
      'pia',
    )
  ).json as Json;
  return {
    revenue: money(p.revenue),
    unbilled: money(p.unbilled),
    labour: money(p.labourCost),
    profit: money(p.profit),
    margin: p.margin === null ? null : Number(p.margin).toFixed(1),
  };
};

test('what a project earned: invoiced revenue from the books, work in progress, profit and margin', async () => {
  // Sumi costs 1,000 an hour: 11.5 h logged on the project.
  const members = (await call('GET', '/api/v1/models/project.member?fields=user,project', 'pia'))
    .json.items as Json[];
  const sumi = members.find((m) => (m.user?.id ?? m.user) === users['sumi']);
  expect(
    (
      await call('PATCH', `/api/v1/models/project.member/${sumi.id}`, 'pia', {
        hourlyCost: '1000',
      })
    ).status,
  ).toBe(200);
  // Nothing is posted yet: both statements' invoices are drafts, so all of it is work in progress.
  expect(await figures()).toEqual({
    revenue: '0.00',
    unbilled: '88000.00',
    labour: '11500.00',
    profit: '76500.00',
    margin: '86.9',
  });
  // The first invoice is posted: it is revenue now, and no longer in progress.
  const invoice = await invoiceOf(ids['first'] as number);
  const posted = await call(
    'POST',
    `/api/v1/models/account.move/${invoice?.id}/transitions/post`,
    'mona',
  );
  expect(posted.status, JSON.stringify(posted.json)).toBe(200);
  expect(await figures()).toEqual({
    revenue: '73000.00',
    unbilled: '15000.00',
    labour: '11500.00',
    profit: '76500.00',
    margin: '86.9',
  });
  // Someone who logs time sees no money.
  const seen = (await call('GET', `/api/v1/models/project.project/${ids['project']}`, 'rafi'))
    .json as Json;
  expect(seen.name).toBe('ERP rollout');
  expect(seen.revenue).toBeUndefined();
  expect(seen.profit).toBeUndefined();
  // A phase: the hours on its tasks.
  const phase = await make('project.phase', 'pia', { name: 'Design', project: ids['project'] });
  expect(
    (await call('PATCH', `/api/v1/models/project.task/${ids['analysis']}`, 'pia', { phase }))
      .status,
  ).toBe(200);
  await figures();
  const ph = (
    await call(
      'GET',
      `/api/v1/models/project.phase/${phase}?fields=phaseCost,phaseEarned,phaseProfit`,
      'pia',
    )
  ).json as Json;
  // Sumi's 10 h on Analysis; Rafi 8,000, Sumi 9,000 and 15,000, Pia 1,500 approved there.
  expect([money(ph.phaseCost), money(ph.phaseEarned), money(ph.phaseProfit)]).toEqual([
    '10000.00',
    '33500.00',
    '23500.00',
  ]);
});

test('revenue recognition books the work in progress on the day and reverses it the day after, once', async () => {
  // Before any work: nothing to recognise.
  const early = await make('project.recognition', 'mona', { date: '2027-01-03' });
  expect((await call('POST', `${R}/${early}/transitions/recognise`, 'mona')).status).toBe(422);
  expect((await call('POST', `${R}/${early}/transitions/discard`, 'mona')).status).toBe(200);

  const id = await make('project.recognition', 'mona', { date: '2027-02-28' });
  const done = await call('POST', `${R}/${id}/transitions/recognise`, 'mona');
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const r = (await call('GET', `${R}/${id}?fields=name,state,amount`, 'mona')).json as Json;
  expect(r.name).toMatch(/^REV\/\d{4}\/\d{4}$/);
  // The posted invoice's 73,000 is revenue already; the draft one's 15,000 is recognised.
  expect([r.state, money(r.amount)]).toEqual(['posted', '15000.00']);
  const rows = (
    await call('GET', '/api/v1/models/project.recognition.line?fields=project,hours,amount', 'mona')
  ).json.items as Json[];
  expect(rows.map((l) => [money(l.hours), money(l.amount)])).toEqual([['5.00', '15000.00']]);
  // In the books: the entry on the day, its opposite the day after, both posted; the income on the cost centre.
  const entries = await erp.host.server.driver.query<{
    date: string;
    state: string;
    code: string;
    debit: string;
    credit: string;
    analytic: number | null;
  }>({
    text: `SELECT to_char(m.date, 'YYYY-MM-DD') AS date, m.state, a.code, l.debit::text AS debit,
                  l.credit::text AS credit, l.analytic_id AS analytic
             FROM account_move m JOIN account_move_line l ON l.move_id = m.id
             JOIN account_account a ON a.id = l.account_id
            WHERE m.project_recognition_id = $1 ORDER BY m.date, l.id`,
    params: [id],
  });
  expect(entries.map((e) => [e.date, e.state, money(e.debit), money(e.credit)])).toEqual([
    ['2027-02-28', 'posted', '15000.00', '0.00'],
    ['2027-02-28', 'posted', '0.00', '15000.00'],
    ['2027-03-01', 'posted', '0.00', '15000.00'],
    ['2027-03-01', 'posted', '15000.00', '0.00'],
  ]);
  expect(entries[0]?.code).toBe('1180');
  expect(entries[0]?.analytic).toBeNull();
  expect(entries[1]?.analytic).not.toBeNull();
  expect(entries[3]?.analytic).toBe(entries[1]?.analytic);
  // The project's invoiced revenue is the invoices', not the accrual's.
  expect((await figures()).revenue).toBe('73000.00');

  // Once a day; posted, it does not change; its figures are the server's.
  const again = await make('project.recognition', 'mona', { date: '2027-02-28' });
  expect((await call('POST', `${R}/${again}/transitions/recognise`, 'mona')).status).toBe(409);
  expect(
    (await call('PATCH', `${R}/${id}`, 'mona', { date: '2027-03-31' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await call('PATCH', `${R}/${id}`, 'mona', { amount: '1' })).status).toBe(403);
  // Not for Projects managers, nor for those who log time.
  for (const who of ['pia', 'rafi', 'bob'])
    expect((await call('GET', R, who)).status, who).toBe(403);
});
