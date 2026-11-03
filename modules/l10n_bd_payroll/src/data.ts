/**
 * Bangladesh payroll as data (RFC 0024 §2.3): two salary structures, the parameters they read and the income tax
 * slabs. Nothing here is code: a payroll manager changes any value in Payroll › Configuration, and a new fiscal
 * year's rates are a new parameter or slab table with its dates — never an edit of the old one.
 *
 * **Verify before use.** The tax figures below (the tax-free threshold and bands, the exemption cap, the investment
 * rebate and the minimum tax) follow the Finance Act as last known when this was written; each carries a note to
 * check it against the year's Finance Act and the NBR's circular. Company policies (the basic's share, the house
 * rent, provident fund rates) are defaults to adjust.
 */

const VERIFY = 'Verify against the Finance Act and the NBR circular of the income year before use.';
const POLICY = 'A company policy: adjust to yours.';

export interface ParameterData {
  readonly code: string;
  readonly name: string;
  readonly value: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly note: string;
}

export const PARAMETERS: readonly ParameterData[] = [
  {
    code: 'BD_BASIC_PCT',
    name: 'Basic, % of the gross (standard structure)',
    value: '60',
    note: POLICY,
  },
  {
    code: 'BD_HOUSE_RENT_PCT',
    name: 'House rent, % of the basic (standard structure)',
    value: '50',
    note: POLICY,
  },
  {
    code: 'BD_MEDICAL_PCT',
    name: 'Medical, % of the basic (standard structure)',
    value: '10',
    note: POLICY,
  },
  {
    code: 'BD_RMG_HOUSE_RENT_PCT',
    name: 'House rent, % of the basic (garments)',
    value: '50',
    note: 'The garments minimum wage gazette (2023): house rent 50% of the basic.',
  },
  {
    code: 'BD_RMG_MEDICAL',
    name: 'Medical allowance (garments)',
    value: '750',
    note: 'The garments minimum wage gazette (2023).',
  },
  {
    code: 'BD_RMG_TRANSPORT',
    name: 'Transport allowance (garments)',
    value: '450',
    note: 'The garments minimum wage gazette (2023).',
  },
  {
    code: 'BD_RMG_FOOD',
    name: 'Food allowance (garments)',
    value: '1250',
    note: 'The garments minimum wage gazette (2023).',
  },
  {
    code: 'BD_OT_DIVISOR',
    name: 'Hours in a month for the hourly basic',
    value: '208',
    note: 'Overtime at the shift’s rate (twice, Labour Act s.108) of the basic ÷ 208 an hour.',
  },
  {
    code: 'BD_FESTIVAL_SERVICE_MONTHS',
    name: 'Service before festival bonuses (months)',
    value: '12',
    note: 'Two festival bonuses a year after a year of continuous service, each up to the basic.',
  },
  {
    code: 'BD_PF_EMPLOYEE_PCT',
    name: 'Provident fund, employee, % of the basic',
    value: '10',
    note: POLICY,
  },
  {
    code: 'BD_PF_EMPLOYER_PCT',
    name: 'Provident fund, employer, % of the basic',
    value: '10',
    note: POLICY,
  },
  {
    code: 'BD_TAX_EXEMPT_CAP',
    name: 'Salary exempt from tax: at most (a year)',
    value: '450000',
    note: `The lower of a third of the salary income and this. ${VERIFY}`,
  },
  {
    code: 'BD_REBATE_PCT_TAXABLE',
    name: 'Investment rebate: at most this % of the taxable income',
    value: '3',
    note: VERIFY,
  },
  {
    code: 'BD_REBATE_PCT_INVEST',
    name: 'Investment rebate: at most this % of the eligible investment',
    value: '15',
    note: VERIFY,
  },
  { code: 'BD_REBATE_CAP', name: 'Investment rebate: at most', value: '1000000', note: VERIFY },
  {
    code: 'BD_MIN_TAX',
    name: 'Minimum tax when taxable',
    value: '5000',
    note: `Dhaka and Chattogram city corporations; lower elsewhere. ${VERIFY}`,
  },
];

export interface SlabData {
  readonly code: string;
  readonly name: string;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly note: string;
  readonly bands: readonly { readonly upTo: string | null; readonly rate: string }[];
}

