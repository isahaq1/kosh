/**
 * What a company starts with (RFC 0034 §2.4): its calendar — Sunday to Thursday, 09:00–13:00 and 14:00–18:00, the
 * week of Bangladesh; a company changes it on screen — and the **fixed-date public holidays** of the calendar's
 * country, every year. Holidays that move with the moon or a government notice (the Eids, Durga Puja, Diwali, Holi,
 * Shab-e-Barat…) are not guessed: a manager adds them when they are announced, or imports the year's list.
 * Idempotent: a calendar and a holiday that exist are left as they are.
 */
import type { Env } from './.kosh/bindings.js';

/** Fixed-date public holidays by country: `[month, day, name]`. */
export const FIXED_HOLIDAYS: Readonly<
  Record<string, readonly (readonly [number, number, string])[]>
> = {
  bd: [
    [2, 21, 'Language Martyrs’ Day'],
    [3, 26, 'Independence Day'],
    [4, 14, 'Bengali New Year'],
    [5, 1, 'May Day'],
    [12, 16, 'Victory Day'],
    [12, 25, 'Christmas Day'],
  ],
  in: [
    [1, 26, 'Republic Day'],
    [8, 15, 'Independence Day'],
    [10, 2, 'Gandhi Jayanti'],
  ],
};
/** The country a company most likely keeps its holidays of, from its currency. */
const COUNTRY_OF_CURRENCY: Readonly<Record<string, 'bd' | 'in'>> = { BDT: 'bd', INR: 'in' };
const STANDARD_HOURS = [
  ['09:00', '13:00'],
  ['14:00', '18:00'],
] as const;

/** The fixed holidays of a calendar's country, as yearly holidays of that calendar; returns how many were added. */
export async function addFixedHolidays(env: Env, calendar: number): Promise<number> {
  const [found] = [
    ...(await env.model('work.calendar').search({ where: { id: calendar as never }, limit: 1 })),
  ];
  const fixed = found?.country == null ? undefined : FIXED_HOLIDAYS[found.country];
  if (found === undefined || fixed === undefined) return 0;
  const existing = new Set(
    [
      ...(await env
        .model('work.holiday')
        .search({ where: { calendar: calendar as never, yearly: true } })),
    ].map((h) => String(h.dateFrom).slice(5, 10)),
  );
  // A leap year, so that every date exists; the year itself does not matter for a yearly holiday.
  const rows = fixed
    .map(([month, day, name]) => ({
      monthDay: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      name,
    }))
    .filter((h) => !existing.has(h.monthDay))
    .map((h) => ({
      name: h.name,
      dateFrom: `2024-${h.monthDay}`,
      dateTo: `2024-${h.monthDay}`,
      yearly: true,
      calendar: calendar as never,
      company: found.company.id,
    }));
  if (rows.length > 0) await env.model('work.holiday').create(rows);
  return rows.length;
}

export async function installWorkingTime(env: Env): Promise<string | undefined> {
  const company = Number(env.companyId);
  if (!Number.isSafeInteger(company) || company <= 0) return undefined;
  const [row] = [
    ...(await (
      await env.model('res.company').search({ where: { id: company as never }, limit: 1 })
    ).load({ currency: true })),
  ];
  if (row === undefined) return undefined;
  let made = 0;
  const mine = await env.model('work.calendar').search({ where: { company: company as never } });
  if (mine.length === 0) {
    const country = COUNTRY_OF_CURRENCY[String(row.currency.name)] ?? null;
    await env.model('work.calendar').create([
      {
        name: 'Standard week',
        company: company as never,
        isDefault: true,
        country,
        tz: country === 'in' ? 'Asia/Kolkata' : 'Asia/Dhaka',
        hours: {
          create: (['sun', 'mon', 'tue', 'wed', 'thu'] as const).flatMap((weekday) =>
            STANDARD_HOURS.map(([fromTime, toTime]) => ({ weekday, fromTime, toTime })),
          ),
        },
      },
    ]);
    made = 1;
  }
  let holidays = 0;
  for (const id of (
    await env.model('work.calendar').search({ where: { company: company as never } })
  ).ids)
    holidays += await addFixedHolidays(env, id);
  return made === 0 && holidays === 0
    ? undefined
    : `${made} working calendar, ${holidays} public holidays installed`;
}
