/**
 * The Kosh back-office (RFC 0007): the default renderers from `@kosh/ui`, plus the web contributions of the
 * distribution's modules, composed at build time. What a user sees is decided per request by the server.
 */
import './index.css';
import { accountingMessages, registerAccountingWeb } from '@kosh/accounting/web';
import { assistantMessages, registerAssistantWeb } from '@kosh/assistant/web';
import { automationMessages, registerAutomationWeb } from '@kosh/automation/web';
import { importMessages, registerImportWeb } from '@kosh/import/web';
import { l10n_bdMessages, registerL10nBdWeb } from '@kosh/l10n_bd/web';
import { l10n_inMessages, registerL10nInWeb } from '@kosh/l10n_in/web';
import { mailMessages, registerMailWeb } from '@kosh/mail/web';
import { messagingMessages, registerMessagingWeb } from '@kosh/messaging/web';
import { notifyMessages, registerNotifyWeb } from '@kosh/notify/web';
import { registerPermissionsWeb } from '@kosh/permissions/web';
import { portalMessages, registerPortalWeb } from '@kosh/portal/web';
import { registerReportingWeb, reportingMessages } from '@kosh/reporting/web';
import { registerSettingsWeb, settingsMessages } from '@kosh/settings/web';
import { registerStudioWeb, studioMessages } from '@kosh/studio/web';
import { createDefaultRegistry, createKoshApi, KoshApp } from '@kosh/ui';
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
registerStudioWeb(registry);
registerAssistantWeb(registry);
registerImportWeb(registry);
registerPortalWeb(registry);
registerL10nBdWeb(registry);
registerL10nInWeb(registry);
const messages = {
  accounting: accountingMessages,
  assistant: assistantMessages,
  automation: automationMessages,
  import: importMessages,
  l10n_bd: l10n_bdMessages,
  l10n_in: l10n_inMessages,
  mail: mailMessages,
  notify: notifyMessages,
  portal: portalMessages,
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
