/**
 * The data layer of Sales in the portal (RFC 0015 §5.4): portal users read the quotations and orders of their
 * contact and company (the portal's record rule) and nothing else of Sales. Their lines, partners and products are
 * read by the portal itself, once a record is known to be theirs.
 */
import { portalRule, portalShutro } from '@kosh/portal';
import { salesShutro } from '@kosh/sales';
import { defineModule, extendModel } from './.kosh/bindings.js';

export const OrderPortal = extendModel('sale.order', {
  access: { 'portal.user': ['read'] },
  rules: { portal: portalRule('partner') },
});

export const salePortalShutro = defineModule({
  name: 'sale_portal',
  version: '0.1.0',
  depends: [salesShutro, portalShutro],
  models: [],
  extensions: [OrderPortal],
});
