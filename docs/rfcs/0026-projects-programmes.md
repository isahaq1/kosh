# RFC 0026 — Projects for programmes: plans, phases, work packages, teams and money

- Status: Accepted (2026-11-04); implemented (steps 1–5, 2026-11-04)
- Builds on: RFC 0008 (Projects), RFC 0022 (app depth), RFC 0024 §2.5 (cost centres, budgets), RFC 0025 (approvals)
- Benchmark: Odoo's Projects plus the custom addon `poultry_project` (Paragon Group's Poultry Breeding ERP)

## 1. Why

Kosh's Projects app is the basics: projects with a manager, customer and dates; tasks on a board of stages with an
assignee, priority, deadline and planned hours; timesheets; tasks made from sales orders; the portal; an overview and
a timeline. That is enough for a team's to-do work, not for a rollout, a farm build or a factory setup.

The benchmark is what `poultry_project` adds on top of Odoo's Projects — and what Odoo's Projects already has that we do
not yet:

| | Odoo Projects + `poultry_project` | Kosh today |
| --- | --- | --- |
| Before a project | A **Project Plan** (objectives, sponsor, expected outcome, strategic goal, estimated budget), submitted, approved through the suite's Approvals; a company may **require** an approved plan before any project | — |
| Hierarchy | Programme → project (**parent / child** projects) → **Phase** (nested sub-phases, a manager, dates, status, progress) → **Work Package** (deliverables, manager, dates, status, progress) → task → sub-task | Project → task |
| Configuration | **Project Types** and **Task Categories** as data per company | — |
| A project's case | Code, type, sponsor, owner, department, priority, **risk level**, **health** (on track / at risk / off track), location, scope, assumptions, constraints | Name, customer, manager, dates, description |
| Tasks | Sub-tasks, **dependencies**, **milestones**, tags, several assignees, recurring tasks, a calendar | One assignee, stages, priority, deadline |
| People | **Team members** with a role, an allocation %, an hourly cost and dates; **over-allocation** across projects flagged | — |
| Money | A **budget** per project with lines by phase and work package; **actual** from the books and **labour** (timesheets × the member's hourly cost); **variance** | Timesheet hours only |
| Overview | Projects by health, plans awaiting a decision, phases overdue, people over-allocated | Overview with tasks and hours |
| Security | Plans seen by their author, sponsor and managers; multi-company | Record rules by project |

## 2. What we build — and where we go further

Everything in the table, plus what the addon leaves to manual updates or to "phase 2":

- **Progress is computed, never typed**: a task is done or not; a work package's progress is its tasks' planned hours
  done; a phase's, its work packages' and direct tasks'; a project's, its phases'. A manual override stays possible
  and is shown as such.
- **Health is computed** from schedule (progress against elapsed time, milestones missed) and cost (actual against
  budget), with the thresholds in App settings; the manager may override it with a reason, kept in the history.
- **The plan's approval is the Approvals engine** (RFC 0025): levels by amount, named people, the requester's
  manager, quorum, deadlines, delegation, decisions from email — not a parallel workflow.
- **A baseline** is taken when the plan is approved (dates, budget, each phase's and work package's dates); the
  timeline shows the baseline under the actual bars, and every variance is against it.
- **Dependencies drive the schedule**: finish-to-start links (with a lag) between tasks; the Gantt shows them, moves
  successors when a predecessor slips, and marks the **critical path**.
- **Money through Accounting**: each project gets its **cost centre** (RFC 0024 §2.5) automatically, so actuals are
  what the books say — bills, expenses, assets — plus labour from timesheets at each member's cost, and **committed**
  purchase orders not billed yet; the budget's lines by phase, work package and account warn or block like
  Accounting's budgets. Without Accounting, labour and budget lines still work.
- **Workload**: a person's allocation across every project week by week, as a heat map; over-allocation flagged when a
  member is added, not discovered later.
- **Risks, issues and change requests**: a register per project (probability × impact, owner, mitigation, status); a
  change request that moves the baseline goes through an approval and records what changed.
- **Status reports**: a weekly report per project — health, progress, what was done, what is next, risks — written by
  the manager with the figures filled in, sent to the sponsor and followers.

## 3. Design

### 3.1 Models (in `project`, Kosh's Projects module)

- `project.type` and `project.task.category` (company data, archivable, a category may belong to a type).
- `project.project` gains: `code` (numbered per company), `type`, `parent` / `children` (no cycles), `plan`,
  `sponsor`, `owner`, `department` (Workforce, when installed), `priority`, `riskLevel`, `health` (computed, with
  `healthOverride` and its reason), `location`, `scope`, `assumptions`, `constraints`, `progress` (computed),
  `baselineStart` / `baselineEnd`, `analytic` (the cost centre, with Accounting).
- `project.plan`: number, title, type, manager, sponsor, department, company, dates (planned and actual), priority,
  description, objectives, expected outcome, strategic goal, estimated and approved budget; states draft → submitted →
  approved / rejected → in progress (once a project starts from it) → completed; cancel; the approval policy *Project
  plans* (levels by estimated budget) installed with the module. App settings: *Require an approved plan to create a
  project*.
- `project.phase` (nested; manager, responsible, dates, status draft / in progress / on hold / done / cancelled,
  priority, description, progress computed) and `project.work.package` (in a phase or directly in the project;
  manager, dates, status, deliverables, progress computed). Both: same-project checks, no cycles, codes.
- `project.task` gains: `phase`, `workPackage` (kept in the same project; the work package sets the phase),
  `category`, `parent` / `subtasks`, `assignees` (several; `assignee` kept as the first), `tags`, `milestone`
  (a boolean, or a `project.milestone` with a date and reached flag), `dependencies` (`project.task.link`:
  predecessor, successor, lag days), recurrence (every n days / weeks / months, until).
- `project.member`: project, user, role (`project.role`), allocation %, hourly cost (Monetary), from / to, notes;
  `overallocated` computed across the person's projects in overlapping dates.
- `project.budget.line` (without Accounting) or Accounting's budget lines with the project's cost centre (with it):
  phase, work package, category of cost, planned; actual and committed computed.
- `project.risk` / `project.issue` / `project.change` and `project.status.report` (step 5).

### 3.2 Screens

Projects › *Plans* (list, form with the approval steps); a project's page with tiles (phases, work packages, tasks,
team, budget, risks), its **structure** tab (phases → work packages → tasks as a tree with progress bars), the
**Gantt** with dependencies, baseline and critical path, the **team** with allocation, the **budget** with planned,
actual, committed and variance by phase; *Workload* (people × weeks heat map); the Projects overview (by health, plans
awaiting a decision, phases overdue, people over-allocated, budget variance).

