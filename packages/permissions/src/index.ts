/**
 * @packageDocumentation
 * `@kosh/permissions` (RFC 0003): administration of roles, access, rules, field security, permissions, per-company
 * assignments and special grants on Shutro's security engine, multi-level approvals, and the security audit log.
 * Enforcement stays in Shutro (every query) and the server (sessions, 2FA, navigation, exports).
 */
import { defineModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import type { Env } from '@kosh/server/orm';
import { registerAdminApi } from './admin.js';
import { installApprovalPolicies } from './approvals.js';
import { permissionsShutro } from './models.js';
import { registerRoleRoutes } from './roles.js';
import { registerApprovalRoutes } from './routes.js';

export { registerAdminApi } from './admin.js';
export {
  APPROVER_KEYS,
  type ApprovalCard,
  type ApprovalRequestInfo,
  approvalCards,
  approvalGuard,
  approvalState,
  approvalStats,
  approveMany,
  type Decision,
  decide,
  decidersOf,
  eventsOf,
  groupsOf,
  inbox,
  installApprovalPolicies,
  issueLinks,
  linkOf,
  notifyBackups,
  previewPolicy,
  reassign,
  requestApprovals,
  requestsOf,
  sweepDeadlines,
  syncLevels,
  turnOf,
  useLink,
  type Who,
  whoIs,
  withdraw,
} from './approvals.js';
export { permissionsShutro } from './models.js';
export { registerRoleRoutes } from './roles.js';
export { registerApprovalRoutes } from './routes.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/permissions',
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
  privateModels: ['approval.request', 'approval.vote', 'approval.link', 'approval.event'],
  hooks: {
    defaults: async (env, modules) => {
      const n = await installApprovalPolicies(env as Env, modules);
      return `${n} approval polic${n === 1 ? 'y' : 'ies'} installed`;
    },
  },
  routes: (context: ModuleContext) => {
    registerAdminApi(context);
    registerRoleRoutes(context);
    registerApprovalRoutes(context);
  },
});
