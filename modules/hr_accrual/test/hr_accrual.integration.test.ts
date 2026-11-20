/**
 * Leave accruals on real PostgreSQL (RFC 0034 §2.5): a plan's months go to the ledger once — after probation, up
 * to the cap, from the month a person joined —; a formula may count the days worked; leave is checked against the
 * balance on the day it starts, future accruals included, whatever the type's days per year say; a balance is
 * projected over a year's end with its carry-over and expiry; adjustments by HR; who reads whose balance.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { accrueLeave, hrAccrual } from '../src/index.js';

const L = '/api/v1/models/hr.leave';
const E = '/api/v1/models/hr.accrual.entry';
const B = '/api/v1/models/hr.accrual.balance';
const P = '/api/v1/models/hr.accrual.plan';
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
const system = <T>(fn: (env: never) => Promise<T>): Promise<T> =>
  erp.host.server.shutro.bootstrap({ reason: 'test', company: erp.company }, (env) =>
    fn(env as never),
  );
/** The run, as the server's timer would on that day. */
const runOn = (today: string) => system((env) => accrueLeave(env, today));
/** A person's ledger in a plan, oldest first: kind, date, days. */
const ledger = async (employee: string, plan: string) =>
  (
    await erp.host.server.driver.query<{ kind: string; date: string; days: string }>({
      text: `SELECT kind, to_char(date, 'YYYY-MM-DD') AS date, days::text AS days FROM hr_accrual_entry
              WHERE employee_id = $1 AND plan_id = $2 ORDER BY date, id`,
      params: [ids[employee], ids[plan]],
    })
  ).map((e) => `${e.kind} ${e.date} ${Number(e.days).toFixed(2)}`);