## 4. Steps

1. **Structure**: types, task categories, the project's case fields, programmes (parent / child), phases, work
   packages, tasks in them; sub-tasks, several assignees, tags, milestones, dependencies; computed progress; the
   structure tree; English and Bangla; tests and E2E.
2. **Plans**: the plan with its approval through RFC 0025, the company setting that requires it, the baseline.
3. **Team and workload**: members, roles, allocation, hourly cost, over-allocation, the workload heat map; labour cost
   from timesheets.
4. **Money and health**: the project's cost centre, budget lines by phase and work package, actual, committed and
   variance; computed health; the overview.
5. **Schedule and control**: the Gantt with dependencies, the critical path and the baseline; recurring tasks; risks,
   issues and change requests; weekly status reports.

## 5. Decisions (2026-11-04)

1. **Order**: structure first, then plans, team and workload, money and health, schedule and control (§4).
2. **Money through Accounting**: each project's cost centre, actuals from the books plus labour, committed purchase
   orders, budget lines that warn or block; without Accounting, Projects' own budget lines with labour still work.
3. **Control in**: risks, issues, change requests and weekly status reports are step 5.

## Implementation notes (2026-11-04): step 1 — structure

- **Models** (`modules/project`, version 0.4.0): `project.type`, `project.task.category`, `project.tag`,
  `project.phase`, `project.work.package` and `project.task.link`. `project.project` gains its code (sequence
  `project.project`), type, `parentProject` / `children` (a hierarchy with `parentPath`), sponsor, owner, priority,
  risk level, location, scope, assumptions, constraints and `progress`. `project.task` gains `phase`, `workPackage`,
  `category`, `parentTask` / `subtasks`, `assignees`, `tags`, `milestone`, `predecessors` / `successors`, `progress`
  and `blocked`. The department waits for step 3, with the team.
