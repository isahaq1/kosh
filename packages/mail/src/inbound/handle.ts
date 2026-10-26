/**
 * Receiving an inbound message (RFC 0006 §7.1): logged once by its Message-ID; automatic messages dropped (a
 * bounce of a message of ours marks its delivery); the target found from the reply address's token, else from
 * `In-Reply-To` / `References` against the Message-IDs we sent; the sender checked against the recipient the
 * token names (posted **as that user**, under their rules) or against the record's partner (posted as the system,
 * with the sender named); anything else is quarantined for an administrator to attach by hand or discard.
 */
import {
  type ChatterContext,
  type MessageItem,
  postExternalMessage,
  postMessage,
} from '@kosh/messaging';
import { type AuthService, HttpProblem, type KoshRegistry } from '@kosh/server';
import type { Driver, Env, Shutro } from '@kosh/server/orm';
import { type Storage, saveAttachment } from '@kosh/storage';
import { bodyText, type InboundMail } from './parse.js';
import { type InboundConfig, parseReplyAddress, type ReplyTarget } from './token.js';

type Row = Record<string, unknown>;
interface Rows {
  readonly ids: readonly number[];
  readonly length: number;
  load(keys: readonly string[]): Promise<Rows & { read(keys: readonly string[]): Row[] }>;
  write(values: unknown): Promise<void>;
}
interface Ref {
  search(q: unknown): Promise<Rows>;
  browse(ids: readonly number[]): Rows;
  create(rows: readonly unknown[]): Promise<Rows>;
}
const ref = (env: Env, name: string): Ref => env.model(name as never) as unknown as Ref;
async function rows(env: Env, model: string, where: unknown, keys: string[]): Promise<Row[]> {
  const found = await ref(env, model).search({ where });
  return found.length === 0 ? [] : (await found.load(keys)).read(['id', ...keys]);
}

/** What receiving needs from the server. */
export interface InboundContext {
  readonly shutro: Shutro;
  readonly driver: Driver;
  readonly registry: KoshRegistry;
  readonly auth: AuthService | undefined;
  /** Where attachments go; without it, attachments are left out (noted on the log row). */
  readonly storage?: Storage | undefined;
  /** The reply address settings; without them only `In-Reply-To` resolves a target. */
  readonly config?: InboundConfig | undefined;
  /** The chatter's view of the served models (`chatterContext`). */
  readonly chatter: ChatterContext;
}

export interface InboundOutcome {
  readonly id: number;
  readonly state: 'received' | 'posted' | 'quarantined' | 'discarded' | 'dropped';
  readonly reason: string | null;
  readonly model: string | null;
  readonly resId: number | null;
  readonly message: number | null;
  /** The same Message-ID was received before: nothing was done again. */
  readonly duplicate: boolean;
}

const MAX_RAW = 1_000_000;

/** The models of the served set, for the attachment and chatter helpers. */
const modelsOf = (context: InboundContext): ReadonlySet<string> =>
  new Set(context.chatter.models.keys());

/** Saves the message's attachments on the record as `env` (skipping inline images without a file name). */
async function saveFiles(
  context: InboundContext,
  env: Env,
  mail: InboundMail,
  model: string,
  id: number,
): Promise<number[]> {
  if (context.storage === undefined) return [];
  const ids: number[] = [];
  for (const a of mail.attachments) {
    if (a.data.byteLength === 0) continue;
    const saved = await saveAttachment(env, context.storage, modelsOf(context), {
      model,
      id,
      name: a.name,
      mime: a.mime,
      data: a.data,
    });
    ids.push(saved.id);
  }
  return ids;
}

/** The target a message names: a reply address of ours, else a reply to a message we sent. */
async function targetOf(
  context: InboundContext,
  su: Env,
  mail: InboundMail,
): Promise<ReplyTarget | null> {
  if (context.config !== undefined)
    for (const to of mail.to) {
      const target = parseReplyAddress(context.config, to);
      if (target !== null) return target;
    }
  const ids = [
    ...new Set(
      [mail.inReplyTo, ...mail.references].filter((r): r is string => r !== null && r !== ''),
    ),
  ];
  if (ids.length === 0 || !context.registry.registry.models.has('notify.delivery' as never))
    return null;
  const deliveries = await rows(
    su,
    'notify.delivery',
    { providerId: { in: ids }, channel: 'email' },
    ['notification'],
  );
  for (const d of deliveries) {
    const [n] = await rows(su, 'notify.notification', { id: d['notification'] }, [
      'resModel',
      'resId',
      'user',
    ]);
    if (
      n !== undefined &&
      typeof n['resModel'] === 'string' &&
      typeof n['resId'] === 'number' &&
      typeof n['user'] === 'number'
    )
      return { model: n['resModel'], id: n['resId'], uid: n['user'] };
  }
  return null;
}

