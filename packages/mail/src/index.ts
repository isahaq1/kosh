/**
 * @packageDocumentation
 * `@kosh/mail` (RFC 0006 §5.4): outbound email. A {@link Mailer} sends one message; {@link createSmtpMailer} is the
 * SMTP implementation (nodemailer: the one dependency, for SMTP with STARTTLS and authentication), and
 * {@link mailerFromEnv} reads `SMTP_URL` and `MAIL_FROM`. In development, `SMTP_URL=smtp://localhost:1025` points at
 * Mailpit (`pnpm dev:services`, inbox on http://localhost:8025). Templates and inbound email come next.
 */
import nodemailer from 'nodemailer';

/** One outbound message. */
export interface OutboundMail {
  readonly to: string;
  readonly subject: string;
  /** The plain-text part (every message has one). */
  readonly text: string;
  readonly html: string;
  readonly replyTo?: string;
}

/** Sends messages; the provider's id of each, when it gives one. */
export interface Mailer {
  readonly name: string;
  readonly from: string;
  send(mail: OutboundMail): Promise<{ readonly id: string | null }>;
}

/** The SMTP mailer: `url` is `smtp://user:pass@host:port` (or `smtps://` for implicit TLS). */
export function createSmtpMailer(options: { readonly url: string; readonly from: string }): Mailer {
  const transport = nodemailer.createTransport(options.url);
  return {
    name: 'smtp',
    from: options.from,
    async send(mail) {
      const info = await transport.sendMail({
        from: options.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(mail.replyTo === undefined ? {} : { replyTo: mail.replyTo }),
      });
      return { id: typeof info.messageId === 'string' ? info.messageId : null };
    },
  };
}

/** A mailer from the environment (`SMTP_URL`, `MAIL_FROM`), or none when email is not configured. */
export function mailerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Mailer | undefined {
  const url = env['SMTP_URL'];
  if (url === undefined || url === '') return undefined;
  return createSmtpMailer({ url, from: env['MAIL_FROM'] ?? 'Kosh <kosh@localhost>' });
}

/** A mailer that keeps what it is given (tests, dry runs). */
export function createMemoryMailer(): Mailer & { readonly sent: OutboundMail[] } {
  const sent: OutboundMail[] = [];
  return {
    name: 'memory',
    from: 'Kosh <kosh@localhost>',
    sent,
    async send(mail) {
      sent.push(mail);
      return { id: `memory-${sent.length}` };
    },
  };
}

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * A plain, readable HTML email: a title, paragraphs, an optional button. Inline styles only (mail clients), a
 * `dir` for right-to-left languages, and nothing that needs images or scripts.
 */
export function layout(input: {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly url: string };
  readonly footer?: string;
  readonly lang?: string;
  readonly dir?: 'ltr' | 'rtl';
}): { readonly html: string; readonly text: string } {
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="${e(input.lang ?? 'en')}" dir="${input.dir ?? 'ltr'}">
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 16px;font-size:18px">${e(input.title)}</h1>
    ${input.paragraphs.map((p) => `<p style="margin:0 0 12px;line-height:1.5">${e(p)}</p>`).join('\n    ')}
    ${
      input.action === undefined
        ? ''
        : `<p style="margin:20px 0 0"><a href="${e(input.action.url)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">${e(input.action.label)}</a></p>`
    }
    ${input.footer === undefined ? '' : `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${e(input.footer)}</p>`}
  </div>
</body>
</html>
`;
  const text = [
    input.title,
    '',
    ...input.paragraphs,
    ...(input.action === undefined ? [] : ['', `${input.action.label}: ${input.action.url}`]),
    ...(input.footer === undefined ? [] : ['', input.footer]),
  ].join('\n');
  return { html, text };
}

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/mail',
  rfc: 'RFC 0006',
});