- **Checks**: no programme inside its own projects, a sub-phase in its phase's project, a work package in its phase's
  project, a task's phase, work package and parent task in its own project, no dependency on itself, none twice and
  none in a circle, dates in order, a progress override from 0 to 100.
- **Progress** (§2) as stored computes, weighted by planned hours. The structure tree (`projects.Structure`, in
  English and Bangla) is a node component of the project form. The progress widget and kanban bars now read decimals
  (served as strings) as well as integers; before, decimal progress showed nothing.
- **Shutro request #33**: a one2many's batch load aliases the inverse column `parent_id`, which a target's own `parent`
  field overwrote, so lists of tasks, phases and projects read empty. Until Shutro is fixed, the self-relations are
  named `parentProject`, `parentPhase` and `parentTask` (and `sale_project` names its fields when loading tasks).
- **Screens**: Projects › Phases (list, timeline, form with tiles) and Work packages (list, board, form);
  Configuration › Project types, Task categories, Tags; projects as a hierarchy; the project form's people and risk,
  scope, tiles for phases, work packages and sub-projects, lines of phases and work packages; the task form's place,
  people, sub-task lines and dependency lines; searches for blocked tasks, milestones and top-level tasks.
- **Tests**: on real PostgreSQL a programme with a project, the cycle and dates refused, a phase and a work package, the
  onchange setting the phase, progress 75 from planned hours on the work package, phase and project, the override and
  its range, a task in another project's phase refused; sub-tasks, several assignees and tags, a dependency blocking
  until done, circles and self-links refused, outsiders refused. End to end, a phase and a work package made on screen
  and shown in the project's structure.

## Implementation notes (2026-11-04): step 2 — plans and the baseline

- **`project.plan`**: number (sequence `project.plan`, `PLAN-0001`), title, type, who wrote it, manager, sponsor,
  priority, planned dates, objectives, expected outcome, strategic goal, description, estimated and approved budget,
  when approved, its projects. States draft → waiting for approval → approved / rejected → in progress → completed;
  cancel; *Set to draft* after a rejection, a sending back or a withdrawal. Submitting needs the objectives, the dates
  and the estimate (a guard). The department waits for step 3.
- **Approval** through RFC 0025's engine: the *Project plans* policy, installed with Projects — the sponsor (a Projects
  manager when the field is empty), and above an estimate of 1 000 000 a Projects manager. The engine runs
  `approve`, `reject` and `redraft` as the system; approving fills the approved budget from the estimate unless a
  manager set it. Events `project.plan.submitted` and `project.plan.approved`.
- **Who sees a plan**: who wrote it, its manager and its sponsor (record rules); changed by its writer or manager while a
  draft or rejected, run (started, completed) by its manager once approved; Projects managers see and change all.
- **Baseline**: *Start the project* makes one project from the plan (name, type, people, priority, dates,
  description) and sets its baseline start, end and budget as the system. Phases and work packages have a baseline too;
  the plan's *Take the baseline again* (permission `project.baseline`, Projects managers) copies their current dates
  and the projects'. Baseline fields and the approved budget are writable by Projects managers only (Shutro field
  groups), so the server refuses anyone else. A project shows *Days late against the baseline*. Change requests that
  move the baseline through an approval are step 5.
