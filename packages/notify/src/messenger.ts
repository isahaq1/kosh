/**
 * The SMS and WhatsApp channels (RFC 0006 §5.4): a {@link Messenger} sends one text message to a phone number on
 * one of the two channels; {@link createTwilioMessenger} is the Twilio implementation (its Messages API over
 * `fetch`, no SDK: the one request it needs), {@link messengerFromEnv} reads `TWILIO_ACCOUNT_SID`,
 * `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM` and `TWILIO_WHATSAPP_FROM`. Both channels are opt-in per user (they
 * cost money), and a recipient needs a phone number on their user.
 */

export type TextChannel = 'sms' | 'whatsapp';

export interface TextMessage {
  readonly channel: TextChannel;
  /** E.164 (`+8801711000001`). */
  readonly to: string;
  readonly text: string;
}

/** Sends text messages; the provider's id of each, when it gives one. */
export interface Messenger {
  readonly name: string;
  /** The channels this provider is set up for. */
  readonly channels: readonly TextChannel[];
  send(message: TextMessage): Promise<{ readonly id: string | null }>;
}

export interface TwilioOptions {
  readonly accountSid: string;
  readonly authToken: string;
  /** The sender numbers per channel (`+1…`; WhatsApp without the `whatsapp:` prefix). */
  readonly from: { readonly sms?: string | undefined; readonly whatsapp?: string | undefined };
  /** The API root (tests point it at a local server). */
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
}

/** A phone number in E.164: a plus and 8 to 15 digits, spaces and dashes removed. */
export function normalizePhone(value: string): string | null {
  const digits = value.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** The Twilio messenger: one request per message, basic authentication, a form body. */
export function createTwilioMessenger(options: TwilioOptions): Messenger {
  const base = (options.baseUrl ?? 'https://api.twilio.com').replace(/\/$/, '');
  const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`;
  const doFetch = options.fetch ?? fetch;
  const channels: TextChannel[] = [];
  if (options.from.sms !== undefined && options.from.sms !== '') channels.push('sms');
  if (options.from.whatsapp !== undefined && options.from.whatsapp !== '')
    channels.push('whatsapp');
  return {
    name: 'twilio',
    channels,
    async send(message) {
      const from = message.channel === 'whatsapp' ? options.from.whatsapp : options.from.sms;
      if (from === undefined || from === '')
        throw new Error(`Twilio: no sender number for ${message.channel}.`);
      const prefix = message.channel === 'whatsapp' ? 'whatsapp:' : '';
      const body = new URLSearchParams({
        To: `${prefix}${message.to}`,
        From: `${prefix}${from}`,
        Body: message.text,
      });
      const response = await doFetch(url, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const text = await response.text();
      if (!response.ok) {
        let detail = text.slice(0, 300);
        try {
          const json = JSON.parse(text) as { message?: unknown; code?: unknown };
          if (typeof json.message === 'string')
            detail = `${String(json.code ?? '')} ${json.message}`.trim();
        } catch {
          // not JSON: the text as it came
        }
        throw new Error(`Twilio answered ${response.status}: ${detail}`);
      }
      try {
        const json = JSON.parse(text) as { sid?: unknown };
        return { id: typeof json.sid === 'string' ? json.sid : null };
      } catch {
        return { id: null };
      }
    },
  };
}

/** A messenger from the environment, or none when neither channel is configured. */
export function messengerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Messenger | undefined {
  const accountSid = env['TWILIO_ACCOUNT_SID'];
  const authToken = env['TWILIO_AUTH_TOKEN'];
  const sms = env['TWILIO_SMS_FROM'];
  const whatsapp = env['TWILIO_WHATSAPP_FROM'];
  if (!accountSid || !authToken || (!sms && !whatsapp)) return undefined;
  return createTwilioMessenger({ accountSid, authToken, from: { sms, whatsapp } });
}

/** A messenger that keeps what it is given (tests, dry runs); `fail` makes a channel refuse. */
export function createMemoryMessenger(
  channels: readonly TextChannel[] = ['sms', 'whatsapp'],
  fail?: (message: TextMessage) => string | null,
): Messenger & { readonly sent: TextMessage[] } {
  const sent: TextMessage[] = [];
  return {
    name: 'memory',
    channels,
    sent,
    async send(message) {
      const problem = fail?.(message) ?? null;
      if (problem !== null) throw new Error(problem);
      sent.push(message);
      return { id: `memory-${sent.length}` };
    },
  };
}
