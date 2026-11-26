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

## 5b. Step 5 — the rest at this size

- **Indexes on parent links**: every line model's link to its parent checked (a script over the registry: a
  required many2one with `ondelete: 'cascade'` and no index), and indexed where the table grows with the business.
- **Attendance's days** computed in sets, like the payroll batch: 30 000 people a day.
- **Accounting's entries** for a large run (`payroll_account`) summed by the database.

### Implementation notes (2026-11-26): indexes on parent links

- **Found**: 159 links on 149 models — a many2one that is required and deleted with its target, the way a
  line belongs to its document — had no index: sales and purchase order lines, journal lines, statement lines,
  budget lines, contracts and leave by employee, and so on (`pnpm index:report` lists them).
- **As built**: the server indexes them itself. `buildKoshRegistry` adds a Shutro module, `kosh_parent_indexes`,
  whose extensions set `index: true` on every such field that does not already lead an index or a unique
  constraint (`parentLinksWithoutIndex`). A module need not remember; a new line model is covered the day it is
  written. A model that wants another index still declares it.
- Tests: on a fresh installation of every app, the database has the index on order lines, journal lines,
  payslip lines, contracts and leave; `pnpm index:report` fails if one is left without.
- **For an existing installation** the indexes come with its next migration (`shutro-erp migrate`): creating
  them on large tables takes time and is best done in a quiet hour. This path was not rehearsed here on a
  database with data.
- **Not covered**: links that are not a line's parent but are searched by all the same (an order's customer, a
  move's product); those stay each model's to declare, and want measuring on real volumes.

### Implementation notes (2026-11-26): accuracy — the proof of a run

Asked: "payroll should be calculate accuratly with a shortime".

- **What accuracy rests on.** Amounts are exact decimals from the formula to the database (`Decimal`, never a JS
  number); each line is rounded once, to two places, and keeps the formula with its values; a payslip's gross,
  deductions and net are sums of its lines. Counts of days and halves of days are whole numbers and halves, exact.
- **The same result whatever the batch.** A month computed in batches of 100, of 37 and of 3 gives the same
  payslips line for line — who, which rule, how much, and the explanation — compared as one fingerprint.
- **The proof** (`checkRun`, `GET /api/v1/payroll/runs/:id/check`), worked out by PostgreSQL over **every**
  payslip of the run: everybody the run pays has a payslip and nobody else; one each; every payslip is the sum
  of its lines (gross, deductions, the company's contributions, and net = gross − deductions); the run's count,
  gross and net are its payslips'. Each check says what was expected and what was found, naming payslips.
- **Approval asks for it.** A run that does not add up is not approved: it says why and is computed again. A
  payslip changed by a taka behind the engine's back, or a payslip missing, stops it (tested).
- **Measured at 30 000**: the proof 0.25 s; approval, which includes it, 0.28 s. The benchmark also checks,
  from the contracts and independently of the engine, that every one of the 30 000 gross amounts is the wage it
  should be — and fails if one is not.
- **What the proof does not say**: that the *rules* are right. A wrong formula computes wrong payslips that add
  up perfectly. For that: the explanation on every line, the comparison with the previous run (*With a warning*,
  the difference column), and a company's own test of its structure on known people before the first live run.

### Implementation notes (2026-11-26): the books of a large run

- `payroll_account` read every line of every payslip of a run — with its rule and its payslip — to add them
  up: 300 000 records for 30 000 people. The entry has a line per kind of pay and account, not per person: the
  sums are now PostgreSQL's (`GROUP BY` category, name and the rule's account), a correction's less the corrected
  run's; the payment is the sum of the payslips' net.
- One difference from before, in a corner: a correction used to pair each person's lines with the corrected
  run's by rule code; it now subtracts the corrected run's sums by category, name and account. The totals are
  the same; a rule renamed between the two runs gives two lines instead of one.
