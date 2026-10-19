/**
 * The Kosh back-office (RFC 0007): the default renderers from `@isahaq/kosh-ui`, plus the web contributions of the
 * distribution's modules, composed at build time. What a user sees is decided per request by the server.
 */
import './index.css';
import { messagingMessages, registerMessagingWeb } from '@isahaq/kosh-messaging/web';
import { registerPermissionsWeb } from '@isahaq/kosh-permissions/web';
import { registerReportingWeb, reportingMessages } from '@isahaq/kosh-reporting/web';
import { createDefaultRegistry, createKoshApi, KoshApp } from '@isahaq/kosh-ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const registry = createDefaultRegistry();
registerPermissionsWeb(registry);
registerReportingWeb(registry);
registerMessagingWeb(registry);
const messages = { reporting: reportingMessages, messaging: messagingMessages };

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');
createRoot(root).render(
  <StrictMode>
    <KoshApp api={createKoshApi()} registry={registry} messages={messages} />
  </StrictMode>,
);