/** Posts as the user named by the target: their rules decide; `null` when they may not read the record. */
async function postAsUser(
  context: InboundContext,
  target: ReplyTarget,
  mail: InboundMail,
  text: string,
): Promise<MessageItem | null> {
  const info = await context.auth?.verify(target.uid).catch(() => null);
  if (info === null || info === undefined) return null;
  const user = await context.shutro.bootstrap({ reason: 'inbound email' }, async (su) => {
    const [u] = await rows(su, 'res.users', { id: target.uid }, ['company', 'lang', 'tz']);
    return u;
  });
  if (user === undefined) return null;
  const company =
    typeof user['company'] === 'number'
      ? user['company']
      : (info.companies[0] as number | undefined);
  if (company === undefined) return null;
  const companies = info.companies.includes(company)
    ? info.companies
    : [company, ...info.companies];
  try {
    return await context.shutro.run(
      {
        user: target.uid,
        company,
        companies,
        groups: info.groups,
        ...(info.grants === undefined ? {} : { grants: info.grants }),
        lang: typeof user['lang'] === 'string' ? user['lang'] : 'en_US',
        tz: typeof user['tz'] === 'string' ? user['tz'] : 'UTC',
        reason: `inbound email ${mail.messageId}`,
      },
      async (env) => {
        const attachments = await saveFiles(context, env, mail, target.model, target.id);
        return postMessage(env, context.chatter, target.model, target.id, {
          kind: 'comment',
          text,
          attachments,
        });
      },
    );
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    const status = (error as { status?: unknown }).status;
    if (name === 'AccessError' || status === 403 || status === 404) return null;
    throw error;
  }
}

/** The email addresses the record knows: its partner's, and its followers'. */
async function knownAddresses(
  context: InboundContext,
  su: Env,
  model: string,
  id: number,
): Promise<Set<string>> {
  const out = new Set<string>();
  const fields = context.chatter.models.get(model);
  if (fields?.get('partner')?.target === 'res.partner') {
    const [record] = (await ref(su, model).browse([id]).load(['partner'])).read(['partner']);
    const partner = record?.['partner'];
    if (typeof partner === 'number') {
      const [p] = await rows(su, 'res.partner', { id: partner }, ['email']);
      if (typeof p?.['email'] === 'string' && p['email'] !== '') out.add(p['email'].toLowerCase());
    }
  }
  const followers = await rows(su, 'mail.follower', { resModel: model, resId: id }, ['user']);
  const users = followers.map((f) => f['user']).filter((u): u is number => typeof u === 'number');
  if (users.length > 0)
    for (const u of await rows(su, 'res.users', { id: { in: users } }, ['email']))
      if (typeof u['email'] === 'string' && u['email'] !== '') out.add(u['email'].toLowerCase());
  return out;
}

/** Posts as the system, naming the sender (a partner's reply). */
async function postAsSender(
  context: InboundContext,
  su: Env,
  mail: InboundMail,
  model: string,
  id: number,
  text: string,
): Promise<MessageItem> {
  const attachments = await saveFiles(context, su, mail, model, id);
  return postExternalMessage(su, context.chatter, model, id, {
    text,
    authorEmail: mail.from?.address ?? '',
    authorName: mail.from?.name ?? '',
    attachments,
  });
}

/** Receives one message: logs it once, posts it where it belongs, or quarantines it. */
export async function receiveMail(
  context: InboundContext,
  mail: InboundMail,
  raw: string | null,
): Promise<InboundOutcome> {
  // 1. The log row, exactly once per Message-ID (the unique index decides under concurrency).
  const logged = await context.shutro.bootstrap({ reason: 'inbound email' }, async (su) => {
    const [existing] = await rows(su, 'mail.inbound_message', { messageId: mail.messageId }, [
      'state',
      'reason',
      'resModel',
      'resId',
      'postedMessage',
    ]);
    if (existing !== undefined)
      return { duplicate: true as const, id: existing['id'] as number, row: existing };
    const created = await ref(su, 'mail.inbound_message').create([
      {
        messageId: mail.messageId,
        from: mail.from?.address ?? null,
        fromName: mail.from?.name ?? null,
        to: mail.to.join(', '),
        subject: mail.subject.slice(0, 998),
        text: bodyText(mail),
        html: mail.html,
        attachmentCount: mail.attachments.length,
        raw: raw === null || raw.length > MAX_RAW ? null : raw,
      },
    ]);
    return { duplicate: false as const, id: created.ids[0] as number, row: null };
  });
  if (logged.duplicate) {
    const row = logged.row as Row;
    return {
      id: logged.id,
      state: row['state'] as InboundOutcome['state'],
      reason: (row['reason'] as string | null) ?? null,
      model: (row['resModel'] as string | null) ?? null,
      resId: (row['resId'] as number | null) ?? null,
      message: (row['postedMessage'] as number | null) ?? null,
      duplicate: true,
    };
  }
  return processInbound(context, logged.id, mail);
}

