/**
 * The record rule that keeps a document to its customer (RFC 0015 §5.1): a portal user sees the documents of their
 * contact and of the company their contact works for — the company's own, and those of its other people. Bridges
 * add it to the models they show in the portal (`extendModel(…, { rules: { portal: portalRule('partner') } })`).
 */

/** Holders of `portal.user` whose contact or company is the record's `partner`. */
export function portalRule(partner: string): {
  readonly groups: readonly string[];
  readonly perms: readonly ['read'];
  readonly domain: Readonly<Record<string, unknown>>;
} {
  const me = { portalUsers: { any: { id: { $env: 'uid' } } } };
  return {
    groups: ['portal.user'],
    perms: ['read'],
    domain: {
      or: [
        // Their own contact, or (a company's portal user) the company itself.
        { [`${partner}.portalUsers`]: me.portalUsers },
        // A person of the company whose portal user they are.
        { [`${partner}.parent.portalUsers`]: me.portalUsers },
        // Their company (the contact's parent).
        { [`${partner}.contacts`]: { any: me } },
        // A colleague at their company.
        { [`${partner}.parent.contacts`]: { any: me } },
      ],
    },
  };
}
