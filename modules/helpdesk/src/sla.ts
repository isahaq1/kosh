/**
 * The Helpdesk clock (RFC 0024 §2.4), refreshed every few minutes on the server and on request:
 *
 * - each open ticket gets its **SLA policy** (the first, by sequence, of its team or every team, from its priority,
 *   for its customer or every customer) and its **deadlines** in the team's business hours — the first reply from
 *   the ticket's opening, the resolution pushed back by the time spent waiting on the customer;
 * - the **first reply** is the first message (not a note) an agent posted on it;
 * - a ticket waiting on the customer **resumes** when the customer writes back (a message by email);
 * - unassigned tickets of teams that assign get their **agent**: in turn, or the one with the fewest open tickets;
 * - the **status**: met (solved in time), breached (a target passed), at risk (less than a fifth left), on track.
 *
 * A solved ticket asks its customer for a **rating** through a link (`/api/v1/public/helpdesk/rate`).
 */

import { randomBytes } from 'node:crypto';
import { mailerFromEnv } from '@kosh/mail';
import { installationSetting } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import type { Env } from './.kosh/bindings.js';
import { addBusinessMinutes, businessMinutesBetween, type Hours, WEEKENDS } from './hours.js';
import { RANK } from './module.js';

/** The installation's time zone for business hours (App settings › Helpdesk). */
export async function timeZoneOf(env: Env): Promise<string> {
  const tz = String(await installationSetting(env, 'helpdesk.timezone', 'Asia/Dhaka'));
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'Asia/Dhaka';
  }
}

interface TeamHours {
  readonly open: string;
  readonly close: string;
  readonly weekend: string;
}

/** A team's business hours; without a team, every day from 09:00 to 18:00. */
export async function hoursOf(env: Env, team: TeamHours | null): Promise<Hours> {
  return {
    open: team?.open ?? '09:00',
    close: team?.close ?? '18:00',
    weekend: WEEKENDS[team?.weekend ?? 'none'] ?? [],
    tz: await timeZoneOf(env),
  };
}

/** The working minutes a ticket has been waiting on the customer, up to `now`. */
export async function pausedSince(
  env: Env,
  ticket: { readonly waitingSince: Date | null; readonly team: TeamHours | null },
  now: Date,
): Promise<number> {
  if (ticket.waitingSince === null) return 0;
  return businessMinutesBetween(ticket.waitingSince, now, await hoursOf(env, ticket.team));
}