/** Works out what to do with a logged message and records the outcome (a retry runs this again). */
export async function processInbound(
  context: InboundContext,
  logId: number,
  mail: InboundMail,
): Promise<InboundOutcome> {
  const text = bodyText(mail);
  const finish = (outcome: Omit<InboundOutcome, 'id' | 'duplicate'>): Promise<InboundOutcome> =>
    context.shutro.bootstrap({ reason: 'inbound email' }, async (su) => {
      await ref(su, 'mail.inbound_message').browse([logId]).write({
        state: outcome.state,
        reason: outcome.reason,
        resModel: outcome.model,
        resId: outcome.resId,
        postedMessage: outcome.message,
      });
      return { ...outcome, id: logId, duplicate: false };
    });
  // 2. Automatic messages never post; a bounce of ours marks its delivery.
  if (mail.automatic) {
    if (mail.bounce && mail.inReplyTo !== null)
      await context.driver.query({
        text: `UPDATE notify_delivery SET error = $2 WHERE provider_id = $1 AND channel = 'email'`,
        params: [mail.inReplyTo, `bounced: ${mail.subject.slice(0, 200)}`],
      });
    return finish({
      state: 'dropped',
      reason: 'automatic',
      model: null,
      resId: null,
      message: null,
    });
  }
  // 3. The target, and who is writing.
  const target = await context.shutro.bootstrap({ reason: 'inbound email' }, (su) =>
    targetOf(context, su, mail),
  );
  if (target === null)
    return finish({
      state: 'quarantined',
      reason: 'no-target',
      model: null,
      resId: null,
      message: null,
    });
  await context.shutro.bootstrap({ reason: 'inbound email' }, (su) =>
    ref(su, 'mail.inbound_message')
      .browse([logId])
      .write({ recipient: target.uid, resModel: target.model, resId: target.id }),
  );
  const sender = mail.from?.address ?? '';
  if (text === '' && mail.attachments.length === 0)
    return finish({
      state: 'quarantined',
      reason: 'empty',
      model: target.model,
      resId: target.id,
      message: null,
    });
  const recipientEmail = await context.shutro.bootstrap({ reason: 'inbound email' }, async (su) => {
    const [user] = await rows(su, 'res.users', { id: target.uid, active: { in: [true, false] } }, [
      'email',
    ]);
    return typeof user?.['email'] === 'string' ? user['email'].toLowerCase() : '';
  });
  if (sender !== '' && sender === recipientEmail) {
    const posted = await postAsUser(context, target, mail, text);
    if (posted === null)
      return finish({
        state: 'quarantined',
        reason: 'no-access',
        model: target.model,
        resId: target.id,
        message: null,
      });
    return finish({
      state: 'posted',
      reason: null,
      model: target.model,
      resId: target.id,
      message: posted.id,
    });
  }
  const known = await context.shutro.bootstrap({ reason: 'inbound email' }, (su) =>
    knownAddresses(context, su, target.model, target.id),
  );
  if (sender !== '' && known.has(sender)) {
    const posted = await context.shutro.bootstrap(
      { reason: `inbound email from ${sender}` },
      (su) => postAsSender(context, su, mail, target.model, target.id, text),
    );
    return finish({
      state: 'posted',
      reason: null,
      model: target.model,
      resId: target.id,
      message: posted.id,
    });
  }
  return finish({
    state: 'quarantined',
    reason: 'sender-unknown',
    model: target.model,
    resId: target.id,
    message: null,
  });
}

/** A quarantined message, as the administration page lists it. */
export interface InboundItem {
  readonly id: number;
  readonly messageId: string;
  readonly from: string | null;
  readonly fromName: string | null;
  readonly to: string | null;
  readonly subject: string | null;
  readonly text: string | null;
  readonly html: string | null;
  readonly receivedAt: string | null;
  readonly state: string;
  readonly reason: string | null;
  readonly resModel: string | null;
  readonly resId: number | null;
  readonly message: number | null;
  readonly attachmentCount: number;
}

