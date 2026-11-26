/**
 * The final settlement on real PostgreSQL (RFC 0039 §6): what a person who leaves is owed and owes, worked out by
 * the server — the unpaid days, the gratuity, the notice not served, the loans in full —, lines added by hand
 * kept, approved by a Payroll manager only, never their own and never on figures that changed; the approval makes
 * the settlement's payroll run with its proof, repays the loans, ends the contract, and the month's regular run
 * no longer pays the person.
 */
import { type TestInstallation, testInstallation } from '@kosh/server/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fullMonths, payroll } from '../src/index.js';

const S = '/api/v1/models/payroll.settlement';
const R = '/api/v1/models/payroll.run';
let erp: TestInstallation;
const ids: Record<string, number> = {};
const users: Record<string, number> = {};

// biome-ignore lint/suspicious/noExplicitAny: test assertions read untyped JSON responses
type Json = any;
const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, as: string, body?: unknown) => {
  const res = await erp.call(method, url, as, body);
  return { status: res.status, json: res.json as Json };
};
const make = async (model: string, as: string, values: Record<string, unknown>) => {
  const made = await call('POST', `/api/v1/models/${model}`, as, values);
  expect(made.status, `${model}: ${JSON.stringify(made.json)}`).toBe(201);
  return made.json.id as number;
};
const step = (model: string, id: number, name: string, as: string) =>
  call('POST', `/api/v1/models/${model}/${id}/transitions/${name}`, as);
const list = async (model: string, as: string, filter: Record<string, unknown>, fields: string) =>
  (
    await call(
      'GET',
      `/api/v1/models/${model}?filter=${encodeURIComponent(JSON.stringify(filter))}&fields=${fields}&limit=50`,
      as,
    )
  ).json.items as Json[];

beforeAll(async () => {
  process.env['KOSH_SCHEDULES'] = 'off';
  erp = await testInstallation({
    modules: [payroll],
    users: {
      pia: ['payroll.manager', 'hr.manager', 'attendance.manager'],
      otto: ['payroll.officer', 'hr.manager'],
      rafi: ['payroll.user'],
      sumi: ['payroll.user'],
    },
    company: { name: 'Padma Mills', currency: 'BDT' },
  });
  for (const u of await erp.host.server.driver.query<{ id: number; login: string }>({
    text: 'SELECT id, login FROM res_users',
    params: [],
  }))
    users[u.login] = Number(u.id);
  ids['structure'] = await make('payroll.structure', 'pia', {
    name: 'Staff',
    settleGratuity: 'if(SERVICE_YEARS >= 2, WAGE / 2 * SERVICE_YEARS, 0)',
    rules: {
      create: [{ sequence: 10, code: 'BASIC', name: 'Basic', category: 'basic', formula: 'WAGE' }],
    },
  });
  for (const who of ['rafi', 'sumi', 'pia']) {
    ids[who] = await make('hr.employee', 'pia', {
      name: who,
      user: users[who],
      hireDate: '2024-01-01',
    });
    ids[`${who}Contract`] = await make('hr.contract', 'pia', {
      name: `${who} employment`,
      employee: ids[who],
      dateStart: '2024-01-01',
      wage: '30000',
      structure: ids['structure'],
    });
    expect(
      (await step('hr.contract', ids[`${who}Contract`] as number, 'start', 'pia')).status,
    ).toBe(200);
  }
}, 300_000);

afterAll(async () => {
  await erp?.close();
});

test('service is counted in full months', () => {
  expect(fullMonths('2024-01-01', '2026-06-15')).toBe(29);
  expect(fullMonths('2024-01-16', '2024-02-15')).toBe(1);
  expect(fullMonths('2024-01-16', '2024-02-14')).toBe(0);
});

test('a settlement formula that does not read is refused', async () => {
  const bad = await call('PATCH', `/api/v1/models/payroll.structure/${ids['structure']}`, 'pia', {
    settleNotice: 'WAGE /',
  });
  expect(bad.status).toBe(422);
});

