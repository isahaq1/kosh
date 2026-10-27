/**
 * The data layer of Accounting in the portal (RFC 0015 §5.4): portal users read the posted invoices, credit notes
 * and bills of their contact and company (the portal's record rule) and nothing else of the ledger.
 */
import { accountingShutro } from '@kosh/accounting';
import { portalRule, portalShutro } from '@kosh/portal';
import { defineModule, extendModel } from './.kosh/bindings.js';

export const MovePortal = extendModel('account.move', {
  access: { 'portal.user': ['read'] },
  rules: { portal: portalRule('partner') },
});

export const accountPortalShutro = defineModule({
  name: 'account_portal',
  version: '0.1.0',
  depends: [accountingShutro, portalShutro],
  models: [],
  extensions: [MovePortal],
});
