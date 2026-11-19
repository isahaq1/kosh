# Working time

One place says when the company works: the **Working time** app. Every app that counts time — leave, support
deadlines, attendance, production capacity, due dates in working days — is meant to count with it. (The apps move onto it one by one:
see *Who counts with it* below.)

## What you set up

- **Calendars** (Working time › Calendars). A calendar has a time zone, the hours a full day is worth, and its week:
  one line per stretch of work. Two lines for a day make a break between them — `09:00–13:00` and `14:00–18:00` is
  an eight-hour day with lunch. A day without a line is not worked. One calendar is **the company's**: it is used
  wherever no other is chosen. A factory on six days, a night shift or a branch abroad gets a calendar of its own.
- **Holidays** (Working time › Holidays). A date or a span. *Every year* repeats it on the same dates (Victory
  Day); leave it off for a holiday that moves. A holiday belongs to every calendar of the company, or to one
  calendar only (a factory's shutdown).
- **Personal exceptions** (Working time › Personal exceptions). A day one person does not work, or a day they work
  at hours of their own — also on a weekend or a holiday (a stock count on a Saturday).

A new company starts with a calendar — Sunday to Thursday, 09:00–13:00 and 14:00–18:00 — and the **fixed-date public
holidays of its country**, yearly:

| Bangladesh | India |
| --- | --- |
| 21 February, Language Martyrs' Day | 26 January, Republic Day |
| 26 March, Independence Day | 15 August, Independence Day |
| 14 April, Bengali New Year | 2 October, Gandhi Jayanti |
| 1 May, May Day | |
| 16 December, Victory Day | |
| 25 December, Christmas Day | |

**The holidays that move are not shipped**: the Eids, Durga Puja, Diwali, Holi and the others follow the moon or a
government notice, and a guessed date would be wrong on someone's payslip. Add them when they are announced, or
import the year's list (Holidays › Import, with the template). Check the fixed list against your own practice too:
remove or add what your company observes.

Managers (the *Working time manager* role) set all this; everyone with the app reads it.

## Who counts with it

- **Leave (Workforce).** An employee has a *Working calendar* (Employee › Schedule; empty: the company's). A leave
  takes the working days of that calendar between its dates: holidays are not charged, nor a day the person does
  not work anyway. The form counts as the dates are typed and the server checks it when the leave is saved. HR
  managers set calendars, holidays and exceptions. (The old *Working week* setting of Workforce is gone: set the
  week on the company's calendar.)
- **Attendance.** A person's day is read from their working calendar: a day its week does not work is the
  weekend, a public holiday or the person's own day off is a holiday, a worked Saturday (a personal exception with
  hours) is an ordinary day. Holidays are entered here only — Attendance › Configuration › Public holidays opens
  this list.
- **Helpdesk.** A team may have a *Working calendar* (Team › Business hours): its SLA targets then count that
  calendar's hours, without its breaks and holidays. Left empty, the team keeps its own opening hours and weekend
  — right for a desk that works other hours than the office.
- **Production.** A work centre may have a *Working calendar*: its work orders are scheduled inside the calendar's
  hours, around breaks, weekends and holidays, and *Capacity* shows each day's capacity hours (none on a day off).
  Left empty, the centre works every day from 08:00 for its *Hours a day*, as before.
- **Accounting.** A payment term's *Days are*: *Calendar days* (the default); *Calendar days, never due on a day
  off* — a due date on a weekend or a holiday moves to the next working day —; or *Working days*, counted on the
  company's calendar. "10 working days" from Thursday 10 December 2026 is Sunday the 27th when the 16th is a
  holiday.
- Not yet: delivery and arrival dates of Sales and Purchase (their lead days are calendar days).

## For module authors

```ts
import { addWorkingDays, scheduleOf, workingDays, workingMinutesBetween } from '@kosh/worktime';

// The company's calendar, its holidays, and this person's exceptions, between two dates.
const schedule = await scheduleOf(env, { from: '2026-12-01', to: '2026-12-31', user: userId });

workingDays(schedule, '2026-12-13', '2026-12-17');       // 4: Victory Day is not counted
addWorkingDays(schedule, '2026-12-15', 1);                // '2026-12-17'
workingMinutesBetween(schedule, openedAt, new Date());    // minutes inside working hours only
```

`scheduleOf` reads as the system: counting time needs no right of its own. Pass `calendar` for a calendar other
than the company's. The engine's functions are pure — `isWorkingDay`, `hoursOn`, `minutesOn`, `workingDates`,
`addWorkingDays` (forward and back), `workingDaysOfMonth`, `workingMinutesBetween`, `addWorkingMinutes`,
`nextWorkingMoment` — and work in the calendar's time zone, daylight saving included. Ask for a span that covers
every date you will count: a schedule knows the holidays of its span only.
