/**
 * @packageDocumentation
 * `@kosh/website_crm`: the bridge between Sites and Pipeline (RFC 0021). Proposed whenever both apps are installed:
 * a website form may create deals (`target: 'crm.deal'`), which arrive from the website in the first stage, for every
 * Pipeline user to pick up.
 */
import { crm } from '@kosh/crm';
import { defineModule } from '@kosh/modules-sdk';
import { website } from '@kosh/website';
import { websiteCrmShutro } from './module.js';

export { FormDeals, websiteCrmShutro } from './module.js';

export const websiteCrm: ReturnType<typeof defineModule> = defineModule({
  shutro: websiteCrmShutro,
  kosh: '^0.1.0',
  depends: [website, crm],
  bridge: [website, crm],
  accessLevels: {
    user: { label: 'Website deals', groups: ['website_crm.user'] },
  },
});
