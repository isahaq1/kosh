/**
 * The IMAP poller (RFC 0006 §7.1): for installations without a webhook provider, a mailbox is read every
 * `MAIL_INBOUND_POLL_MS` (30 s) by one node at a time (a PostgreSQL advisory lock), its unseen messages handed
 * to the same handler as the webhook and marked seen once logged. `IMAP_URL` is
 * `imap://user:password@host:143/INBOX` or `imaps://…:993/INBOX` (TLS).
 */
import { ImapFlow } from 'imapflow';
import { type InboundContext, type InboundOutcome, receiveMail } from './handle.js';
import { parseMail } from './parse.js';

export interface ImapConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly mailbox: string;
}

/** The mailbox from `IMAP_URL`, or none. */
export function imapConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ImapConfig | undefined {
  const url = env['IMAP_URL'];
  if (url === undefined || url === '') return undefined;
  const parsed = new URL(url);
  const secure = parsed.protocol === 'imaps:';
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? (secure ? 993 : 143) : Number(parsed.port),
    secure,
    user: decodeURIComponent(parsed.username),
    pass: decodeURIComponent(parsed.password),
    mailbox: parsed.pathname.replace(/^\//, '') || 'INBOX',
  };
}

/** The lock key: one poller per database at a time. */
const LOCK = "hashtext('mail.inbound.imap')";

/**
 * Reads the mailbox once: every unseen message is received and marked seen. Returns what was done, or `null`
 * when another node holds the lock. A message that fails is left unseen for the next round (logged).
 */
export async function pollOnce(
  context: InboundContext,
  config: ImapConfig,
  options: {
    readonly limit?: number;
    readonly log?: (message: string, error?: unknown) => void;
  } = {},
): Promise<readonly InboundOutcome[] | null> {
  const limit = options.limit ?? 50;
  return context.driver.transaction({}, async (conn) => {
    const [lock] = await conn.query<{ ok: boolean }>({
      text: `SELECT pg_try_advisory_xact_lock(${LOCK}) AS ok`,
      params: [],
    });
    if (lock?.ok !== true) return null;
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      logger: false,
    });
    const outcomes: InboundOutcome[] = [];
    await client.connect();
    try {
      const mailbox = await client.getMailboxLock(config.mailbox);
      try {
        const uids = await client.search({ seen: false }, { uid: true });
        for (const uid of (Array.isArray(uids) ? uids : []).slice(0, limit)) {
          try {
            const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (message === false || message.source === undefined) continue;
            const raw = message.source.toString('utf8');
            const outcome = await receiveMail(context, await parseMail(raw), raw);
            outcomes.push(outcome);
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          } catch (error) {
            options.log?.(`inbound email: message ${uid} left unseen`, error);
          }
        }
      } finally {
        mailbox.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return outcomes;
  });
}

/** Starts polling in the background; `stop()` ends it after the round in progress. */
export function startPoller(
  context: InboundContext,
  config: ImapConfig,
  options: {
    readonly pollMs?: number;
    readonly log?: (message: string, error?: unknown) => void;
  } = {},
): { stop(): Promise<void> } {
  const pollMs = options.pollMs ?? 30_000;
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = pollOnce(
      context,
      config,
      options.log === undefined ? {} : { log: options.log },
    ).catch((error: unknown) => {
      options.log?.('inbound email: the mailbox could not be read', error);
    });
  };
  const timer = setInterval(tick, pollMs);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