/** Leave asked for by its owner: made and submitted; the status of the submission. */
const ask = async (as: string, type: string, from: string, to: string, days: number) => {
  const id = await make('hr.leave', as, {
    employee: ids[as],
    type: ids[type],
    dateFrom: from,
    dateTo: to,
    days,
  });
  return { id, status: (await call('POST', `${L}/${id}/transitions/submit`, as)).status };
};
const projection = async (as: string, employee: string, date: string) =>
  call(
    'GET',
    `/api/v1/leave-accruals/projection?employee=${ids[employee]}&type=${ids['annual']}&date=${date}`,
    as,
  );

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [hrAccrual],
    users: {
      pia: ['hr.manager', 'attendance.manager', 'payroll.manager'],
      rafi: ['hr.user'],
      sumi: ['hr.user'],
      bob: ['base.user'],
    },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
  for (const u of await erp.host.server.driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  }))
    users[u.login] = Number(u.id);
  ids['rafi'] = await make('hr.employee', 'pia', {
    name: 'Rafi',
    user: users['rafi'],
    hireDate: '2027-01-01',
  });
  ids['sumi'] = await make('hr.employee', 'pia', {
    name: 'Sumi',
    user: users['sumi'],
    hireDate: '2027-03-15',
  });
  ids['tom'] = await make('hr.employee', 'pia', { name: 'Tom, without a joining date' });
  // One day a year by the type: the plan decides instead.
  ids['annual'] = await make('hr.leave.type', 'pia', { name: 'Annual leave', daysPerYear: 1 });
  ids['earned'] = await make('hr.leave.type', 'pia', { name: 'Earned leave' });
  ids['plan'] = await make('hr.accrual.plan', 'pia', {
    name: 'Annual: a day and a half a month',
    type: ids['annual'],
    dateStart: '2027-01-01',
    formula: '1.5',
    probationMonths: 3,
    cap: '6',
    carryOver: '4',
    carryExpiryMonth: 3,
  });
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('a plan’s formula is checked, and a leave type has one active plan', async () => {
  const bad = async (formula: string) =>
    (
      await call('POST', P, 'pia', {
        name: 'Broken',
        type: ids['earned'],
        dateStart: '2027-01-01',
        formula,
      })
    ).status;
  expect(await bad('WAGE / 30')).toBeGreaterThanOrEqual(400); // Payroll's variable, not a plan's
  expect(await bad('1 +')).toBeGreaterThanOrEqual(400);
  expect(
    (
      await call('POST', P, 'pia', {
        name: 'A second plan for annual leave',
        type: ids['annual'],
        dateStart: '2027-01-01',
        formula: '2',
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  // Plans are HR's to keep.
  expect((await call('PATCH', `${P}/${ids['plan']}`, 'rafi', { formula: '30' })).status).toBe(403);
});

test('the months that are over go to the ledger once: after probation, up to the cap, from the month joined', async () => {
  expect(await runOn('2027-07-10')).toBe(5);
  // Rafi joined on 1 January: three months of probation, then 1.5 a month up to 6.
  expect(await ledger('rafi', 'plan')).toEqual([
    'accrual 2027-03-31 1.50',
    'accrual 2027-04-30 1.50',
    'accrual 2027-05-31 1.50',
    'accrual 2027-06-30 1.50',
  ]);
  // Sumi joined on 15 March: her third full month ends in June.
  expect(await ledger('sumi', 'plan')).toEqual(['accrual 2027-06-30 1.50']);
  // Nothing for someone without a joining date; nothing twice.
  expect(await ledger('tom', 'plan')).toEqual([]);
  expect(await runOn('2027-07-10')).toBe(0);
  expect(await runOn('2027-07-31')).toBe(0);
  // July: Rafi is at the cap, Sumi earns.
  expect(await runOn('2027-08-02')).toBe(1);
  expect((await ledger('rafi', 'plan')).length).toBe(4);
  expect(await ledger('sumi', 'plan')).toEqual([
    'accrual 2027-06-30 1.50',
    'accrual 2027-07-31 1.50',
  ]);
});

test('leave is checked against the balance on the day it starts, future accruals included', async () => {
  // Two of Rafi's six days in August.
  const august = await ask('rafi', 'annual', '2027-08-08', '2027-08-09', 2);
  expect(august.status).toBe(200);
  // Five more later that month: four are left then.
  const tooMuch = await ask('rafi', 'annual', '2027-08-22', '2027-08-26', 5);
  expect(tooMuch.status).toBeGreaterThanOrEqual(400);
  expect((await call('DELETE', `${L}/${tooMuch.id}`, 'rafi')).status).toBeLessThan(300);
  // In December he will have earned them: 4, then 1.5 and 0.5 up to the cap.
  const december = await ask('rafi', 'annual', '2027-12-05', '2027-12-09', 5);
  expect(december.status).toBe(200);
  // Sumi has three days: four are too many, now and in August.
  expect(
    (await ask('sumi', 'annual', '2027-08-08', '2027-08-11', 4)).status,
  ).toBeGreaterThanOrEqual(400);
  ids['august'] = august.id;
});

test('a balance is projected to any day: the year’s end, the carry-over, what expires', async () => {
  const end = await projection('rafi', 'rafi', '2027-12-31');
  expect(end.status, JSON.stringify(end.json)).toBe(200);
  // 6 − 2 in August, + 1.5 and + 0.5 to the cap, − 5 in December, + 1.5 at its end.
  expect(end.json.balance).toBe('2.50');
  expect(end.json.steps.map((s: Json) => [s.month, s.accrued, s.taken, s.balance])).toEqual([
    ['2027-08', '1.50', '2.00', '5.50'],
    ['2027-09', '0.50', '0.00', '6.00'],
    ['2027-10', '0.00', '0.00', '6.00'],
    ['2027-11', '0.00', '0.00', '6.00'],
    ['2027-12', '1.50', '5.00', '2.50'],
  ]);
  // Into 2028: the 2.5 days are carried (four may be); those not used by 31 March are lost.
  const spring = await projection('rafi', 'rafi', '2028-04-30');
  expect(spring.json.expiring).toEqual({ days: '2.50', on: '2028-03-31' });
  const march = (spring.json.steps as Json[]).find((s) => s.month === '2028-03');
  expect([march.accrued, march.lost, march.balance]).toEqual(['1.50', '2.50', '4.50']);
  expect(spring.json.balance).toBe('6.00');
  // The day before a month ends: its leave counts, its accrual not yet.
  expect((await projection('rafi', 'rafi', '2027-12-30')).json.balance).toBe('1.00');

  // Read by the person, their manager and HR; not by a colleague, nor without Workforce.
  expect((await projection('pia', 'rafi', '2027-12-31')).status).toBe(200);
  expect((await projection('sumi', 'rafi', '2027-12-31')).status).toBe(403);
  expect((await projection('bob', 'rafi', '2027-12-31')).status).toBe(403);
  // No plan for the type, or no joining date: nothing to project.
  expect(
    (
      await call(
        'GET',
        `/api/v1/leave-accruals/projection?employee=${ids['rafi']}&type=${ids['earned']}&date=2027-12-31`,
        'pia',
      )
    ).status,
  ).toBe(404);
  expect((await projection('pia', 'tom', '2027-12-31')).status).toBe(404);
  expect((await call('GET', '/api/v1/leave-accruals/projection?employee=x', 'pia')).status).toBe(
    400,
  );
});

test('balances: today, this year, at the year’s end; each reads their own', async () => {
  // HR approves the August leave; the run brings the balances up to date.
  expect((await call('POST', `${L}/${ids['august']}/transitions/approve`, 'pia')).status).toBe(200);
  expect(await runOn('2027-08-20')).toBe(0);
  const all = (
    await call(
      'GET',
      `${B}?fields=employee,balance,available,accruedYear,takenYear,yearEnd,accruedThrough`,
      'pia',
    )
  ).json.items as Json[];
  const of = (who: string) => all.find((b) => (b.employee?.id ?? b.employee) === ids[who]);
  const figures = (b: Json) => ({
    balance: Number(b.balance).toFixed(2),
    available: Number(b.available).toFixed(2),
    accrued: Number(b.accruedYear).toFixed(2),
    taken: Number(b.takenYear).toFixed(2),
    yearEnd: Number(b.yearEnd).toFixed(2),
    through: b.accruedThrough,
  });
  // Rafi: 6 earned, 2 taken; the 5 days of December are asked for, so one is free to ask.
  expect(figures(of('rafi'))).toEqual({
    balance: '4.00',
    available: '-1.00',
    accrued: '6.00',
    taken: '2.00',
    yearEnd: '2.50',
    through: '2027-07',
  });
  // Sumi: 3 now, and 1.5 a month up to the cap by December.
  expect(figures(of('sumi'))).toMatchObject({ balance: '3.00', yearEnd: '6.00' });
  expect(of('tom')).toBeUndefined();
  // One's own only; nothing without Workforce.
  const mine = (await call('GET', `${B}?fields=employee`, 'rafi')).json.items as Json[];
  expect(mine.map((b) => b.employee?.id ?? b.employee)).toEqual([ids['rafi']]);
  expect((await call('GET', B, 'bob')).status).toBe(403);
  // The figures are the server's.
  expect((await call('PATCH', `${B}/${of('rafi').id}`, 'pia', { balance: '99' })).status).toBe(403);
});

test('HR gives days as adjustments; the ledger is never changed', async () => {
  const given = await call('POST', E, 'pia', {
    employee: ids['sumi'],
    plan: ids['plan'],
    date: '2027-08-15',
    days: '2',
    note: 'Carried from the old system',
  });
  expect(given.status, JSON.stringify(given.json)).toBe(201);
  expect((await call('GET', `${E}/${given.json.id}?fields=kind`, 'pia')).json.kind).toBe(
    'adjustment',
  );
  // Not as an accrual; not by the person; not changed or deleted afterwards.
  expect(
    (
      await call('POST', E, 'pia', {
        employee: ids['sumi'],
        plan: ids['plan'],
        date: '2027-08-15',
        days: '5',
        kind: 'accrual',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await call('POST', E, 'sumi', {
        employee: ids['sumi'],
        plan: ids['plan'],
        date: '2027-08-15',
        days: '5',
      })
    ).status,
  ).toBe(403);
  expect((await call('PATCH', `${E}/${given.json.id}`, 'pia', { days: '9' })).status).toBe(403);
  expect((await call('DELETE', `${E}/${given.json.id}`, 'pia')).status).toBe(403);
  // Five days now: four in August, which were too many before.
  expect((await ask('sumi', 'annual', '2027-08-22', '2027-08-25', 4)).status).toBe(200);
  // Her leave is asked for, not approved yet: August accrues on 3 + 2 days, and only one more fits under the cap.
  expect(await runOn('2027-09-03')).toBe(2);
  expect((await ledger('sumi', 'plan')).slice(-2)).toEqual([
    'adjustment 2027-08-15 2.00',
    'accrual 2027-08-31 1.00',
  ]);
});

test('a formula may count the days worked: a day for every eighteen', async () => {
  ids['worked'] = await make('hr.accrual.plan', 'pia', {
    name: 'Earned: a day for 18 worked',
    type: ids['earned'],
    dateStart: '2027-08-01',
    formula: 'WORKED_DAYS / 18',
  });
  // Rafi's approved attendance of August: 18 days present, 2 on tour, 1 absent. Sumi's: none.
  await system(async (env: Json) => {
    const rows: Record<string, unknown>[] = [];
    for (let day = 1; day <= 21; day += 1)
      rows.push({
        employee: ids['rafi'],
        company: erp.company,
        date: `2027-08-${String(day).padStart(2, '0')}`,
        status: day <= 18 ? 'present' : day <= 20 ? 'tour' : 'absent',
      });
    const made = await env.model('attendance.day').create(rows);
    await env.asSuperuser({ reason: 'test' }, (su: Json) =>
      su.model('attendance.day').browse(made.ids).approve(),
    );
  });
  await runOn('2027-09-04');
  // 20 days count: 1.11.
  expect(await ledger('rafi', 'worked')).toEqual(['accrual 2027-08-31 1.11']);
  expect(await ledger('sumi', 'worked')).toEqual([]);
});

const X = '/api/v1/models/hr.leave.encashment';

test('days are paid out through Payroll: approved by HR against the balance, valued by the plan, once', async () => {
  const payout = async (as: string, daysAsked: string, date = '2027-09-10') => {
    const id = await make('hr.leave.encashment', as, {
      employee: ids[as],
      plan: ids['plan'],
      days: daysAsked,
      date,
    });
    expect((await call('POST', `${X}/${id}/transitions/submit`, as)).status).toBe(200);
    return id;
  };
  const approve = (id: number, as = 'pia') => call('POST', `${X}/${id}/transitions/approve`, as);
  // The plan does not pay days out yet.
  const first = await payout('rafi', '1');
  const refused = await approve(first);
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.json)).toContain('not paid out');
  // HR switches it on: a day is worth the wage over 30, and two days stay.
  expect(
    (
      await call('PATCH', `${P}/${ids['plan']}`, 'pia', {
        encashable: true,
        encashKeep: '2',
        encashFormula: 'WAGE / 30',
      })
    ).status,
  ).toBe(200);
  expect(
    (await call('PATCH', `${P}/${ids['plan']}`, 'pia', { encashFormula: 'BASIC / 26' })).status,
  ).toBeGreaterThanOrEqual(400);
  // No contract yet.
  expect(JSON.stringify((await approve(first)).json)).toContain('no running contract');
  // A contract on a structure that does not pay the input.
  const structure = await make('payroll.structure', 'pia', {
    name: 'Plain',
    rules: {
      create: [{ sequence: 10, code: 'BASIC', name: 'Basic', category: 'basic', formula: 'WAGE' }],
    },
  });
  const contract = await make('hr.contract', 'pia', {
    name: 'Rafi 2027',
    employee: ids['rafi'],
    dateStart: '2027-01-01',
    wage: '45000',
    structure,
  });
  expect(
    (await call('POST', `/api/v1/models/hr.contract/${contract}/transitions/start`, 'pia')).status,
  ).toBe(200);
  expect(JSON.stringify((await approve(first)).json)).toContain('INPUT_LEAVE_ENCASH');
  await make('payroll.rule', 'pia', {
    structure,
    sequence: 40,
    code: 'LEAVE_ENCASH',
    name: 'Leave paid out',
    category: 'allowance',
    formula: 'INPUT_LEAVE_ENCASH',
  });
  // Never one's own; not by someone who only asks.
  expect((await approve(first, 'rafi')).status).toBeGreaterThanOrEqual(403);
  // Rafi's balance on 10 September: 6 − 2 taken in August, + 1.5 for August = 5.5; two stay: 3.5 are free.
  const tooMany = await payout('rafi', '4');
  const short = await approve(tooMany);
  expect(short.status).toBe(422);
  expect(JSON.stringify(short.json)).toContain('Only 3.50 day(s)');
  // One day: 45,000 / 30.
  const done = await approve(first);
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const r = (await call('GET', `${X}/${first}?fields=name,state,dayValue,amount,input`, 'pia'))
    .json as Json;
  expect(r.name).toMatch(/^ENC\/\d{4}\/\d{4}$/);
  expect([r.state, Number(r.dayValue).toFixed(2), Number(r.amount).toFixed(2)]).toEqual([
    'approved',
    '1500.00',
    '1500.00',
  ]);
  // In the ledger, and waiting for September's payroll.
  expect((await ledger('rafi', 'plan')).at(-1)).toBe('encashment 2027-09-10 -1.00');
  const inputs = await erp.host.server.driver.query<{ code: string; amount: string; date: string }>(
    {
      text: `SELECT code, amount::text AS amount, to_char(date, 'YYYY-MM-DD') AS date FROM payroll_input
              WHERE employee_id = $1`,
      params: [ids['rafi']],
    },
  );
  expect(inputs.map((i) => [i.code, Number(i.amount).toFixed(2), i.date])).toEqual([
    ['LEAVE_ENCASH', '1500.00', '2027-09-10'],
  ]);
  // Approved once: not again, and not changed.
  expect((await approve(first)).status).toBe(409);
  expect(
    (await call('PATCH', `${X}/${first}`, 'pia', { days: '3' })).status,
  ).toBeGreaterThanOrEqual(400);
  expect((await call('PATCH', `${X}/${first}`, 'pia', { amount: '99999' })).status).toBe(403);
  // What is left: 2.5 more, not the 4 asked before; a refusal says why.
  expect((await approve(tooMany)).status).toBe(422);
  expect((await call('POST', `${X}/${tooMany}/transitions/refuse`, 'pia')).status).toBe(409);
  expect(
    (await call('PATCH', `${X}/${tooMany}`, 'pia', { refuseReason: 'More than may be paid out' }))
      .status,
  ).toBe(200);
  expect((await call('POST', `${X}/${tooMany}/transitions/refuse`, 'pia')).status).toBe(200);
  // Each sees their own requests.
  const mine = (await call('GET', `${X}?fields=employee`, 'sumi')).json.items as Json[];
  expect(mine).toEqual([]);
  expect((await call('GET', X, 'bob')).status).toBe(403);
  // The balance follows.
  expect((await projection('pia', 'rafi', '2027-09-10')).json.balance).toBe('4.50');
});