const ITEM_KEYS = [
  'messageId',
  'from',
  'fromName',
  'to',
  'subject',
  'text',
  'html',
  'receivedAt',
  'state',
  'reason',
  'resModel',
  'resId',
  'postedMessage',
  'attachmentCount',
];
const item = (r: Row): InboundItem => ({
  id: r['id'] as number,
  messageId: String(r['messageId']),
  from: (r['from'] as string | null) ?? null,
  fromName: (r['fromName'] as string | null) ?? null,
  to: (r['to'] as string | null) ?? null,
  subject: (r['subject'] as string | null) ?? null,
  text: (r['text'] as string | null) ?? null,
  html: (r['html'] as string | null) ?? null,
  receivedAt: r['receivedAt'] instanceof Date ? r['receivedAt'].toISOString() : null,
  state: String(r['state']),
  reason: (r['reason'] as string | null) ?? null,
  resModel: (r['resModel'] as string | null) ?? null,
  resId: (r['resId'] as number | null) ?? null,
  message: (r['postedMessage'] as number | null) ?? null,
  attachmentCount: Number(r['attachmentCount'] ?? 0),
});

/** The log, newest first, by state (`mail.manager`: the model's ACL). */
export async function listInbound(
  env: Env,
  state: string | undefined,
  limit = 50,
): Promise<InboundItem[]> {
  const found = await ref(env, 'mail.inbound_message').search({
    where: state === undefined ? {} : { state },
    order: ['id desc'],
    limit,
  });
  return found.length === 0
    ? []
    : (await found.load(ITEM_KEYS)).read(['id', ...ITEM_KEYS]).map(item);
}

/** One row of the log as the caller sees it (404 when the rules hide it). */
async function logged(env: Env, id: number): Promise<Row> {
  const [row] = await rows(env, 'mail.inbound_message', { id }, [...ITEM_KEYS, 'raw']);
  if (row === undefined)
    throw new HttpProblem(404, 'missing-record', 'Not found', 'No such inbound message.');
  return row;
}

/**
 * Attaches a quarantined message to a record by hand: posted as the system naming the sender, on a record the
 * administrator can read themselves (checked as the caller).
 */
export async function attachInbound(
  context: InboundContext,
  env: Env,
  id: number,
  target: { readonly model: string; readonly id: number },
): Promise<InboundItem> {
  const row = await logged(env, id);
  if (row['state'] === 'posted')
    throw new HttpProblem(409, 'conflict', 'Conflict', 'Already posted.');
  if (!modelsOf(context).has(target.model))
    throw new HttpProblem(404, 'unknown-model', 'Unknown model', `No model '${target.model}'.`);
  await ref(env, target.model).browse([target.id]).load(['id']); // as the caller: ACL and rules
  const mail: InboundMail = {
    messageId: String(row['messageId']),
    from:
      typeof row['from'] === 'string'
        ? { name: String(row['fromName'] ?? ''), address: row['from'] }
        : null,
    to: [],
    subject: String(row['subject'] ?? ''),
    text: String(row['text'] ?? ''),
    html: (row['html'] as string | null) ?? null,
    inReplyTo: null,
    references: [],
    date: null,
    attachments: [],
    automatic: false,
    bounce: false,
  };
  // Attachments come back from the raw source when it was kept.
  const raw = row['raw'];
  const withFiles =
    typeof raw === 'string' && raw !== '' && !raw.startsWith('{')
      ? { ...mail, attachments: (await (await import('./parse.js')).parseMail(raw)).attachments }
      : mail;
  const posted = await env.asSuperuser(
    { reason: `inbound email ${mail.messageId} attached by ${env.uid}` },
    (su) => postAsSender(context, su, withFiles, target.model, target.id, bodyText(withFiles)),
  );
  await ref(env, 'mail.inbound_message').browse([id]).write({
    state: 'posted',
    reason: null,
    resModel: target.model,
    resId: target.id,
    postedMessage: posted.id,
  });
  return item(await logged(env, id));
}

/** Discards a quarantined message. */
export async function discardInbound(env: Env, id: number): Promise<InboundItem> {
  const row = await logged(env, id);
  if (row['state'] === 'posted')
    throw new HttpProblem(409, 'conflict', 'Conflict', 'Already posted.');
  await ref(env, 'mail.inbound_message').browse([id]).write({ state: 'discarded' });
  return item(await logged(env, id));
}

/** Runs the resolution again on a logged message (after fixing a user's address, for example). */
export async function retryInbound(
  context: InboundContext,
  env: Env,
  id: number,
): Promise<InboundOutcome> {
  const row = await logged(env, id);
  if (row['state'] === 'posted')
    throw new HttpProblem(409, 'conflict', 'Conflict', 'Already posted.');
  const raw = row['raw'];
  if (typeof raw !== 'string' || raw === '')
    throw new HttpProblem(409, 'conflict', 'Conflict', 'The source of this message was not kept.');
  const { parseInbound } = await import('./parse.js');
  const mail = await parseInbound(raw, raw.startsWith('{') ? 'application/json' : 'message/rfc822');
  return processInbound(context, id, mail);
}