export const SLABS: readonly SlabData[] = [
  {
    code: 'BD_TAX',
    name: 'Income tax, individuals — income year 2025–26',
    dateFrom: '2025-07-01',
    dateTo: '2026-06-30',
    note: `Tax-free 3,50,000; then 5%, 10%, 15%, 20%, 25% and 30%. ${VERIFY}`,
    bands: [
      { upTo: '350000', rate: '0' },
      { upTo: '450000', rate: '5' },
      { upTo: '850000', rate: '10' },
      { upTo: '1350000', rate: '15' },
      { upTo: '1850000', rate: '20' },
      { upTo: '3850000', rate: '25' },
      { upTo: null, rate: '30' },
    ],
  },
  {
    code: 'BD_TAX',
    name: 'Income tax, individuals — income years 2026–27 and 2027–28',
    dateFrom: '2026-07-01',
    dateTo: '2028-06-30',
    note: `Tax-free 3,75,000, the 5% band gone; then 10%, 15%, 20%, 25% and 30%. ${VERIFY}`,
    bands: [
      { upTo: '375000', rate: '0' },
      { upTo: '675000', rate: '10' },
      { upTo: '1075000', rate: '15' },
      { upTo: '1575000', rate: '20' },
      { upTo: '3575000', rate: '25' },
      { upTo: null, rate: '30' },
    ],
  },
];

export interface RuleData {
  readonly sequence: number;
  readonly code: string;
  readonly name: string;
  readonly category: 'basic' | 'allowance' | 'deduction' | 'contribution' | 'info';
  readonly formula: string;
  readonly condition?: string;
  readonly appearsOnSlip?: boolean;
  readonly note?: string;
}

const PRORATA = 'CONTRACT_DAYS / PERIOD_DAYS';

/** What both structures share after the pay itself: overtime, the festival bonus, deductions and income tax. */
const COMMON: readonly RuleData[] = [
  {
    sequence: 50,
    code: 'OVERTIME',
    name: 'Overtime',
    category: 'allowance',
    formula: 'BASIC / P_BD_OT_DIVISOR * OVERTIME_RATE * OVERTIME_HOURS',
    condition: 'OVERTIME_HOURS > 0',
    note: 'Approved overtime at the shift’s rate of the hourly basic.',
  },
  {
    sequence: 55,
    code: 'FESTIVAL_BONUS',
    name: 'Festival bonus',
    category: 'allowance',
    formula: 'BASIC',
    condition: 'FESTIVAL and SERVICE_MONTHS >= P_BD_FESTIVAL_SERVICE_MONTHS',
    note: 'In a run marked as a festival bonus run, after the qualifying service.',
  },
  {
    sequence: 60,
    code: 'ABSENCE',
    name: 'Absence',
    category: 'deduction',
    formula: 'BASIC / 30 * ABSENT_DAYS',
    condition: 'ABSENT_DAYS > 0',
  },
  {
    sequence: 65,
    code: 'PF_EMPLOYEE',
    name: 'Provident fund (own share)',
    category: 'deduction',
    formula: 'BASIC * P_BD_PF_EMPLOYEE_PCT / 100',
    condition: 'E_PF_MEMBER > 0',
    note: 'For members: a per-person value PF_MEMBER = 1.',
  },
  {
    sequence: 66,
    code: 'PF_EMPLOYER',
    name: 'Provident fund (company’s share)',
    category: 'contribution',
    formula: 'BASIC * P_BD_PF_EMPLOYER_PCT / 100',
    condition: 'E_PF_MEMBER > 0',
  },
  {
    sequence: 70,
    code: 'LOAN',
    name: 'Loan instalment',
    category: 'deduction',
    formula: 'LOAN',
    condition: 'LOAN > 0',
  },
  // Income tax deducted at source: the year's tax on the salary projected over the fiscal year, less what was
  // already deducted, spread over the months left. Irregular pay (overtime, festival bonuses) is taxed when paid.
  {
    sequence: 80,
    code: 'TAXABLE_PAY',
    name: 'Taxable pay this month',
    category: 'info',
    formula: 'GROSS',
    appearsOnSlip: false,
  },
  {
    sequence: 81,
    code: 'REGULAR_PAY',
    name: 'Regular pay (projected forward)',
    category: 'info',
    formula: 'GROSS - OVERTIME - FESTIVAL_BONUS',
    appearsOnSlip: false,
  },
  {
    sequence: 82,
    code: 'ANNUAL_INCOME',
    name: 'Salary income for the year (projected)',
    category: 'info',
    formula: 'YTD_TAXABLE_PAY + TAXABLE_PAY + REGULAR_PAY * (MONTHS_LEFT - 1)',
    appearsOnSlip: false,
  },
  {
    sequence: 83,
    code: 'TAX_EXEMPT',
    name: 'Exempt salary',
    category: 'info',
    formula: 'min(ANNUAL_INCOME / 3, P_BD_TAX_EXEMPT_CAP)',
    appearsOnSlip: false,
  },
  {
    sequence: 84,
    code: 'TAXABLE_INCOME',
    name: 'Taxable income for the year',
    category: 'info',
    formula: 'max(0, ANNUAL_INCOME - TAX_EXEMPT)',
    appearsOnSlip: false,
  },
  {
    sequence: 85,
    code: 'TAX_GROSS',
    name: 'Tax on it',
    category: 'info',
    formula: "slab('BD_TAX', TAXABLE_INCOME)",
    appearsOnSlip: false,
  },
  {
    sequence: 86,
    code: 'TAX_REBATE',
    name: 'Investment rebate',
    category: 'info',
    formula:
      'min(TAXABLE_INCOME * P_BD_REBATE_PCT_TAXABLE / 100, E_INVESTMENT * P_BD_REBATE_PCT_INVEST / 100, P_BD_REBATE_CAP)',
    appearsOnSlip: false,
    note: 'The year’s eligible investment: a per-person value INVESTMENT.',
  },
  {
    sequence: 87,
    code: 'TAX_YEAR',
    name: 'Tax for the year',
    category: 'info',
    formula: 'if(TAX_GROSS > 0, max(TAX_GROSS - TAX_REBATE, P_BD_MIN_TAX), 0)',
    appearsOnSlip: false,
  },
  {
    sequence: 90,
    code: 'TDS',
    name: 'Income tax (deducted at source)',
    category: 'deduction',
    formula: 'max(0, round((TAX_YEAR - YTD_TDS) / MONTHS_LEFT, 0))',
    condition: 'TAX_YEAR > 0 or YTD_TDS > 0',
  },
];

