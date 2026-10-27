/**
 * @packageDocumentation
 * `@kosh/portal` (RFC 0015): the customer and vendor portal. Step 1 is who a portal user is — a user of one contact,
 * holding only `portal.user`, kept to the portal's API by the server — and how they get in: an invitation from a
 * portal access manager, a one-time link to choose a password, and revocation.
 */
import { contacts } from '@kosh/contacts';
import { mailerFromEnv } from '@kosh/mail';
import { defineModule, type KoshModule } from '@kosh/modules-sdk';
import { base, type ModuleContext } from '@kosh/server';
import { portalShutro } from './module.js';
import { type PortalRoutesOptions, registerPortalRoutes } from './routes.js';

export {
  PartnerPortalUsers,
  PortalInvitation,
  portalShutro,
  UserPortalPartner,
} from './module.js';
export {
  INVITATION_DAYS,
  PORTAL_USER,
  type PortalRoutesOptions,
  registerPortalRoutes,
} from './routes.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/portal',
  rfc: 'RFC 0015',
});

/** The portal module with explicit options (tests): its URL and mailer. */
export function createPortal(options: Partial<PortalRoutesOptions> = {}): KoshModule {
  return defineModule({
    shutro: portalShutro,
    kosh: '^0.1.0',
    depends: [base, contacts],
    accessLevels: { manager: { label: 'Portal access', groups: ['portal.manager'] } },
    externalGroups: ['portal.user'],
    privateModels: ['portal.invitation'],
    routes: (context: ModuleContext) =>
      registerPortalRoutes(context, {
        portalUrl: options.portalUrl ?? process.env['KOSH_PORTAL_URL'] ?? 'http://localhost:5174',
        mailer: 'mailer' in options ? options.mailer : mailerFromEnv(),
      }),
  });
}

/** The portal, configured from the environment (`KOSH_PORTAL_URL`, `SMTP_URL`). */
export const portal: KoshModule = createPortal();
