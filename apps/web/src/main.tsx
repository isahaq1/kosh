/**
 * The Kosh back-office (RFC 0007): the default renderers from `@kosh/ui`, plus the web contributions of the
 * distribution's modules, composed at build time. What a user sees is decided per request by the server.
 */
import './index.css';
import { accountingMessages, registerAccountingWeb } from '@kosh/accounting/web';
import { assistantMessages, registerAssistantWeb } from '@kosh/assistant/web';
import { automationMessages, registerAutomationWeb } from '@kosh/automation/web';
import { eventMessages, registerEventWeb } from '@kosh/event/web';
import { importMessages, registerImportWeb } from '@kosh/import/web';
import { integrationsMessages, registerIntegrationsWeb } from '@kosh/integrations/web';
import { l10n_bdMessages, registerL10nBdWeb } from '@kosh/l10n_bd/web';
import { l10n_inMessages, registerL10nInWeb } from '@kosh/l10n_in/web';
import { mailMessages, registerMailWeb } from '@kosh/mail/web';
import { messagingMessages, registerMessagingWeb } from '@kosh/messaging/web';
import { notifyMessages, registerNotifyWeb } from '@kosh/notify/web';
import { registerPermissionsWeb } from '@kosh/permissions/web';
import { portalMessages, registerPortalWeb } from '@kosh/portal/web';
import { posMessages, registerPosWeb } from '@kosh/pos/web';
import { recruitmentMessages, registerRecruitmentWeb } from '@kosh/recruitment/web';
import { registerReportingWeb, reportingMessages } from '@kosh/reporting/web';
import { registerSettingsWeb, settingsMessages } from '@kosh/settings/web';
import { registerStockWeb, stockMessages } from '@kosh/stock/web';
import { registerStudioWeb, studioMessages } from '@kosh/studio/web';
import { createDefaultRegistry, createKoshApi, KoshApp } from '@kosh/ui';
import { registerWebsiteWeb, websiteMessages } from '@kosh/website/web';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const registry = createDefaultRegistry();
registerPermissionsWeb(registry);
registerReportingWeb(registry);
registerMessagingWeb(registry);
registerSettingsWeb(registry);
registerNotifyWeb(registry);
registerAccountingWeb(registry);
registerMailWeb(registry);
registerAutomationWeb(registry);
registerIntegrationsWeb(registry);
registerStudioWeb(registry);
registerAssistantWeb(registry);
registerImportWeb(registry);
registerPortalWeb(registry);
registerL10nBdWeb(registry);
registerL10nInWeb(registry);
registerRecruitmentWeb(registry);
registerStockWeb(registry);
registerEventWeb(registry);
registerWebsiteWeb(registry);
registerPosWeb(registry);
const messages = {
  accounting: accountingMessages,
  assistant: assistantMessages,
  automation: automationMessages,
  import: importMessages,
  integrations: integrationsMessages,
  l10n_bd: l10n_bdMessages,
  l10n_in: l10n_inMessages,
  mail: mailMessages,
  notify: notifyMessages,
  portal: portalMessages,
  recruitment: recruitmentMessages,
  stock: stockMessages,
  event: eventMessages,
  website: websiteMessages,
  pos: posMessages,
  reporting: reportingMessages,
  messaging: messagingMessages,
  settings: settingsMessages,
  studio: studioMessages,
};

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');
createRoot(root).render(
  <StrictMode>
    <KoshApp api={createKoshApi()} registry={registry} messages={messages} />
  </StrictMode>,
);
