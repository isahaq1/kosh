# RFC 0026 — Projects for programmes: plans, phases, work packages, teams and money

- Status: Accepted (2026-11-04)
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
