/**
 * What a salary rule may read (RFC 0039 §4), in one list: the names the engine sets for every payslip, and the
 * families whose names come from the company's own data — the shifts' codes, the leave types', the employment
 * types', the parameters, the one-off inputs. The rule form shows the list, `GET /api/v1/payroll/variables` serves
 * it with the codes that exist, and a test holds it to what `compute.ts` really sets.
 */
import type { Env } from './.kosh/bindings.js';

export interface PayrollVariable {
  readonly name: string;
  readonly about: string;
}

export interface VariableGroup {
  readonly key: string;
  readonly label: string;
  readonly variables: readonly PayrollVariable[];
}

const v = (name: string, about: string): PayrollVariable => ({ name, about });

/** The names every payslip has, by what they are about. */
export const PAYROLL_VARIABLES: readonly VariableGroup[] = [
  {
    key: 'contract',
    label: 'The contract',
    variables: [
      v('WAGE', 'The contract’s wage: for a month, a day or an hour, as the contract says'),
      v('PAID_BY_DAY', '1 when the wage is for each day worked, else 0'),
      v('PAID_BY_HOUR', '1 when the wage is for each hour worked, else 0'),
      v('SERVICE_MONTHS', 'Months since the person joined, at the period’s end'),
    ],
  },
  {
    key: 'period',
    label: 'The period',
    variables: [
      v('PERIOD_DAYS', 'The days of the run’s period'),
      v(
        'CONTRACT_DAYS',
        'The contract’s days inside the period: joiners and leavers in proportion',
      ),
      v('MONTH', 'The month of the period’s end, 1 to 12'),
      v('FY_MONTH', 'The month of the fiscal year, 1 to 12'),
      v('MONTHS_LEFT', 'Months left in the fiscal year, this one included'),
      v('FESTIVAL', '1 in a run that pays a festival bonus, else 0'),
    ],
  },
  {
    key: 'attendance',
    label: 'Approved attendance',
    variables: [
      v('PRESENT_DAYS', 'Days present, on tour or at home; half a day of leave counts as half'),
      v('TOUR_DAYS', 'Days on an official tour'),
      v('REMOTE_DAYS', 'Days of home office'),
      v('ABSENT_DAYS', 'Days absent; half a day of leave counts as half'),
      v('HOLIDAYS', 'Public holidays'),
      v('LATE_DAYS', 'Days arrived late'),
      v('OVERTIME_HOURS', 'Approved overtime'),
      v('OVERTIME_RATE', 'The overtime rate of the latest day with overtime'),
    ],
  },
  {
    key: 'shifts',
    label: 'Shifts',
    variables: [
      v('WORKED_HOURS', 'Hours worked'),
      v('EXPECTED_HOURS', 'Hours the shifts expected'),
      v('LATE_MINUTES', 'Minutes late, summed'),
      v('EARLY_MINUTES', 'Minutes left early, summed'),
      v('NIGHT_SHIFTS', 'Days worked on a shift that ends the next day'),
      v('OFF_DAYS_WORKED', 'Days worked on a weekend or a holiday'),
    ],
  },
  {
    key: 'leave',
    label: 'Leave',
    variables: [
      v('LEAVE_DAYS', 'Approved days on leave, halves included'),
      v('PAID_LEAVE_DAYS', 'Of them, the days of paid leave types'),
      v('UNPAID_LEAVE_DAYS', 'Of them, the days of unpaid leave types'),
      v('HALF_DAYS', 'Days with half a day of leave'),
    ],
  },
  {
    key: 'money',
    label: 'Loans and totals',
    variables: [
      v('LOAN', 'This period’s instalments of running loans, never more than remains'),
      v('GROSS', 'Basic and allowances of the rules before this one'),
      v('DEDUCTIONS', 'Deductions of the rules before this one'),
    ],
  },
];