- **The setting** (App settings › Projects › Plans, `res.company.projectRequirePlan`): a project without a programme
  needs an approved or running plan. `project.project.planNotNeeded()` lets apps exempt the projects they make;
  `sale_project` exempts projects made by a confirmed order. A project linked to a plan that is not approved or running
  is always refused.
- **Tests**: on real PostgreSQL a plan refused for submission without its case, submitted, unseen by outsiders and
  frozen for its writer; approved by the sponsor and then a manager for a large estimate; started into a project with
  the baseline; a slip of ten days, the baseline refused to a user by hand and to a user through the plan, taken again by
  a manager; the setting refusing a project without a plan or with a draft one and accepting one inside a programme. End
  to end, a plan written, approved by its sponsor in the Approvals inbox and started into a project with its baseline.

## Implementation notes (2026-11-04): step 3 — team and workload

- **`project.role`** (name, code, a default hourly cost) and **`project.member`** (project, person, role, allocation
  1–100 %, hourly cost, from / until, notes). Projects managers manage teams; Projects users read them.
- **Over-allocation** (`overallocated`, computed when read): the person's highest total allocation on any day of the
  membership's dates, across their memberships in active projects (open dates count as unbounded), above 100 %. The
  member being edited counts as it is on the form, so the onchange flags it before saving. It reads the teams as the
  reader (every Projects user sees every team): a GET cannot open a superuser scope, which writes an audit row.
- **Workload** (`GET /api/v1/projects/workload?from=YYYY-MM-DD&weeks=1..52`, Projects › *Workload*): people × weeks
  from the Monday of `from`, each cell the week's peak allocation with the projects behind it; managers see everyone,
  others themselves. In English and Bangla, as a table with captions and labels for screen readers.
- **Labour cost**: `project.timesheet.cost` = hours × the member's hourly cost on that day (else the role's default,
  else nothing); `project.project.labourCost` sums it. Rates and costs have Shutro field groups — read by Projects
  managers only, left out of everyone else's records and refused when asked for by name.
- **Shutro request #34**: field groups apply to computes too (loading a restricted field and writing a computed one).
  Until fixed, the costs' write groups name `project.user`, and the computes read rates and costs inside
  `env.asSuperuser`, which is safe because they run in the write that changed them. The department waits for
  Workforce's link (a later step).
- **Tests**: on real PostgreSQL roles and members by managers only, hourly costs refused to users and left out by
  default, over-allocation across two projects in overlapping weeks (and flagged in the onchange before saving), an
  allocation over 100 % refused, labour costs from the role's default and a member's own rate, a user's own timesheet
  without its cost, the workload's weekly peaks for a manager and only oneself for a user, outsiders and bad ranges
  refused. End to end, two memberships adding to 120 % shown over-allocated and in red on the Workload.

## Implementation notes (2026-11-04): step 4 — money and health

