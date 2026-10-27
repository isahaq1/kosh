/**
 * The data layer of Purchase in the portal (RFC 0015 §5.4): vendors' portal users read the requests for quotation
 * and orders of their contact and company (the portal's record rule) and nothing else of Purchase.
 */
import { portalRule, portalShutro } from '@kosh/portal';
import { purchaseShutro } from '@kosh/purchase';
import { defineModule, extendModel } from './.kosh/bindings.js';

export const PurchaseOrderPortal = extendModel('purchase.order', {
  access: { 'portal.user': ['read'] },
  rules: { portal: portalRule('partner') },
});

export const purchasePortalShutro = defineModule({
  name: 'purchase_portal',
  version: '0.1.0',
  depends: [purchaseShutro, portalShutro],
  models: [],
  extensions: [PurchaseOrderPortal],
});
