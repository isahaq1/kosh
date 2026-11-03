/**
 * Depreciation boards (RFC 0024 §2.5), without a database: the planned month-end amounts of an asset from its value,
 * salvage value, method and life. Exact in Decimals; the last line takes the rounding so the board ends at the
 * salvage value.
 *
 * - **Straight line**: the depreciable amount over the life in months; with prorata the first month counts only the
 *   days from the date of use, and one more month at the end takes the rest.
 * - **Declining balance**: the annual rate on what remains, a twelfth a month — switching to straight line over the
 *   months left as soon as that is more, so the asset reaches its salvage value at the end of its life.
 * - **Units of production**: no plan ahead; each month's usage at the depreciable amount per unit (`unitsLine`).
 */
import { type Decimal, orm } from '@kosh/server/orm';

const ZERO: Decimal = orm.toDecimal(0);

export interface BoardInput {
  /** What remains to depreciate from, at `from` (the cost, or the book value after a revaluation). */
  readonly bookValue: Decimal;
  readonly salvage: Decimal;
  readonly method: 'linear' | 'degressive' | 'units';
  /** Months left in the asset's life from `from`. */
  readonly months: number;
  /** Declining balance: the yearly rate in percent. */
  readonly rate: Decimal;
  /** The date depreciation starts (`YYYY-MM-DD`): the date of use, or the day after the last posted month. */
  readonly from: string;
  /** The first month only from the date (`true`), or in full. */
  readonly prorata: boolean;
}

export interface BoardLine {
  /** The month's last day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly amount: Decimal;
  /** Depreciated so far on this board, this line included. */
  readonly accumulated: Decimal;
  /** The book value after this line. */
  readonly remaining: Decimal;
}

const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const money = (d: Decimal) => d.toDecimalPlaces(2);

/** The planned lines of a board. Units of production plans nothing ahead. */
export function board(input: BoardInput): BoardLine[] {
  if (input.method === 'units' || input.months <= 0) return [];
  const [y0, m0, d0] = input.from.split('-').map(Number) as [number, number, number];
  const daysInFirst = new Date(Date.UTC(y0, m0, 0)).getUTCDate();
  const firstShare = input.prorata
    ? orm.toDecimal(daysInFirst - d0 + 1).div(daysInFirst)
    : orm.toDecimal(1);
  const partial = input.prorata && d0 > 1;
  const depreciable = input.bookValue.minus(input.salvage);
  if (depreciable.lte(0)) return [];
  const count = input.months + (partial ? 1 : 0);
  const lines: BoardLine[] = [];
  let accumulated = ZERO;
  for (let i = 0; i < count; i += 1) {
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    const m = ((m0 - 1 + i) % 12) + 1;
    const left = depreciable.minus(accumulated);
    if (left.lte(0)) break;
    let amount: Decimal;
    if (i === count - 1) amount = left;
    else if (input.method === 'linear') {
      const monthly = depreciable.div(input.months);
      amount = money(i === 0 ? monthly.times(firstShare) : monthly);
    } else {
      const declining = input.bookValue.minus(accumulated).times(input.rate).div(1200);
      const straight = left.div(count - i);
      const base = declining.gt(straight) ? declining : straight;
      amount = money(i === 0 ? base.times(firstShare) : base);
    }
    if (amount.gt(left)) amount = left;
    accumulated = accumulated.plus(amount);
    lines.push({
      date: monthEnd(y, m),
      amount,
      accumulated,
      remaining: input.bookValue.minus(accumulated),
    });
  }
  return lines;
}

/** Units of production: the month's depreciation for `units` used, never past the salvage value. */
export function unitsLine(input: {
  readonly cost: Decimal;
  readonly salvage: Decimal;
  readonly totalUnits: Decimal;
  readonly units: Decimal;
  readonly depreciated: Decimal;
}): Decimal {
  if (input.totalUnits.lte(0)) return ZERO;
  const depreciable = input.cost.minus(input.salvage);
  const left = depreciable.minus(input.depreciated);
  const amount = money(depreciable.div(input.totalUnits).times(input.units));
  return amount.gt(left) ? (left.gt(0) ? left : ZERO) : amount;
}

/**
 * A tax book (reducing balance at a yearly rate, a full year in the year of acquisition — as Bangladesh's Third
 * Schedule reads; verify for the year): the written-down value at the start of each income year, its depreciation,
 * and the value at its end, from the year of acquisition to `throughYear` (each year by its start, `YYYY`).
 */
export function taxBook(input: {
  readonly cost: Decimal;
  readonly rate: Decimal;
  readonly acquiredYear: number;
  readonly throughYear: number;
}): { year: number; opening: Decimal; depreciation: Decimal; closing: Decimal }[] {
  const out = [];
  let wdv = input.cost;
  for (let year = input.acquiredYear; year <= input.throughYear; year += 1) {
    const depreciation = money(wdv.times(input.rate).div(100));
    out.push({ year, opening: wdv, depreciation, closing: wdv.minus(depreciation) });
    wdv = wdv.minus(depreciation);
  }
  return out;
}