- **Measured at 30 000, Accounting installed**: approved, proved and booked in 0.5 s (an entry of 4 lines,
  balanced, its payable not less than the payslips' net); paid from the bank in 0.2 s. The whole cycle on that
  run: computed in 39 s (22 s on a quieter machine), proved 0.36 s, bank file 0.28 s.

### Implementation notes (2026-11-26): Attendance's days in sets, and every night

- **Measured before** (`pnpm bench attendance`): 2 000 people, one day 24.7 s, a week 41.6 s — eight queries a
  person and a write a day, in the request. Thirty thousand people would be over six minutes for one day.
- **Nothing computed a day by itself.** A person's day was computed when they punched, or when somebody called
  the API: someone who never came was never marked absent unless asked for.
- **As built**: `recomputeDays` works in chunks of 500 people — rosters, approved leave, tours and home office,
  punches and the days already there each read in one query and grouped by person; one working schedule per
  calendar and company, shared, and a schedule of their own only for the people with an exception in the
  period; a chunk's new days written in one go.
- **In the background**: more than 5 000 person-days in one request go to the job `attendance.days`, a job per
  500 people, and the answer says how many (`{ written, queued, people }`). **Every night**, for every company,
  yesterday's days of everybody are enqueued — once per company and date, whatever the number of servers and of
  ticks (the night's first job is looked for: a job's key stops a second one only while the first waits).
- **Measured after**, 30 000 people: one day **13.6 s** (the request answers in 0.5 s), a week — 150 000 days —
  **42.5 s**; 2 000 people, one day 1.3 s. The benchmark holds a day for everybody under a minute.
- Tests: a three-month request for sixty people computed by the jobs, a short one in the request, a
  non-manager refused; the night computing a Monday nobody punched on, once, and the next night again.
- **Left**: no screen asks for a recomputation (the API and the night do); days already there are still
  written one by one when recomputed.

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
- **The run's form** (done 2026-11-26): it no longer lists its payslips — a form asked for every payslip's id
  and then loaded them by listing the ids in one request, which cannot work for thousands. The run shows its
  figures and two tiles, *Payslips* and *With a warning*, that open the payslips as a list that pages, searches,
  filters and totals (gross, deductions, net).
- **Approving and paying, measured at 30 000** (2026-11-26): approving took **172 s** — against 55 ms for 7 500.
  The cause was not the code's shape but a **missing index**: a payslip line's link to its payslip had none, so
  finding the loan instalments made PostgreSQL scan every line for every payslip. With `index: true` on
  `payroll.slip.line.slip` (and on a payslip's `employee`, for the year so far): **74 ms**. Loan repayments are
  now found by one query for the payslips that took an instalment, not by reading every payslip; the payment
  file's rows are one query — the columns the file needs — instead of every payslip and every person turned into
  records: **0.2 s** for 30 000 rows. The benchmark holds both under five seconds.
- **A lesson beyond Payroll**: Shutro indexes a model's `company` and what is declared unique, **not its other
  many2one columns**. A line's link to its parent (`required`, `ondelete: 'cascade'`) is read and cascaded
  through constantly and needs `index: true`. The other apps' line models have not been checked — the next thing
  to do at this size (see step 5).
- **Left**: `payroll_account`'s entries for a very large run are not measured (they sum every payslip in
  memory); the run's print template lists every payslip; Attendance's daily computation is per person.
- Shutro request #42 (a savepoint rolled back, then a write) was met and avoided here.

## Implementation notes (2026-11-25): step 2 — home office

- **Workforce** (`hr.remote`, *Workforce › Home office*): a numbered request (`HO/2026/0001`) for a day or a
  range with its reason and its working days by the person's calendar; submitted by the person, **approved,
  refused or cancelled by their leave approver, their manager or HR — never by themselves** (the same rule as
  tours: `undecidable`, and the permission `hr.remote_decide`); refused or cancelled only with a reason; no overlap
  with another request, an approved tour or approved leave. A print template, an import template and the events
  `hr.remote.submitted` / `approved` / `cancelled`.
- **Attendance**: the day status **Home office** (`remote`). A working day inside an approved request is Home
  office with a check-in or without one — what the punches show (hours, lateness, overtime) is kept —; a weekend,
  a holiday and leave stay what they are; a forgotten check-out is still *Check-out missing*. On such a day the
  phone's check-in is **not held to the site's geofence**.
- **Payroll**: `REMOTE_DAYS`, and the day counts in `PRESENT_DAYS` like a day on tour, so an allowance or a
  deduction for days at home is a rule.
- Tests: the day's rule as a pure function; on PostgreSQL the request (not decided by its owner, overlap refused,
  not read by a colleague), its days, cancelling, the check-in far from the office refused then accepted on a
  home-office day; the pay rule reading it; E2E (asked by an employee, approved by HR).
- **Decided here, to confirm** (§7 question 1): a home-office day **without a check-in counts as present**. A
  company that wants proof of work asks for the check-in through its own rule (`REMOTE_DAYS` against punches) —
  or says so, and a setting is added.
