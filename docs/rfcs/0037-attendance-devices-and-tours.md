# RFC 0037 — Attendance devices that push, and official tours

- Status: **Accepted** (2026-11-19, asked for by the owner: "attendance device integration" and "official tours")
- Builds on: RFC 0024 §2.2 (Attendance: shifts, punches, device files), RFC 0021 (Workforce), RFC 0024 §2.1 (Spend:
  expense reports and cash advances), RFC 0025 (Approvals), RFC 0034 §2.4 (Working time)

## 1. Why

Two things a company with factories and field staff asks on the first day, and Kosh answers halfway:

1. **"Our people punch on ZKTeco machines."** Today someone exports `attlog.dat` from each machine and uploads it.
   Nobody does that every day at twelve sites; attendance is then a week late and payroll waits for it. The machines
   can send each punch to a server themselves (the vendor's *push* protocol, "ADMS"). Odoo has no device support of
   its own: it is sold as third-party add-ons per machine.
2. **"He was not absent, he was on tour."** A person sent to a depot, a farm or a customer for three days has no
   punch at their site. Without a tour on record they are *absent* in Attendance, lose pay in Payroll, and their
   travel allowance is a paper form. Odoo has no tours either: people abuse leave types for it.

## 2. Attendance devices that push

### 2.1 What a manager does

*Attendance › Configuration › Devices*: add the machine by its **serial number**, name it, choose its site. On the
machine, set the server's address and port (its menu: *Comm › Cloud Server Setting*). From then on each punch arrives
within seconds; the list shows when each device was last seen and its last punch. A machine that knocks without being
registered is listed as **waiting for approval** with its serial number and address — a manager approves it or
removes it; nothing it sends is taken until then.

People are matched as with files: the employee's *Device user ID* (else their badge).

### 2.2 The protocol

The machine speaks plain HTTP to fixed paths; the server answers in plain text:

| The machine | The server |
| --- | --- |
| `GET /iclock/cdata?SN=<serial>&options=all…` (when it starts, and now and then) | its options: send attendance logs, in real time, the installation's time zone |
| `POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=…` with lines `<user>\t<YYYY-MM-DD HH:MM:SS>\t<status>\t<verify>…` | `OK: <n>` |
| `POST /iclock/cdata?…&table=OPERLOG` (its operation log) | `OK: 0` (not kept) |
| `GET /iclock/getrequest?SN=<serial>` (asks for commands) | `OK` (none) |
| `POST /iclock/devicecmd?SN=<serial>` (a command's result) | `OK` |

- **The paths are the machine's, not ours** (`/iclock/…`, outside `/api`): the reverse proxy must route `/iclock/` to
  the server, on a port the machines can reach.
- **The protocol has no password.** What stands in for one: the serial number must be registered and enabled; an
  optional **address allow-list** per device (the site's public address); a rate limit per address; the body is
  capped; and a punch can only *add* attendance for a known person — a device cannot read anything. Use https where
  the machine's firmware supports it, or a VPN from the site. This is said plainly in the docs: a device on the open
  internet over http can be impersonated by someone who knows its serial number.
- Unregistered serial numbers get `401` and are remembered (at most 20 waiting) for a manager to approve.

### 2.3 From punches to attendance

- Every line received is kept once as a **device punch** (`attendance.device.punch`: device, the user's number, the
  local time as sent, the instant, and what became of it), unique per device, user and time — a machine that sends
  its whole memory again changes nothing.
- A person's device punches are **replayed in order** into check-ins and check-outs: a punch closes the person's open
  device check-in when it is at least a minute and at most sixteen hours after it (so a night shift's check-out after
  midnight closes the evening's check-in); otherwise it opens one. A second tap within a minute is ignored. A
  check-in never closed stays visible as *unpaired* in the device's punches and is not counted, as with files.
- A machine that was offline sends its backlog late and out of order: the replay starts from the earliest new punch,
  so the days come out the same whatever the order of arrival. **Approved days are never changed**: a punch for a day
  already approved is kept and marked *too late*.
- Punches of unknown numbers are kept and marked *unknown*: once the employee's *Device user ID* is set, *Apply
  again* on the device takes them.
- The days are recomputed as for any punch (lateness, overtime, absence).

### 2.4 What is not in this RFC

Enrolling fingerprints or users from Kosh, pushing commands to machines, door access, other vendors' protocols
(the model has a `protocol` field for them), and pulling from a machine over the LAN (it needs a network path from
the server to every machine; push needs none).

**Verification**: the protocol is implemented from the vendor's published push specification and tested against a
simulator in the suite. It is **not certified against a physical machine** until one is pointed at a test server —
firmware versions differ in details (the stamp, the status codes). The owner's first machine is the certification.

## 3. Official tours

### 3.1 What people do

- An employee asks for a **tour** (*Workforce › Tours*): the dates, where to (one or several places), the purpose,
  how they travel, and — when they need cash — an **advance** amount. Numbered `TOUR/2026/0001`.
- It is **approved** by their manager (their leave approver when they have one, else HR), never by themselves: the
  same rule and the same route as leave. Refusing needs a reason.
- An approved tour may be **cancelled** before it starts, or **cut short** (its end moved earlier) by HR.
- A tour may not overlap another tour or an approved leave of the same person.

### 3.2 What the other apps do with it

- **Attendance**: a working day inside an approved tour with no punch is **On tour** — present for payroll, not
  absent, not leave. A day with punches is computed from them as usual (a person who came to the office first).
  Weekends and holidays inside a tour stay what they are.
- **Spend** (the `hr_tour_expense` bridge, installed when both are): an approved tour's advance becomes a **cash
  advance** drafted for the person, once; expense reports may name the tour, and the tour shows what was advanced,
  claimed and settled. The daily allowance is a Spend category with a rate per day, as today — the tour gives the
  number of days.
- **Payroll** reads attendance days, so *On tour* days are paid as present with no change there.

### 3.3 What is not in this RFC

Travel booking (tickets, hotels), per-grade allowance tables (a Spend policy can already rate per day; a table by
grade and city class is a later step), mileage from a map, foreign tours with a second currency for allowances.

## 4. Steps

1. **Devices**: the models, the `/iclock` endpoints, the replay, the Devices screens, the simulator tests.
2. **Tours**: the model with its approval and its rules, *On tour* in Attendance, the screens.
3. **Tours and Spend**: the bridge — the advance, expense reports on a tour, the totals on the tour.

Each step: typed end to end, tests on real PostgreSQL, permission tests, English and Bangla, the module standard.

## 5. Notes

- **Step 1 (2026-11-19). Devices that push.** `attendance.device` (serial number, status — waiting for approval,
  active, off —, site, the addresses it may send from, when it was last seen and its last punch, the machine's own
  stamp) and `attendance.device.punch` (each line once per device, number and time, with what became of it:
  counted, second tap, unpaired, unknown person, day already approved). The `/iclock` endpoints of §2.2 in a scope
  of their own (text bodies whatever the content type, rate limited per address, 2 MB at most). The replay of §2.3
  (`replayPunches`): it starts at the check-in still open at the earliest new punch, makes the records of pushed
  punches again from every punch kept, and leaves approved days as they are. Records made this way have their own
  source (*Device*, beside *Device file*), so a replay never touches what a file, a phone or a kiosk recorded.
  **A machine belongs to no company**: its lines are kept outside any, then each company takes the punches of its
  own people (employees are seen within their company only) — one machine at a shared gate serves several
  companies. *Apply again* (`POST /api/v1/attendance/devices/:id/apply`) matches numbers unknown until now; it also
  happens by itself at the device's next punch. Screens: Attendance › Configuration › Devices and Device punches,
  English and Bangla. Tests: 9 with a simulated machine (refused and waiting, options, one day sent three times and
  without a content type, a second tap, a night shift, a forgotten check-out, a backlog out of order, live one punch
  at a time, an approved day, an unknown number, off and wrong address), one E2E through the Devices screen.
  **Not certified against a physical machine**: the requests and answers are the push protocol as published and as
  I know it; the first real machine pointed at a test server is the certification, and firmware differences (the
  stamp, extra tables) may need a change. Left out: an *Approve* button (the status is set on the form), a button
  for *Apply again* (the API has it), the punch's status code (check-in / check-out keys on the machine are not
  read: order decides), pairing a pushed punch with a phone or kiosk check-in of the same day.
