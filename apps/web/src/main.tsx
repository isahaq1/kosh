/**
 * The Kosh back-office (RFC 0007): the default renderers from `@kosh/ui`, plus the web contributions of the
 * distribution's modules, composed at build time. What a user sees is decided per request by the server.
 */
import './index.css';
import { registerPermissionsWeb } from '@kosh/permissions/web';
import { createDefaultRegistry, createKoshApi, KoshApp } from '@kosh/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const registry = createDefaultRegistry();
registerPermissionsWeb(registry);

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');
createRoot(root).render(
  <StrictMode>
    <KoshApp api={createKoshApi()} registry={registry} />
  </StrictMode>,
);
