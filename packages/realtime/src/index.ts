/**
 * @packageDocumentation
 * `@isahaq/kosh-realtime`: WebSocket gateway (LISTEN/NOTIFY + Valkey pub/sub). Designed in RFC 0006 (docs/rfcs); implementation follows its approval.
 */

/** Package identity, until the RFC 0006 implementation lands. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@isahaq/kosh-realtime',
  rfc: 'RFC 0006',
});