export interface StructureData {
  readonly name: string;
  readonly note: string;
  readonly rules: readonly RuleData[];
}

export const STRUCTURES: readonly StructureData[] = [
  {
    name: 'Bangladesh — standard',
    note: 'The gross split into basic, house rent, medical and conveyance; overtime, festival bonuses, provident fund and income tax at source.',
    rules: [
      {
        sequence: 10,
        code: 'BASIC',
        name: 'Basic',
        category: 'basic',
        formula: `WAGE * P_BD_BASIC_PCT / 100 * ${PRORATA}`,
      },
      {
        sequence: 20,
        code: 'HOUSE_RENT',
        name: 'House rent',
        category: 'allowance',
        formula: 'BASIC * P_BD_HOUSE_RENT_PCT / 100',
      },
      {
        sequence: 30,
        code: 'MEDICAL',
        name: 'Medical',
        category: 'allowance',
        formula: 'BASIC * P_BD_MEDICAL_PCT / 100',
      },
      {
        sequence: 40,
        code: 'CONVEYANCE',
        name: 'Conveyance',
        category: 'allowance',
        formula: `max(0, WAGE * ${PRORATA} - BASIC - HOUSE_RENT - MEDICAL)`,
      },
      ...COMMON,
    ],
  },
  {
    name: 'Bangladesh — garments (RMG)',
    note: 'The garments minimum wage structure: the gross less the fixed medical, transport and food allowances is the basic and its house rent.',
    rules: [
      {
        sequence: 10,
        code: 'BASIC',
        name: 'Basic',
        category: 'basic',
        formula: `(WAGE - P_BD_RMG_MEDICAL - P_BD_RMG_TRANSPORT - P_BD_RMG_FOOD) / (1 + P_BD_RMG_HOUSE_RENT_PCT / 100) * ${PRORATA}`,
      },
      {
        sequence: 20,
        code: 'HOUSE_RENT',
        name: 'House rent',
        category: 'allowance',
        formula: 'BASIC * P_BD_RMG_HOUSE_RENT_PCT / 100',
      },
      {
        sequence: 30,
        code: 'MEDICAL',
        name: 'Medical',
        category: 'allowance',
        formula: `P_BD_RMG_MEDICAL * ${PRORATA}`,
      },
      {
        sequence: 40,
        code: 'CONVEYANCE',
        name: 'Transport',
        category: 'allowance',
        formula: `P_BD_RMG_TRANSPORT * ${PRORATA}`,
      },
      {
        sequence: 45,
        code: 'FOOD',
        name: 'Food',
        category: 'allowance',
        formula: `P_BD_RMG_FOOD * ${PRORATA}`,
      },
      ...COMMON,
    ],
  },
];