- **Left out**: a weekly pattern on the employee (works from home every Thursday) — each stretch is a request
  for now; a limit of days a month.

## Implementation notes (2026-11-25): step 3, part 1 — contractual, temporary and daily people; the shifts in the rules

Asked: "employee can be contactual, temporary and other".

- **Employment types** (*Workforce › Configuration › Employment types*, a list a company adds to): shipped with
  Permanent, Contractual, Casual (daily), Intern and now **Temporary, Part-time, Seasonal, Outsourced**, each with
  a code. A contract names its type.
- **How the wage is counted**, on the contract: *Paid* **per month**, **per day worked** or **per hour worked**;
  the wage is then a month's, a day's or an hour's.
- **In the rules**: `PAID_BY_DAY`, `PAID_BY_HOUR` (1 or 0), and `TYPE_<CODE>` — 1 for the contract's employment
  type, 0 for any other — so one structure pays `WAGE * PRESENT_DAYS` to a daily person, or a rule holds for
  temporary people only (`condition: 'TYPE_TEMP'`). A structure per kind of employment works as before.
- **From the shifts**, approved days only, summed by PostgreSQL with the rest: `WORKED_HOURS`, `EXPECTED_HOURS`,
  `LATE_MINUTES`, `EARLY_MINUTES`, `NIGHT_SHIFTS` (days worked on a shift that ends the next day),
  `OFF_DAYS_WORKED` (days worked when nothing was expected: a weekend or a holiday).
- Test: a temporary person on a three-month contract paid 800 a day — three approved days, one late, one on the
  night shift, one on a Friday — through a large run: the days' pay, the night allowance, the type, the hours.
- **Still to do in step 3**: half days; days by shift (`SHIFT_<CODE>` — shifts have no code yet); the variables
  listed where a rule is written.

## Implementation notes (2026-11-26): step 3, part 2 — paid and unpaid leave apart

- A **leave type** says whether it is **paid** (it is, unless said otherwise) and has a **code**; shipped: Casual
  `CL`, Sick `SL`, Earned `EL`, Unpaid `LWP` (not paid).
- **In the rules**: `UNPAID_LEAVE_DAYS`, `PAID_LEAVE_DAYS` and `LEAVE_<CODE>` — the approved attendance days on
  leave, each belonging to the approved request that covers it. `LEAVE_DAYS` stays their total. A day on leave no
  approved request covers (typed in by hand) counts as paid. Read with the batch: one more query, grouped by
  PostgreSQL.
- Test: a day of unpaid leave and a day of casual leave of the temporary person, told apart by a rule.
- **For installations made before this**: the shipped types are data a company may have changed, so they are
  not rewritten — tick *Paid* off on *Unpaid leave* and give the types their codes (Workforce › Configuration ›
  Leave types).
- Half days: the next part.

## Implementation notes (2026-11-26): step 3, part 3 — half days

- **Workforce**: a leave may be for **half a day** — one date, *the morning* or *the afternoon* (`half`). Its
  working days stay 1; **`daysTaken`** is what it takes from the balance: the working days, or 0.5. The balance by
  days a year and the accrual ledger (`hr_accrual`) both take half a day for it.
- **Attendance**: a day keeps **the share of it on approved leave** (`leaveFraction`: 0, 0.5 or 1). On half a
  day of leave half the shift's work is expected, and arriving after the morning off or leaving before the
  afternoon off is neither late nor early. Not coming at all leaves the day *absent* for the half that was owed,
  and half on leave. A whole day of leave that was worked is a day worked.
- **Payroll** counts in halves: 0.5 in `PRESENT_DAYS` (or `ABSENT_DAYS`) and 0.5 in `LEAVE_DAYS`,
  `PAID_LEAVE_DAYS` / `UNPAID_LEAVE_DAYS` and `LEAVE_<CODE>`; `HALF_DAYS` says how many such days. A day typed
  in as *On leave* by hand still counts whole.
- Tests: the day's rule as a pure function (expected, lateness, the day not come to, a weekend); a half day of
  casual leave of a person paid by the day — half a day's pay, a day and a half of paid leave.
- **Not tested directly**: the accrual ledger taking 0.5 (its code path is the one line changed; the other
  accrual tests pass). **Left out**: half days of home office and of tours; a quarter day; hours of leave.

## Implementation notes — shift swaps (2026-11-26)

