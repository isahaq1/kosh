# Working time

One place says when the company works: the **Working time** app. Every app that counts time — leave, support
deadlines, attendance, production capacity, due dates in working days — is meant to count with it. (Part 1 ships the
app and its engine; the apps move onto it one by one, see the roadmap.)

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
