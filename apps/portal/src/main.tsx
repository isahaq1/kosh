/**
 * The customer and vendor portal (RFC 0015 §5.6): its own small app on the Kosh design system, reaching only the
 * portal API. Routes: sign in, activate (from the invitation), home, a document type's list, a document, profile.
 */
import './index.css';
import { addMessages, createFormatter, createI18n, createKoshApi } from '@kosh/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { messages } from './messages.js';
import { Document } from './pages/Document.js';
import { Documents, Home } from './pages/Documents.js';
import { Layout } from './pages/Layout.js';
import { Profile } from './pages/Profile.js';
import { Activate, SignIn } from './pages/SignIn.js';
import { PortalContext } from './portal.js';

const LANG_KEY = 'kosh.portal.lang';
const stored = (() => {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
})();
const initial = stored ?? (navigator.language.startsWith('bn') ? 'bn_BD' : 'en_US');

const api = createKoshApi();
api.setLanguage(initial);
const i18n = await createI18n(initial);
addMessages(i18n, 'portal', messages);
const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });

const root = createRootRoute({ component: Outlet });
const signedIn = createRoute({ getParentRoute: () => root, id: 'signed-in', component: Layout });
const router = createRouter({
  routeTree: root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/login', component: SignIn }),
    createRoute({ getParentRoute: () => root, path: '/activate', component: Activate }),
    signedIn.addChildren([
      createRoute({ getParentRoute: () => signedIn, path: '/', component: Home }),
      createRoute({ getParentRoute: () => signedIn, path: '/d/$key', component: Documents }),
      createRoute({ getParentRoute: () => signedIn, path: '/d/$key/$id', component: Document }),
      createRoute({ getParentRoute: () => signedIn, path: '/profile', component: Profile }),
    ]),
  ]),
});

function App() {
  const [lang, setLangState] = useState(initial);
  const value = useMemo(
    () => ({
      api,
      lang,
      format: createFormatter(lang, Intl.DateTimeFormat().resolvedOptions().timeZone),
      setLang(next: string) {
        try {
          localStorage.setItem(LANG_KEY, next);
        } catch {
          // private windows: the choice lasts for this visit
        }
        api.setLanguage(next);
        void i18n.changeLanguage(next.replace('_', '-'));
        setLangState(next);
        void queryClient.invalidateQueries();
      },
    }),
    [lang],
  );
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <PortalContext.Provider value={value}>
          <RouterProvider router={router} />
        </PortalContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

const element = document.getElementById('root');
if (element === null) throw new Error('index.html has no #root element.');
createRoot(element).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
