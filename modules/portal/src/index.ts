/**
 * @packageDocumentation
 * `@kosh/portal` (RFC 0015): the customer and vendor portal. Step 1 is who a portal user is — a user of one contact,
 * holding only `portal.user`, kept to the portal's API by the server — and how they get in: an invitation from a
 * portal access manager, a one-time link to choose a password, and revocation.
 */
import { contacts } from '@kosh/contacts';
import { mailerFromEnv } from '@kosh/mail';
import { messaging } from '@kosh/messaging';
import { defineModule, type KoshModule } from '@kosh/modules-sdk';
import { reporting } from '@kosh/reporting';
import { base, type ModuleContext } from '@kosh/server';
import { portalAnnouncer } from './announce.js';
import { portalShutro } from './module.js';
import { type PortalRoutesOptions, registerPortalRoutes } from './routes.js';
import { registerPortalDocumentRoutes } from './routes-documents.js';

export { CHANGE_TOPIC, portalAnnouncer } from './announce.js';
export { type PortalDocument, portalDocuments } from './documents.js';
export {
  PartnerPortalUsers,
  PortalInvitation,
  PortalSignature,
  portalShutro,
  UserPortalPartner,
} from './module.js';
export {
  INVITATION_DAYS,
  PORTAL_USER,
  type PortalRoutesOptions,
  registerPortalRoutes,
} from './routes.js';
export { registerPortalDocumentRoutes } from './routes-documents.js';
export { portalRule } from './rules.js';

/** Package identity. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/portal',
  rfc: 'RFC 0015',
});

/** The portal module with explicit options (tests): its URL and mailer. */
export function createPortal(
  options: Partial<PortalRoutesOptions> & {
    /** Announce new documents in this process (default: unless `KOSH_SCHEDULES=off`). */
    readonly workers?: boolean;
  } = {},
): KoshModule {
  return defineModule({
    shutro: portalShutro,
    kosh: '^0.1.0',
    depends: [base, contacts, messaging, reporting],
    accessLevels: { manager: { label: 'Portal access', groups: ['portal.manager'] } },
    externalGroups: ['portal.user'],
    privateModels: ['portal.invitation', 'portal.signature', 'portal.announcement'],
    // "Portal access" on the contact form, under the ways to reach them.
    viewExtensions: [
      {
        view: 'res.partner.form',
        operations: [
          {
            insertAfter: 'reach',
            nodes: [{ kind: 'component', id: 'portal_access', component: 'portal.Access' }],
          },
        ],
      },
    ],
    routes: (context: ModuleContext) => {
      const delivery = {
        portalUrl: options.portalUrl ?? process.env['KOSH_PORTAL_URL'] ?? 'http://localhost:5174',
        mailer: 'mailer' in options ? options.mailer : mailerFromEnv(),
      };
      registerPortalRoutes(context, delivery);
      registerPortalDocumentRoutes(context);
      if (!(options.workers ?? process.env['KOSH_SCHEDULES'] !== 'off')) return;
      const announcer = portalAnnouncer(context, delivery);
      announcer.start();
      context.app.addHook('onClose', () => announcer.stop());
    },
  });
}

/** The portal, configured from the environment (`KOSH_PORTAL_URL`, `SMTP_URL`). */
export const portal: KoshModule = createPortal();