- **`attendance.swap`** (`SWAP/{year}/…`): two people exchange their shifts on **one date**. The person asks
  (*Ask the colleague*), the colleague **accepts** or declines, an **Attendance manager who is neither of the
  two** approves, refuses or — after approval — cancels. Declining, refusing and cancelling need the note of the
  decision. For people without an account an Attendance manager other than the person asking answers for the
  colleague.
- **The rosters are not rewritten.** The two planned shifts — the roster's, else the usual one — are written on
  the swap by the server when it is asked (same shift, or no shift: refused, there is nothing to swap). An
  approved swap is read **over** the rosters when the day is computed: each works the other's shift, with its
  hours, grace, overtime threshold and rate; `attendance.day.shift` says so, and Payroll's shift variables follow.
  A cancelled swap gives the planned shifts back at the next computation. Rewriting rosters was set aside: a
  range roster would be cut in three and could not be put back by a cancellation.
- One live swap a day per person, whichever side; people read the swaps they are one of the two of.
- Like home office and tours, days already computed change at the next computation (every night, or *compute*),
  and **approved days stay as they are**.
- Tests: the whole route with the refusals (own answer, own approval, a third person's read, a second swap that
  day, the same shift), the day's shift for both before and after cancelling.
- **Left out**: swapping a working day for a day off, swaps over several dates in one request, a notification
  to the colleague (the events `attendance.swap.submitted / accepted / approved / cancelled` are there for a
  rule of the Automation app), a browser test of the form.

## Implementation notes — compensatory leave (2026-11-26)

- In **`hr_accrual`**, on the accrual plan: **days for a day off worked** (`compDays`), **hours worked at
  least** (`compMinHours`) and **earned days are lost after** so many days (`compExpiryDays`). Meant for a leave
  type of its own (*Compensatory leave*, days a month `0`).
- **Earned**: every *approved* attendance day with hours worked and none expected — a weekend, a holiday — for at
  least the hours asked earns the days, dated that day, **once**: the ledger line (`compensatory`) names the
  attendance day, and (attendance day, kind) is unique. Found by PostgreSQL in batches of 2 000 days, not person
  by person.
- **Used the oldest first, then lost**: a credit can be taken on the day it is earned and for the days it lasts.
  Approved leave of the type, payouts and days taken back use the oldest credit still usable that day
  (`expireLots`, a pure function); what a credit has left after its last day is lost the day after
  (`comp_expiry`, once per attendance day). Only people with a credit that has just run out are looked at.
- Leave of the type is checked against the balance like any plan's; the balance record and the projection read
  the same ledger.
- The run is the existing one (every six hours, `POST /api/v1/leave-accruals/run`): a day approved now earns at
  the next run, not at once.
- Tests: the arithmetic (nothing used, a day and a half used, leave too late or too early for a credit); a
  person's October — two days off worked, one too short, an ordinary day, one not approved —, earned once, a
  day taken, too many refused, the second credit lost on its day and once.
