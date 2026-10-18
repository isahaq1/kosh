/**
 * @packageDocumentation
 * `@kosh/jobs`: Job queue, scheduler and retries. Designed in RFC 0006 (docs/rfcs); implementation follows its approval.
 */

/** Package identity, until the RFC 0006 implementation lands. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/jobs',
  rfc: 'RFC 0006',
});