- **`project.budget.line`** (project, what for, category, phase, work package, planned; Projects managers only;
  phase and work package kept in the project). `project.project` gains `budget` (the lines), `bookedCost` and
  `committedCost` (written by the refresh), `actualCost` (labour plus booked) and `variance` (budget less actual and
  committed), all seen by Projects managers alone; computes for anyone else leave them at zero without reading them
  (a user's new-project form computes them too).
- **Bridges** through `project.project.moneyOf()` (a method the bridges extend, like `planNotNeeded()`):
  `project_account` (Projects ↔ Accounting) makes each project's cost centre once, coded and named like the project,
  and books its posted expense lines (debit less credit); `project_purchase` (with Purchase Accounting) commits the
  untaxed lines of confirmed orders on that cost centre not billed yet. Purchase Accounting carries the order line's
  cost centre onto the bill, so a billed order moves from committed to booked. Registered in the installer (proposed
  with the apps they connect), the demo, the npm package and the apps' E2E server.
- **Health** (`judgeHealth`, pure and unit-tested): the worst of schedule (progress against the share of time gone;
  past the deadline and not done is off track), late milestones (at risk) and cost (the budget used, actual and
  committed). Thresholds in App settings › Projects › Health (`projectHealthBehindRisk` 10, `projectHealthBehindOff`
  25, `projectHealthCostRisk` 90). `refreshProjects()` writes `healthComputed` with the reasons in `healthNotes` and
  `healthCheckedAt`, hourly (off with `KOSH_SCHEDULES=off`) and on `POST /api/v1/projects/refresh` (Projects managers;
  the projects they see; *Refresh the figures* on the form). `health` is the manager's override, which needs its
  reason, or else the figures; all three are tracked.
- **Late phases**: domains have no "today", so the refresh marks phases past their end and not finished `late`. The
  step 1 *Late* filter, which compared with an unsupported placeholder, now reads it, and so does the overview's
  *Phases overdue*. The overview also shows projects by health and plans waiting for a decision. People
  over-allocated are on the Workload (a computed flag cannot be counted on a dashboard).
- **Tests**: unit tests of the health rules; on real PostgreSQL budget lines and money for managers only, a refresh
  refused to users, off track when behind, on track when caught up, at risk with a late milestone, a late phase, the
  override refused without a reason and kept over the figures, a user's new-project onchange; with Accounting a cost
  centre made once, a posted bill booked and a draft not, off track beyond the budget; with Purchase an order
  committed, then billed and booked and never counted twice, at risk at 90 %, users refused the money. End to end, a
  manager refreshing the figures and a user seeing the health without the money.

## Implementation notes (2026-11-04): step 5 — schedule and control

- **Control register**:
  - `project.risk`: category, probability and impact from 1 to 5, the score and level (up to 4 low, 9 medium, 15
    high, above that critical), owner, mitigation, contingency, review date and status.
  - `project.issue`: severity, who raised it, owner, due date, status, the risk it came from, and a resolution
    required once resolved.
  - `project.change` (`CR-0001`): a new deadline and/or a new baseline budget, the budget for managers only, with the
    reason and the impact. Decided by the *Project change requests* policy: the project's sponsor (a Projects manager
    when there is none), then a Projects manager. Approving applies it as the system: the deadline and baseline end
    move, the baseline budget too, and the previous values are kept along with when it was applied.
  - `project.status.report`: the project's health and progress and its open risks and issues, filled in when the
    project is chosen. Sending posts it on the project's chatter and makes the sponsor a follower.
  - Projects users write the register; managers delete. Changes and reports are frozen once submitted or sent.
  - Events `project.change.applied` and `project.status.report.sent`. The project page has tiles for open risks, open
    issues, change requests and reports.
- **Schedule** (`schedule.ts`, pure functions unit-tested):
  - Tasks gain `dateStart` (they end on their deadline) and a baseline, taken by the plan's *Take the baseline again*.
  - `criticalPath()`: earliest and latest dates over finish-to-start links with lags. A task without dates lasts its
    planned hours at 8 a day. Float, and critical when there is none.
  - `slipMoves()`: moves dated tasks after what they wait for, keeping their length, in dependency order.
  - Served by `GET /api/v1/projects/:id/schedule` and `POST …/schedule/apply`, as the caller.
  - The project form's **Schedule** component draws bars, baselines, arrows, milestones as diamonds and the critical
    path in red, with labels for screen readers, in English and Bangla. Tasks also have a timeline view.
- **Repeating tasks**: every n days, weeks or months until a date. The refresh (hourly and on demand) makes the next
  one of each done task once (`nextTask`), its dates moved, in the first open stage.
- **Tests**:
  - Unit: the critical path with float, lags, a task without dates, slipping successors.
  - On real PostgreSQL:
    - a risk scored critical, an out-of-range risk refused, outsiders refused;
    - an issue refused as resolved without its resolution;
    - a change request refused with nothing asked, then approved by the sponsor and a manager and applied with the
      deadline before it kept;
    - a status report filled in, sent onto the chatter with the sponsor following, frozen once sent;
    - the critical path and float through the API, a backwards task refused, a slip moving two tasks;
    - a weekly task repeated once a week later.
  - End to end: a risk scored critical on screen; the project's schedule and its risk tile.
