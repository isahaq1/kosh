# RFC 0039 — Time and pay for a large workforce

Status: **proposed 2026-11-25** (asked by the owner: "could be manage more than 30000 employees payroll", "should
to have attendance, leave, tour, home office, shift, roaster and others necessary for complex payroll"). Step 1 is
being built; the order of the rest is his to change.

## 1. Where it stands

Measured, not assumed — `apps/demo/bench/payroll.bench.test.ts` (`pnpm bench payroll`), PostgreSQL 18, a month of
attendance days per person, the standard structure:

| People in the run | Time | Per person |
| --- | --- | --- |
| 100 | 1.1 s | 11.3 ms |
| 400 | 4.3 s | 10.8 ms |
| 7 500 | 291 s | 38.8 ms — it grows with the size |
| 30 000 | not finished after 30 minutes, in one transaction | — |

How a run is computed today (`modules/payroll/src/compute.ts`): inside the web request that presses *Compute*, in
one transaction, one person after the other, with about eight queries each (their own values, attendance days,
inputs, loans, the year so far, the structure's rules — read again for every person —, the payslip and its lines).
Nothing was ever tested beyond a handful of people.

What exists for a complex payroll: shifts (night shifts too), rosters, geofenced and kiosk check-ins, device push,
lateness and overtime in steps approved before Payroll reads them, leave with types, balances, accruals, carry-over
and payouts, official tours, working calendars with holidays, rules as formulas with slabs, loans, inputs,
per-person values, the festival flag, the year to date, corrections, bank and wallet files, Bangladesh structures.

What does not (searched for, absent): home office; half days; paid and unpaid leave told apart; and, for the rules,
the night shifts worked, the hours worked, the minutes late, leaving early, days worked on a weekend or a
holiday; shift swaps; compensatory leave; the final settlement of somebody who leaves.

## 2. Step 1 — a run of 30 000 people

- **In the background, in batches.** *Compute* enqueues a job; the job computes 500 people per transaction and
  records its progress on the run (`computedCount` of `toCompute`), so the page shows a bar, a server restart
  resumes where it stopped, and a failure names the person and the rule and leaves the batches done.
  A run of up to 200 people is still computed at once, as today.
- **Read in sets, not per person.** Per batch: one query each for the people's values, attendance (aggregated by
  PostgreSQL: counts by status, sums of overtime, late minutes), inputs, loans and the year so far; the
  parameters, the slabs and each structure's rules once per run.
- **Totals by the database.** A run's count, gross and net are sums PostgreSQL makes once at the end of a batch,
  not a recomputation that reads every payslip of the run each time one is added.
- **Payslips out of the activity log's bulk.** A payslip's lines are derived values (each with its explanation);
  the payslip records its creation and its approval, its lines do not log one row each.
- **Approve and pay in the same way**: the loan repayments, the accounting entry (`payroll_account`) and the
  payment files work on a run of any size; the files are streamed.
- **Budget, in CI's benchmark**: 30 000 people computed in under 10 minutes on the benchmark machine, the server
  answering other requests meanwhile, memory flat.

## 3. Step 2 — home office

- `hr.remote` (*Home office*): a request for a day or a range, with the reason, decided by the leave approver, the
  manager or HR and never by the person; a weekly pattern on the employee (works from home on given weekdays)
  for those who have one. No overlap with approved leave or a tour.
- Attendance: a `remote` day status. A person on an approved home-office day checks in from anywhere (the
  geofence is not asked of them) and the day counts as present; without a check-in the company chooses, in App
  settings, whether it is still present or absent.
- Payroll: `REMOTE_DAYS`, so an allowance or a deduction is a rule.

## 4. Step 3 — what complex pay rules need to read

- **Half days**: leave of half a day (morning or afternoon), and a `half` day in Attendance from a rule in App
  settings (worked less than a share of the shift). `HALF_DAYS`; leave days count 0.5.
- **Paid and unpaid leave apart**: `PAID_LEAVE_DAYS`, `UNPAID_LEAVE_DAYS` (a leave type says which), and
  `LEAVE_<CODE>` per type.
- **From the shifts**: `NIGHT_SHIFTS`, `SHIFT_<CODE>` days by shift, `WORKED_HOURS`, `EXPECTED_HOURS`,
  `LATE_MINUTES`, `EARLY_MINUTES`, `WEEKEND_WORKED`, `HOLIDAY_WORKED`.
- Every variable is listed with its meaning where a rule is written (the formula check already names them).

## 5. Step 4 — swaps, compensatory leave, final settlement

- **Shift swaps**: two people ask to exchange a day's shifts; their supervisors approve; the roster changes once.
- **Compensatory leave**: a day worked on a weekend or a holiday, approved, credits leave through the accrual
  ledger (`hr_accrual`), with an expiry.
- **Final settlement**: for a contract that ends — the days of the last month, leave paid out, the notice,
  gratuity by a formula, loans recovered — as a run of one person with a statement.

## 6. Measurements

`pnpm bench payroll` with `KOSH_BENCH_EMPLOYEES=30000`, 26 attendance days a person and month, PostgreSQL 18 in a
container on the development machine (2026-11-25):

| People in the run | Before | After step 1 |
| --- | --- | --- |
| 7 500 | 291 s (38.8 ms a person) | 4.8 s (0.6 ms a person), 15 batches |
| 30 000 | not finished after 30 minutes | 20.5 s (0.7 ms a person), 60 batches |

*Compute* answers in under 0.1 s (the job does the work). The time a person no longer grows with the size.

## Implementation notes (2026-11-25): step 1 — a run of 30 000 people

- **What made it slow**, in the order found: the run's `gross`, `net` and count were stored computes on
  `slips.gross` — every payslip added read all the run's payslips again; eight queries a person; and, once
  batched, a month of attendance days a person turned into full records (13 000 a batch: 17 s of the 17 s).
- **As built** (`modules/payroll/src/compute.ts`): `startRun` removes the run's payslips and counts its people;
  `computeBatch` computes the next 500 after the run's cursor — contracts, the people's values, inputs, loans and
  the year so far each in one query, **attendance summed by PostgreSQL** to one row a person, each structure's
  rules once —, creates the batch's payslips in one go and moves the cursor; `refreshTotals` writes the run's
  count, gross and net as sums the database makes. `computeStep` is one batch as the job does it.
- **The job** (`payroll.compute`, `payrollWorker`): a batch per job, each enqueuing the next, so every batch
  commits: the run shows `computedCount` of `toCompute`, a restart goes on from the cursor, other requests are
  served meanwhile. `computeRound` makes a batch left over from an earlier computation do nothing. A run of up to
  200 people is still computed in the request.
- **Rules**: a run is not approved, nor computed a second time, while its job is at it; a formula that fails
  stops the run with the person and the rule in `computeError` — the batches done stay — until it is computed
  again; what the server keeps (the figures, the progress) cannot be typed in.
- **The activity log** leaves out payslip lines (`audit-scope.ts`): derived, each with its explanation, half a
  million rows a large run.
- Tests: a run of 232 people in batches of 100 through the worker — the progress, approval refused meanwhile,
  one payslip a person, the figures equal to the payslips' sums, a failing formula named and fixed, the server's
  fields refused; the benchmark holds two budgets (the time a person does not double with the size; 30 000
  people under ten minutes).
- **Left for step 1b**: the run's form still lists its payslips as lines — fine for hundreds, too many for
  thousands (the *Payslips* tile opens the paged list instead; the lines should go for large runs); the payment
  files are built in memory; `payroll_account`'s entry for a very large run is not measured; approving a large
  run records loan repayments person by person.
- Shutro request #42 (a savepoint rolled back, then a write) was met and avoided here.

## 7. Open questions

1. Home office without a check-in: present or absent by default?
2. Is a run per company enough, or are runs per unit / department / pay group needed (30 000 people are rarely
   paid in one run)? Step 1 does not depend on the answer; pay groups would be a small addition.
