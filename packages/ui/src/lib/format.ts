/**
 * Locale-aware formatting (RFC 0007 i18n): numbers, exact decimals (strings, never floats), dates and datetimes from
 * the user's language and time zone, through `Intl`. Bangla can use Bengali digits (`bn` with `nu-beng`).
 */

/** Kosh language codes (`bn_BD`) → BCP 47 (`bn-BD`). */
export function bcp47(lang: string): string {
  return lang.replace('_', '-');
}

export interface Formatter {
  readonly locale: string;
  number(value: number | null | undefined): string;
  /** An exact decimal string (`'750000.00'`), grouped per locale without float rounding. */
  decimal(value: string | null | undefined, scale?: number): string;
  date(value: string | null | undefined): string;
  datetime(value: string | null | undefined): string;
}

export function createFormatter(
  lang: string,
  tz: string,
  options: {
    readonly nativeDigits?: boolean;
    /** `lakh`: 12,34,567 (RFC 0016). Bangla groups so already; English takes the Indian English pattern. */
    readonly grouping?: 'international' | 'lakh';
  } = {},
): Formatter {
  const base = bcp47(lang);
  // Bangla defaults to Bengali digits in ICU; RFC 0007 makes them a choice (Latin digits unless asked).
  const locale = base.startsWith('bn')
    ? `${base}-u-nu-${options.nativeDigits === true ? 'beng' : 'latn'}`
    : options.grouping === 'lakh' && base.startsWith('en')
      ? 'en-IN'
      : base;
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const digits = new Intl.NumberFormat(locale, { useGrouping: false });
  const separator =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ??
    '.';
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const datetime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
  });
  return {
    locale,
    number: (value) =>
      value === null || value === undefined ? '' : new Intl.NumberFormat(locale).format(value),
    decimal(value, scale) {
      if (value === null || value === undefined || value === '') return '';
      const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
      if (match === null) return value;
      const [, sign, whole = '0', frac = ''] = match;
      const fraction =
        scale === undefined ? frac.replace(/0+$/, '') : frac.padEnd(scale, '0').slice(0, scale);
      const head = integer.format(BigInt(whole));
      const tail =
        fraction === ''
          ? ''
          : `${separator}${[...fraction].map((d) => digits.format(Number(d))).join('')}`;
      return `${sign === '-' ? '-' : ''}${head}${tail}`;
    },
    date: (value) =>
      value === null || value === undefined || value === ''
        ? ''
        : date.format(new Date(`${value.slice(0, 10)}T00:00:00Z`)),
    datetime: (value) =>
      value === null || value === undefined || value === '' ? '' : datetime.format(new Date(value)),
  };
}
