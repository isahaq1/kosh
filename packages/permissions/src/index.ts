/**
 * @packageDocumentation
 * `@isahaq/kosh-permissions` (RFC 0003): administration of roles, access, rules, field security, permissions, per-company
 * assignments and special grants on Shutro's security engine, multi-level approvals, and the security audit log.
 * Enforcement stays in Shutro (every query) and the server (sessions, 2FA, navigation, exports).
 */
import { defineModule } from '@isahaq/kosh-modules-sdk';
import { base, type ModuleContext } from '@isahaq/kosh-server';
import { registerAdminApi } from './admin.js';
import { permissionsShutro } from './models.js';
import { registerApprovalRoutes } from './routes.js';

export { registerAdminApi } from './admin.js';
export {
  type ApprovalRequestInfo,
  approvalGuard,
  approvalState,
  decide,
  inbox,
  installApprovalPolicies,
  requestApprovals,
  requestsOf,
} from './approvals.js';
export { permissionsShutro } from './models.js';
export { registerApprovalRoutes } from './routes.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@isahaq/kosh-permissions',
  rfc: 'RFC 0003',
});

/** The Kosh module: depend on it from modules that use approvals; install it for the admin APIs. */
export const permissions: ReturnType<typeof defineModule> = defineModule({
  shutro: permissionsShutro,
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: {
    auditor: { label: 'Security auditor', groups: ['permissions.auditor'] },
  },
  privateModels: ['approval.request'],
  routes: (context: ModuleContext) => {
    registerAdminApi(context);
    registerApprovalRoutes(context);
  },
});