test('a person who resigns: worked out, checked, approved by a manager — its run, the loans, the contract', async () => {
  // May is paid by the regular run; a loan starts in June.
  const may = await make('payroll.run', 'otto', { dateFrom: '2026-05-01', dateTo: '2026-05-31' });
  expect((await step('payroll.run', may, 'compute', 'otto')).status).toBe(200);
  expect((await step('payroll.run', may, 'approve', 'pia')).status).toBe(200);
  const loan = await make('payroll.loan', 'otto', {
    employee: ids['rafi'],
    amount: '6000',
    installment: '2000',
    dateStart: '2026-06-01',
  });
  expect((await step('payroll.loan', loan, 'start', 'pia')).status).toBe(200);

  // Rafi resigns: his last day is 15 June; of thirty days of notice he works twenty.
  const id = await make('payroll.settlement', 'otto', {
    employee: ids['rafi'],
    lastDay: '2026-06-15',
    reason: 'resignation',
    noticeDays: 30,
    noticeServed: 20,
  });
  const computed = await step('payroll.settlement', id, 'compute', 'otto');
  expect(computed.status, JSON.stringify(computed.json)).toBe(200);
  const read = async () =>
    (await call('GET', `${S}/${id}?fields=gross,deductions,net,unpaidFrom,state,run`, 'otto')).json;
  const lines = async () =>
    Object.fromEntries(
      (
        await list(
          'payroll.settlement.line',
          'otto',
          { settlement: id },
          'code,amount,category,explanation,manual',
        )
      ).map((l) => [l.code, l]),
    );
  let worked = await lines();
  // 15 unpaid days of a wage of 30 000; two full years of service; ten days of notice short; the whole loan.
  expect(Number(worked['SALARY'].amount)).toBe(15000);
  expect(worked['SALARY'].explanation).toContain('= 15000');
  expect(Number(worked['GRATUITY'].amount)).toBe(30000);
  expect(Number(worked['NOTICE_SHORT'].amount)).toBe(10000);
  expect(worked['NOTICE_SHORT'].category).toBe('deduction');
  expect(Number(worked['LOAN_SETTLE'].amount)).toBe(6000);
  let figures = await read();
  expect(String(figures.unpaidFrom).slice(0, 10)).toBe('2026-06-01');
  expect([Number(figures.gross), Number(figures.deductions), Number(figures.net)]).toEqual([
    45000, 16000, 29000,
  ]);

  // An officer does not approve; a line added after the computation changes the figures: computed again first.
  expect((await step('payroll.settlement', id, 'approve', 'otto')).status).toBe(403);
  await make('payroll.settlement.line', 'otto', {
    settlement: id,
    code: 'FAREWELL',
    name: 'Farewell bonus',
    category: 'allowance',
    amount: '1000',
  });
  const stale = await step('payroll.settlement', id, 'approve', 'pia');
  expect(stale.status).toBe(422);
  expect(JSON.stringify(stale.json)).toContain('figures changed');
  expect((await step('payroll.settlement', id, 'compute', 'otto')).status).toBe(200);
  worked = await lines();
  // The line added by hand is kept; the server's are not doubled.
  expect(Object.keys(worked).sort()).toEqual([
    'FAREWELL',
    'GRATUITY',
    'LOAN_SETTLE',
    'NOTICE_SHORT',
    'SALARY',
  ]);
  expect(worked['FAREWELL'].manual).toBe(true);
  expect(worked['SALARY'].manual).toBe(false);
  expect(Number((await read()).net)).toBe(30000);

  // Before approval it is not Rafi's to read.
  expect(await list('payroll.settlement', 'rafi', {}, 'net')).toEqual([]);
  const approved = await step('payroll.settlement', id, 'approve', 'pia');
  expect(approved.status, JSON.stringify(approved.json)).toBe(200);
  figures = await read();
  expect(figures.state).toBe('approved');
  const runId = typeof figures.run === 'object' ? figures.run.id : figures.run;
  expect(runId).toBeGreaterThan(0);

  // Its run: of the kind settlement, approved, one payslip of 30 000 with the settlement's lines — and it adds up.
  const run = (
    await call('GET', `${R}/${runId}?fields=kind,state,slipCount,net,dateFrom,dateTo`, 'pia')
  ).json;
  expect([run.kind, run.state, run.slipCount, Number(run.net)]).toEqual([
    'settlement',
    'approved',
    1,
    30000,
  ]);
  const slips = await list('payroll.slip', 'pia', { run: runId }, 'employee,gross,deductions,net');
  expect(slips).toHaveLength(1);
  expect([Number(slips[0].gross), Number(slips[0].deductions), Number(slips[0].net)]).toEqual([
    46000, 16000, 30000,
  ]);
  const proof = (await call('GET', `/api/v1/payroll/runs/${runId}/check`, 'pia')).json;
  expect(JSON.stringify(proof)).not.toContain('"ok":false');
  // The loan is repaid in full; the contract ended on the last day.
  const repaid = (
    await call('GET', `/api/v1/models/payroll.loan/${loan}?fields=state,remaining`, 'pia')
  ).json;
  expect([repaid.state, Number(repaid.remaining)]).toEqual(['done', 0]);
  const contract = (
    await call(
      'GET',
      `/api/v1/models/hr.contract/${ids['rafiContract']}?fields=state,dateEnd`,
      'pia',
    )
  ).json;
  expect([contract.state, String(contract.dateEnd).slice(0, 10)]).toEqual(['ended', '2026-06-15']);

  // Rafi reads his own, Sumi does not; nobody is settled twice; and approved, its lines are closed.
  expect(await list('payroll.settlement', 'rafi', {}, 'net')).toHaveLength(1);
  expect(await list('payroll.settlement', 'sumi', {}, 'net')).toEqual([]);
  const again = await call('POST', S, 'otto', {
    employee: ids['rafi'],
    lastDay: '2026-06-30',
    reason: 'resignation',
  });
  expect(again.status).toBe(422);
  expect(JSON.stringify(again.json)).toContain('already has a final settlement');
  expect(
    (
      await call('POST', '/api/v1/models/payroll.settlement.line', 'otto', {
        settlement: id,
        code: 'LATE',
        name: 'Too late',
        category: 'allowance',
        amount: '5',
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);

  // June's regular run pays the others, not Rafi a second time.
  const june = await make('payroll.run', 'otto', { dateFrom: '2026-06-01', dateTo: '2026-06-30' });
  expect((await step('payroll.run', june, 'compute', 'otto')).status).toBe(200);
  const paid = (await list('payroll.slip', 'pia', { run: june }, 'employee')).map((s) =>
    typeof s.employee === 'object' ? s.employee.id : s.employee,
  );
  expect(paid).toContain(ids['sumi']);
  expect(paid).not.toContain(ids['rafi']);
});

test('nobody approves their own settlement; the company that terminates pays the notice it did not give', async () => {
  const id = await make('payroll.settlement', 'otto', {
    employee: ids['pia'],
    lastDay: '2026-06-30',
    reason: 'termination',
    noticeDays: 30,
    noticeServed: 0,
  });
  expect((await step('payroll.settlement', id, 'compute', 'otto')).status).toBe(200);
  const lines = await list(
    'payroll.settlement.line',
    'otto',
    { settlement: id, code: 'NOTICE_PAY' },
    'amount,category',
  );
  expect(lines).toHaveLength(1);
  expect([Number(lines[0].amount), lines[0].category]).toEqual([30000, 'allowance']);
  const own = await step('payroll.settlement', id, 'approve', 'pia');
  expect(own.status).toBeGreaterThanOrEqual(400);
  expect(own.status).not.toBe(200);
  expect((await step('payroll.settlement', id, 'cancel', 'otto')).status).toBe(200);
});