/** Refreshes the tickets given (every open, waiting and just-solved ticket when none). */
export async function refreshSla(
  env: Env,
  ids?: readonly number[],
  now = new Date(),
): Promise<number> {
  const chosen =
    ids ??
    (
      await env.model('helpdesk.ticket').search({
        where: {
          or: [
            { state: { in: ['open', 'waiting'] } },
            { state: 'solved', slaStatus: { in: ['on_track', 'at_risk'] } },
          ],
        },
      })
    ).ids;
  const tickets = [
    ...(await env
      .model('helpdesk.ticket')
      .browse(chosen as never)
      .load({ team: { members: true }, sla: true, partner: true })),
  ];
  const policies = [
    ...(await (
      await env.model('helpdesk.sla').search({ where: {}, order: ['sequence asc', 'id asc'] })
    ).load({
      team: true,
      partner: true,
    })),
  ];
  for (const t of tickets) {
    const changes: Record<string, unknown> = {};
    // The agent, for teams that assign.
    if (
      t.assignee === null &&
      t.team !== null &&
      t.team.assignment !== 'manual' &&
      t.team.members.length > 0
    ) {
      const members = [...t.team.members].sort((a, b) => a.id - b.id);
      let chosen = members[0];
      if (t.team.assignment === 'load') {
        let fewest = Number.POSITIVE_INFINITY;
        for (const m of members) {
          const open = (
            await env.model('helpdesk.ticket').search({
              where: { assignee: m.id, state: { in: ['open', 'waiting'] } },
            })
          ).length;
          if (open < fewest) {
            fewest = open;
            chosen = m;
          }
        }
      } else {
        // In turn: the member after the one given the team's latest ticket.
        const [last] = await (
          await env.model('helpdesk.ticket').search({
            where: { team: t.team.id, assignee: { isNull: false }, id: { ne: t.id } },
            order: ['id desc'],
            limit: 1,
          })
        ).load({ assignee: true });
        const at = members.findIndex((m) => m.id === last?.assignee?.id);
        chosen = members[(at + 1) % members.length];
      }
      if (chosen !== undefined) changes['assignee'] = chosen.id;
    }
    // The policy.
    let sla = t.sla;
    if (sla === null) {
      sla =
        policies.find(
          (p) =>
            (p.team === null || p.team.id === t.team?.id) &&
            (p.partner === null || p.partner.id === t.partner?.id) &&
            (p.priority === null || (RANK[t.priority] ?? 1) >= (RANK[p.priority] ?? 0)),
        ) ?? null;
      if (sla !== null) changes['sla'] = sla.id;
    }
    // The first reply: the first message (not a note) an agent posted.
    let firstReplied = t.firstRepliedAt;
    const messages = [
      ...(await (
        await env.model('mail.message').search({
          where: { resModel: 'helpdesk.ticket', resId: t.id, kind: 'comment' },
          order: ['id asc'],
        })
      ).load(['author', 'authorEmail', 'createdAt'])),
    ];
    if (firstReplied === null) {
      const reply = messages.find((m) => m.author !== null && (m.authorEmail ?? '') === '');
      if (reply !== undefined) {
        firstReplied = reply.createdAt;
        changes['firstRepliedAt'] = reply.createdAt;
      }
    }
    // A customer's email while waiting resumes the ticket.
    let state = t.state;
    let paused = t.pausedMinutes;
    if (state === 'waiting' && t.waitingSince !== null) {
      const since = t.waitingSince;
      const answer = messages.find(
        (m) => m.author === null && (m.authorEmail ?? '') !== '' && m.createdAt > since,
      );
      if (answer !== undefined) {
        paused += await pausedSince(env, t, answer.createdAt);
        changes['pausedMinutes'] = paused;
        changes['waitingSince'] = null;
        state = 'open';
      }
    }
    // Deadlines and the status.
    if (sla !== null) {
      const hours = await hoursOf(env, t.team);
      const opened = t.createdAt;
      const firstBy = addBusinessMinutes(opened, Number(sla.firstReplyHours) * 60, hours);
      const waitingNow =
        state === 'waiting' && t.waitingSince !== null ? await pausedSince(env, t, now) : 0;
      const solveBy = addBusinessMinutes(
        opened,
        Number(sla.resolveHours) * 60 + paused + waitingNow,
        hours,
      );
      changes['firstReplyDeadline'] = firstBy;
      changes['resolveDeadline'] = solveBy;
      const solvedAt = t.solvedAt;
      // Late for the first reply: replied after the target, or not yet (or never, when solved) past it.
      const firstLate = (firstReplied ?? solvedAt ?? now) > firstBy;
      let status: string;
      if (solvedAt !== null) status = solvedAt <= solveBy && !firstLate ? 'met' : 'breached';
      else if (firstLate || now > solveBy) status = 'breached';
      else {
        const total = businessMinutesBetween(opened, solveBy, hours);
        const left = businessMinutesBetween(now, solveBy, hours);
        status = total > 0 && left < total / 5 ? 'at_risk' : 'on_track';
      }
      changes['slaStatus'] = status;
    }
    if (Object.keys(changes).length > 0)
      await env
        .model('helpdesk.ticket')
        .browse([t.id])
        .write(changes as never);
    if (state === 'open' && t.state === 'waiting') {
      await env.flush();
      await env.model('helpdesk.ticket').browse([t.id]).resume();
    }
  }
  await env.flush();
  return tickets.length;
}

/** Solved tickets of teams that ask: a rating link for the customer, sent by email when a mailer is set. */
export async function askRating(env: Env, ids: readonly number[]): Promise<void> {
  const mailer = mailerFromEnv();
  const base = process.env['KOSH_BASE_URL'] ?? '';
  for (const t of await env
    .model('helpdesk.ticket')
    .browse(ids as never)
    .load({ team: true, partner: true })) {
    if (t.team !== null && !t.team.rating) continue;
    const token = randomBytes(24).toString('base64url');
    await env
      .model('helpdesk.ticket')
      .browse([t.id])
      .write({ ratingToken: token } as never);
    const to = t.partner?.email ?? t.email;
    if (mailer === undefined || to === null || to === '') continue;
    const link = (score: number) =>
      `${base}/api/v1/public/helpdesk/rate?token=${token}&score=${score}`;
    const escapeHtml = (x: string) =>
      x.replace(
        /[&<>"]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
      );
    const intro = `Your request ${t.name} (“${t.subject}”) is solved. How was the help?`;
    await mailer
      .send({
        to,
        subject: `How did we do? ${t.name}: ${t.subject}`,
        text: [intro, ...[5, 4, 3, 2, 1].map((s) => `${'★'.repeat(s)}  ${link(s)}`)].join('\n'),
        html: `<p>${escapeHtml(intro)}</p><p>${[5, 4, 3, 2, 1]
          .map((s) => `<a href="${escapeHtml(link(s))}">${'★'.repeat(s)}</a>`)
          .join('<br>')}</p>`,
      })
      .catch(() => undefined);
  }
  await env.flush();
}

/** A rating from the link, once. @returns the ticket's reference, or `null` for an unknown or used link */
export async function rate(
  env: Env,
  token: string,
  score: number,
  comment: string | null,
): Promise<string | null> {
  if (!Number.isInteger(score) || score < 1 || score > 5) return null;
  const [t] = await (
    await env.model('helpdesk.ticket').search({ where: { ratingToken: token }, limit: 1 })
  ).load(['name', 'rating']);
  if (t === undefined || t.rating !== null) return null;
  await env
    .model('helpdesk.ticket')
    .browse([t.id])
    .write({ rating: score, ratingComment: comment, ratingToken: null } as never);
  await env.flush();
  return t.name;
}

export { orm };
