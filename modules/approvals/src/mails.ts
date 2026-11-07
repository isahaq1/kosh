/**
 * Approvals by email (RFC 0025 §3.4): whoever may decide a request now — when it is asked, when its turn comes after
 * a lower level, when it is reminded at half its deadline or escalated once late — gets an email with a link of their
 * own (single use, seven days; only its digest kept) to a page that confirms the decision. A link decides nothing by
 * being opened: mail scanners follow links. Sent after the commit; a failed send is logged.
 */
import { layout, type Mailer } from '@kosh/mail';
import { type ApprovalRequestInfo, issueLinks, turnOf } from '@kosh/permissions';
import { digest, randomToken } from '@kosh/server';
import type { Env } from '@kosh/server/orm';

type Row = Record<string, unknown>;
interface Rows {
  readonly length: number;
  load(keys: readonly string[]): Promise<{ read(keys: readonly string[]): Row[] }>;
}
const ref = (env: Env, name: string) =>
  env.model(name as never) as unknown as {
    search(q: unknown): Promise<Rows>;
    browse(ids: readonly number[]): Rows;
  };
const read = async (rows: Rows, keys: string[]) =>
  rows.length === 0 ? [] : (await rows.load(keys)).read(keys);

let config: { mailer: Mailer | undefined; apiUrl: string; log: (m: string, e: unknown) => void } = {
  mailer: undefined,
  apiUrl: 'http://localhost:3000',
  log: () => undefined,
};
export function configureMails(next: Partial<typeof config>): void {
  config = { ...config, ...next };
}

const WHY = {
  asked: (who: string, record: string) => `${who} asks you to approve ${record}`,
  reminded: (_who: string, record: string) => `Reminder: ${record} waits for your approval`,
  escalated: (_who: string, record: string) => `${record} is late: you may decide it now`,
  added: (who: string, record: string) => `${who} waits for your approval of ${record}`,
  backup: (_who: string, record: string) => `As a backup approver: ${record} waits for a decision`,
} as const;

/**
 * Emails each person who may decide `requests` now a link of their own (only `only`, when given: the people added
 * to a request, its backups); for a new turn, skips requests already sent links.
 */
export async function mailDeciders(
  su: Env,
  requests: readonly ApprovalRequestInfo[],
  why: keyof typeof WHY,
  only?: readonly number[],
): Promise<number> {
  const mailer = config.mailer;
  let sent = 0;
  for (const request of requests) {
    if (why === 'asked') {
      const existing = await ref(su, 'approval.link').search({
        where: { request: request.id },
        limit: 1,
      });
      if (existing.length > 0) continue;
    }
    const links = await issueLinks(su, request, su.today(), () => randomToken(24), digest, only);
    if (links.length === 0) continue;
    const [record] = await read(
      await ref(su, request.targetModel)
        .search({ where: { id: request.targetId }, limit: 1 })
        .catch(() => ({ length: 0 }) as Rows),
      ['displayName'],
    );
    const name = String(record?.['displayName'] ?? `#${request.targetId}`);
    const [asker] =
      request.requestedBy === null
        ? []
        : await read(ref(su, 'res.users').browse([request.requestedBy]), ['name']);
    const who = String(asker?.['name'] ?? 'Someone');
    const users = new Map(
      (await read(ref(su, 'res.users').browse(links.map((l) => l.user)), ['email', 'login'])).map(
        (u) => [
          u['id'] as number,
          String(u['email'] ?? (String(u['login'] ?? '').includes('@') ? u['login'] : '')),
        ],
      ),
    );
    for (const link of links) {
      const to = users.get(link.user) ?? '';
      if (to === '' || mailer === undefined) continue;
      const subject = WHY[why](who, name);
      const body = layout({
        title: subject,
        paragraphs: [
          `${request.levelName}${request.required > 1 ? ` (${request.approvals} of ${request.required} approvals so far)` : ''}.`,
          'The link is yours alone and works once; it opens a page where you approve, reject or send it back.',
        ],
        action: {
          label: 'Review and decide',
          url: `${config.apiUrl}/api/v1/public/approvals/${link.token}`,
        },
      });
      su.afterCommit(async () => {
        await mailer
          .send({ to, subject, html: body.html, text: body.text })
          .catch((error: unknown) => config.log('approval email not sent', error));
      });
      sent += 1;
    }
  }
  return sent;
}

/** After a record's approvals were asked, or one of its levels approved: the requests whose turn it is now. */
export async function mailTurn(su: Env, model: string, id: number): Promise<number> {
  return mailDeciders(su, await turnOf(su, model, id), 'asked');
}
