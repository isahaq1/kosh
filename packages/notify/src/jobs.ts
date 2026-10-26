/** The notification jobs (RFC 0006 §5.4, §8.3) and what they share. */

/** Sends one delivery. */
export const DELIVER_JOB = 'notify.deliver';
/** Sends a user's daily digest: `{ user }`, keyed by the user and the digest's local date. */
export const DIGEST_JOB = 'notify.digest';
/** Attempts of a job before Shutro marks it dead (its default): the last one falls back instead of retrying. */
export const MAX_ATTEMPTS = 5;

/** How a kind reaches a user by email (RFC 0006 §8.1). */
export type EmailMode = 'instant' | 'daily' | 'off';