/** The families named by the company's data: the prefix, and what completes it. */
export const VARIABLE_FAMILIES: readonly PayrollVariable[] = [
  v('SHIFT_<CODE>', 'Approved days worked on the shift with that code'),
  v('LEAVE_<CODE>', 'Approved days of the leave type with that code'),
  v('TYPE_<CODE>', '1 when the contract’s employment type has that code, else 0'),
  v('P_<CODE>', 'The parameter in force at the period’s end'),
  v('E_<CODE>', 'The person’s own value in force (0 when they have none)'),
  v('INPUT_<CODE>', 'The period’s one-off inputs of that code, summed (0 when none)'),
  v('YTD_<CODE>', 'What the rule with that code paid this fiscal year before the period'),
  v('<RULE CODE>', 'The amount of an earlier rule of the structure'),
];

export const FORMULA_FUNCTIONS = ['min', 'max', 'abs', 'round', 'floor', 'ceil', 'if', 'slab'];

/** The list in a sentence, for the rule form. */
export const VARIABLES_HELP = `${PAYROLL_VARIABLES.map(
  (g) => `${g.label}: ${g.variables.map((x) => x.name).join(', ')}.`,
).join(
  ' ',
)} By code: ${VARIABLE_FAMILIES.map((x) => x.name).join(', ')}. Functions: ${FORMULA_FUNCTIONS.join(', ')}.`;

const codeOf = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * Every name a rule may read here and now: the engine's, and the families completed with the codes that exist —
 * the shifts', the leave and employment types', the parameters, the values and inputs in use, the slab tables,
 * and the codes of a structure's rules when one is given.
 */
export async function variablesNow(
  env: Env,
  structure: number | null,
): Promise<{
  groups: readonly VariableGroup[];
  families: readonly (PayrollVariable & { names: string[] })[];
  slabs: string[];
  functions: readonly string[];
}> {
  await env.flush();
  const codes = async (rows: Promise<readonly { code: string | null }[]>): Promise<string[]> =>
    [...new Set((await rows).map((r) => codeOf(r.code ?? '')).filter((c) => c !== ''))].sort();
  const names: Record<string, string[]> = {
    'SHIFT_<CODE>': await codes(
      env.sql<{
        code: string | null;
      }>`SELECT DISTINCT code FROM attendance_shift WHERE code IS NOT NULL`,
    ),
    'LEAVE_<CODE>': await codes(
      env.sql<{
        code: string | null;
      }>`SELECT DISTINCT code FROM hr_leave_type WHERE code IS NOT NULL`,
    ),
    'TYPE_<CODE>': await codes(
      env.sql<{
        code: string | null;
      }>`SELECT DISTINCT code FROM hr_contract_type WHERE code IS NOT NULL`,
    ),
    'P_<CODE>': await codes(
      env.sql<{ code: string | null }>`SELECT DISTINCT code FROM payroll_parameter`,
    ),
    'E_<CODE>': await codes(
      env.sql<{ code: string | null }>`SELECT DISTINCT code FROM payroll_employee_value`,
    ),
    'INPUT_<CODE>': await codes(
      env.sql<{ code: string | null }>`SELECT DISTINCT code FROM payroll_input`,
    ),
  };
  const rules =
    structure === null
      ? []
      : await codes(
          env.sql<{ code: string | null }>`
            SELECT DISTINCT code FROM payroll_rule WHERE structure_id = ${structure}`,
        );
  names['YTD_<CODE>'] = rules;
  names['<RULE CODE>'] = rules;
  const prefix = (family: string): string => family.replace(/<.*$/, '');
  return {
    groups: PAYROLL_VARIABLES,
    families: VARIABLE_FAMILIES.map((f) => ({
      ...f,
      names: (names[f.name] ?? []).map((code) => `${prefix(f.name)}${code}`),
    })),
    slabs: await codes(env.sql<{ code: string | null }>`SELECT DISTINCT code FROM payroll_slab`),
    functions: FORMULA_FUNCTIONS,
  };
}