- **Left out**: a credit taken back when an approved day is reopened and changed (the ledger is never changed:
  HR adds an adjustment); a projection that already shows credits about to be lost (leave asked for after a
  credit's last day passes until the run writes the loss); half a credit for half a day's hours; overtime paid
  *or* compensated by the person's choice.
- **Not measured at 30 000 people**: the monthly accrual itself (`accruePerson`, `refreshPerson`) still goes
  person by person with several queries each. The compensatory parts are set-based.

## Implementation notes — the final settlement (2026-11-26)

- **`payroll.settlement`** (`FS/{year}/…`) with its lines, in Payroll: the person, the last day, why, the notice
  owed and given. *Compute* (`settlement.ts`) writes the server's lines — `SALARY` of the days since the last
  approved regular payslip, `GRATUITY`, `NOTICE_PAY` or `NOTICE_SHORT`, `LOAN_SETTLE`, what other apps add —
  each with its explanation; lines added by hand are kept. Three formulas on the salary structure value them
  (`settleSalary`, `settleGratuity`, `settleNotice`), checked when saved.
- **Paid as a payroll run of its own** (kind *settlement*, one payslip made of the settlement's lines) rather
  than by a second way of paying: the run's proof, its entry in the books (`payroll_account`), *Mark as paid* and
  the bank's file are the ones every run has. `peopleOf` knows a settlement run pays its one person.
- **Approval**: a Payroll manager, never their own. The settlement is computed again first and refused when the
  net differs from what was shown — a loan instalment or a payslip approved in between. Then, once: the run is
  made, computed, proved and approved; the loans repaid in full and finished; the contract's end set to the last
  day and the contract ended when that day has come; `settledOut` for other apps.
- **Not paid twice**: a regular run leaves out anybody with an approved settlement whose first unpaid day is in
  or before its period.
- **Leave** (`hr_accrual`, through `extraLines` / `settledOut`): every day left on the last day of each plan
  that pays days out — the days that otherwise stay included — at the plan's value of a day; approved, the days
  leave the ledger as *Paid out*.
- One settlement a person (cancelled ones apart). People read their own once approved.
- Tests: a resignation with ten days of notice short, two years of service and a loan (15 000 + 30 000 − 10 000
  − 6 000), a line by hand kept, an officer refused, stale figures refused, the run of the kind with its proof,
  the loan repaid, the contract ended, June's run without the person, who reads what, a second settlement
  refused; a termination pays the notice; nobody approves their own; the leave left paid and taken from the ledger.
- **Left out**: income tax on the settlement (a line by hand); provident fund balances paid out; pending
  one-off inputs of the last month (they are not read: add them by hand); days already paid after the last day
  are warned about, not taken back by themselves; a contract whose last day is still to come is given its end
  date but is ended by hand once the day has come; undoing an approved settlement; a browser test of the form;
  the settlement run's entry was not asserted in `payroll_account`'s tests (it is the same code as any run's).

## Implementation notes — the leave accrual at 30 000 people (2026-11-26)

- **Measured first** (`pnpm bench accrual`, 2 000 people, one plan giving a day and a half a month): 25 ms a
  person when there was nothing to write, 83 ms on a first run — at 30 000 people twelve minutes per plan every
  six hours, and forty for a first run. Each person cost some thirty queries: their ledger, their leave, their
  balance record, and the working calendar for every month to the year's end.
- **Now in batches of 500** (`ACCRUAL_BATCH`, `loadBatch`): a batch's balance records (made when missing, in one
  go), its ledger, its leave of the type and — for a formula that reads the days worked — its approved
  attendance by month are read in a query each; the same arithmetic then runs on what was read; the batch's new
  ledger lines are written in one go, and **a balance record is written only when what it says changes**. The
  working calendar is asked only by a formula that reads `WORKED_DAYS` or `WORKING_DAYS`.
- One person's projection, a payout, a settlement and the leave check still read the database directly (the same
  functions without the batch).

| 30 000 people | seconds | per person |
| --- | --- | --- |
| A first run: ten months for everybody (300 000 ledger lines) | 211 | 7.0 ms |
| A run with nothing to write | 3.5 | 0.12 ms |
| The run after a month has ended (30 000 lines) | 18.6 | 0.62 ms |

  At 2 000 people before and after: 167 s → 17 s, 49 s → 0.3 s, 53 s → 1.1 s. The seventeen tests of the
  accrual give the same ledgers and balances as before.
- **Not measured**: a plan whose formula reads the days worked (it still asks each person's calendar for each
  month to come); several plans (the run is once per plan); people with years of ledger behind them. The run
  is still one transaction per company.

## Step 3 is done but for

Nothing: both leftovers below are done.

**The list of variables** is done (2026-11-26): one list (`variables.ts`) of every name the engine sets, by what
it is about, and of the families named by the company's data. The rule form shows it (it had fallen behind: it
named 17 of the 31); `GET /api/v1/payroll/variables?structure=` gives it to Payroll officers with the codes that
exist — the shifts', the leave and employment types', the parameters, the values and inputs in use, the slab
tables, a structure's rule codes. A test reads `compute.ts` and fails when a name is set there and not listed,
or listed and not set. **Not built**: a picker in the form that inserts a name into the formula (the list is
text under the field), and Bangla for each variable's description (the API's descriptions are English).

**Days by shift** are done (2026-11-26): a shift has a **code** (`NIGHT`, `A`, `B2` — capitals, unique; the
shipped shifts are `GEN` and `NIGHT` on new installations, an existing one types them in), and a rule reads
`SHIFT_<CODE>`: the approved days with hours worked on that shift, counted by PostgreSQL per batch; a shift not
worked, or a code no shift has, reads as 0. A swapped day counts on the shift actually worked.

## 7. Open questions

1. Home office without a check-in: present or absent by default?
2. Is a run per company enough, or are runs per unit / department / pay group needed (30 000 people are rarely
   paid in one run)? Step 1 does not depend on the answer; pay groups would be a small addition.
