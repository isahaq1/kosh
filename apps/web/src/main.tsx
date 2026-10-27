/**
 * The Kosh back-office (RFC 0007): the default renderers from `@kosh/ui`, plus the web contributions of the
 * distribution's modules, composed at build time. What a user sees is decided per request by the server.
 */
import './index.css';
import { accountingMessages, registerAccountingWeb } from '@kosh/accounting/web';
import { assistantMessages, registerAssistantWeb } from '@kosh/assistant/web';
import { automationMessages, registerAutomationWeb } from '@kosh/automation/web';
import { mailMessages, registerMailWeb } from '@kosh/mail/web';
import { messagingMessages, registerMessagingWeb } from '@kosh/messaging/web';
import { notifyMessages, registerNotifyWeb } from '@kosh/notify/web';
import { registerPermissionsWeb } from '@kosh/permissions/web';
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
const messages = {
  accounting: accountingMessages,
  assistant: assistantMessages,
  automation: automationMessages,
  mail: mailMessages,
  notify: notifyMessages,
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
