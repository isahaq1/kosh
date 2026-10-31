/**
 * The starter project `shutro-erp init` writes: an API server and the back-office app, both importing `shutro-erp`.
 * Server files run on Node.js directly (type stripping); the back-office is a Vite app proxying `/api` to the server.
 */

export type AppName =
  | 'permissions'
  | 'reporting'
  | 'messaging'
  | 'contacts'
  | 'product'
  | 'sales'
  | 'purchase'
  | 'accounting'
  | 'sale_account'
  | 'purchase_account'
  | 'project'
  | 'todo'
  | 'calendar'
  | 'crm'
  | 'hr'
  | 'recruitment'
  | 'stock'
  | 'mrp'
  | 'maintenance'
  | 'trade_finance'
  | 'event'
  | 'sale_project'
  | 'sale_stock'
  | 'purchase_stock'
  | 'stock_account'
  | 'purchase_stock_account'
  | 'mrp_account'
  | 'maintenance_stock'
  | 'trade_finance_account'
  | 'trade_finance_purchase'
  | 'trade_finance_sale'
  | 'l10n_bd'
  | 'l10n_in';
export interface AppSpec {
  readonly label: string;
  /** Shown next to the app in the installer (where the terminal shows pictographs). */
  readonly icon: string;
  /** The module's export in `shutro-erp/<app>`. */
  readonly server: string;
  /** The web registration in `shutro-erp/<app>/web` (apps built only from views and actions have none). */
  readonly web?: string;
  /** A bridge (RFC 0008 §5.1): not offered in the installer; proposed when the apps it connects are installed. */
  readonly bridge?: readonly AppName[];
  /** A localization (RFC 0016): installed, with its bridged apps, for a company in this country (ISO 3166). */
  readonly country?: string;
}

/** The apps `shutro-erp init` can install (base and Settings are always there), in the order the installer lists them. */
export const APPS: Readonly<Record<AppName, AppSpec>> = {
  permissions: {
    label: 'Roles, field security and approvals',
    icon: '🛡️',
    server: 'permissions',
    web: 'registerPermissionsWeb',
  },
  reporting: {
    label: 'Reports: pivots, charts, dashboards, documents, scheduled reports',
    icon: '📊',
    server: 'reporting',
    web: 'registerReportingWeb',
  },
  messaging: {
    label: 'Chatter, activities and attachments on every record',
    icon: '💬',
    server: 'messaging',
    web: 'registerMessagingWeb',
  },
  contacts: {
    label: 'Contacts: customers, vendors and their people',
    icon: '👥',
    server: 'contacts',
  },
  product: {
    label: 'Products: prices, units of measure and taxes (VAT)',
    icon: '📦',
    server: 'product',
  },
  sales: { label: 'Sales: quotations and sales orders', icon: '🛒', server: 'sales' },
  purchase: {
    label: 'Purchase: RFQs, purchase orders and approvals',
    icon: '🧾',
    server: 'purchase',
  },
  accounting: {
    label: 'Accounting: chart of accounts, journals, entries, invoices and bills',
    icon: '📒',
    server: 'accounting',
    web: 'registerAccountingWeb',
  },
  project: {
    label: 'Projects: projects, tasks on a kanban, timesheets',
    icon: '🗂️',
    server: 'project',
  },
  sale_account: {
    label: 'Bridge: invoices from sales orders (Sales ↔ Accounting)',
    icon: '🔗',
    server: 'saleAccount',
    bridge: ['sales', 'accounting'],
  },
  purchase_account: {
    label: 'Bridge: bills from purchase orders (Purchase ↔ Accounting)',
    icon: '🔗',
    server: 'purchaseAccount',
    bridge: ['purchase', 'accounting'],
  },
  todo: {
    label: 'Focus: your to-dos and shared lists, with checklists and due dates',
    icon: '✅',
    server: 'todo',
  },
  calendar: {
    label: 'Agenda: meetings, rooms that are never double-booked, who is free when',
    icon: '📅',
    server: 'calendarApp',
  },
  crm: {
    label: 'Pipeline: deals on a board, stage rules, the weighted forecast',
    icon: '📈',
    server: 'crm',
  },
  hr: {
    label: 'Workforce: employees, the org chart, contracts and leave',
    icon: '🧑‍💼',
    server: 'hr',
  },
  recruitment: {
    label: 'Hiring: openings, applicants on a board, independent scorecards, hire in one step',
    icon: '🤝',
    server: 'recruitment',
    web: 'registerRecruitmentWeb',
  },
  stock: {
    label:
      'Stockroom: warehouses, transfers with one clear status, reservations that say what they are for',
    icon: '🏬',
    server: 'stock',
    web: 'registerStockWeb',
  },
  mrp: {
    label:
      'Production: bills of materials with versions, orders that show what is short and what they cost',
    icon: '🏭',
    server: 'mrp',
  },
  maintenance: {
    label:
      'Asset Care: equipment, preventive plans by time or meter, maintenance orders, reliability',
    icon: '🛠️',
    server: 'maintenance',
  },
  trade_finance: {
    label:
      'Trade Finance: letters of credit, amendments, presentations and discrepancies, bank limits',
    icon: '🏦',
    server: 'tradeFinance',
  },
  event: {
    label: 'Event Hub: events, tickets and seats, waiting lists, check-in by QR',
    icon: '🎟️',
    server: 'event',
  },
  sale_project: {
    label: 'Bridge: tasks and projects from sales orders (Sales ↔ Projects)',
    icon: '🔗',
    server: 'saleProject',
    bridge: ['sales', 'project'],
  },
  sale_stock: {
    label: 'Bridge: deliveries from sales orders (Sales ↔ Stockroom)',
    icon: '🔗',
    server: 'saleStock',
    bridge: ['sales', 'stock'],
  },
  purchase_stock: {
    label: 'Bridge: receipts from purchase orders (Purchase ↔ Stockroom)',
    icon: '🔗',
    server: 'purchaseStock',
    bridge: ['purchase', 'stock'],
  },
  stock_account: {
    label: 'Bridge: the stock valued and posted as it moves (Stockroom ↔ Accounting)',
    icon: '🔗',
    server: 'stockAccount',
    bridge: ['stock', 'accounting'],
  },
  purchase_stock_account: {
    label:
      'Bridge: receipts at the order price, bills clearing goods received (Purchase ↔ Stockroom ↔ Accounting)',
    icon: '🔗',
    server: 'purchaseStockAccount',
    bridge: ['purchase', 'stock', 'accounting'],
  },
  mrp_account: {
    label:
      'Bridge: products made valued at what they consumed plus their operations (Production ↔ Accounting)',
    icon: '🔗',
    server: 'mrpAccount',
    bridge: ['mrp', 'accounting'],
  },
  maintenance_stock: {
    label: 'Bridge: spare parts on maintenance orders (Asset Care ↔ Stockroom)',
    icon: '🔗',
    server: 'maintenanceStock',
    bridge: ['maintenance', 'stock'],
  },
  trade_finance_account: {
    label:
      'Bridge: LC margins, payments and bank charges in the books (Trade Finance ↔ Accounting)',
    icon: '🔗',
    server: 'tradeFinanceAccount',
    bridge: ['trade_finance', 'accounting'],
  },
  trade_finance_purchase: {
    label: 'Bridge: import LCs from purchase orders (Trade Finance ↔ Purchase)',
    icon: '🔗',
    server: 'tradeFinancePurchase',
    bridge: ['trade_finance', 'purchase'],
  },
  trade_finance_sale: {
    label: 'Bridge: export LCs for sales orders (Trade Finance ↔ Sales)',
    icon: '🔗',
    server: 'tradeFinanceSale',
    bridge: ['trade_finance', 'sales'],
  },
  l10n_bd: {
    label: 'Bangladesh: chart of accounts, VAT and SD, VDS and TDS, BIN and TIN, July–June year',
    icon: '🇧🇩',
    server: 'l10nBd',
    web: 'registerL10nBdWeb',
    bridge: ['accounting'],
    country: 'BD',
  },
  l10n_in: {
    label:
      'India: GST (CGST / SGST / IGST), cess, reverse charge, GSTIN, HSN / SAC, TDS, April–March year',
    icon: '🇮🇳',
    server: 'l10nIn',
    web: 'registerL10nInWeb',
    bridge: ['accounting'],
    country: 'IN',
  },
};

export interface StarterOptions {
  readonly name: string;
  readonly apps: readonly AppName[];
  readonly port: number;
  /** The back-office's port in development (default 5173). */
  readonly webPort?: number;
  readonly koshVersion: string;
  /** The database name of the Docker PostgreSQL service (compose.yaml). */
  readonly dockerDb?: string;
  /** Attachments in a folder (SHUTRO_ERP_STORAGE_DIR) rather than S3. */
  readonly fileStorage?: boolean;
}

const REACT = {
  react: '^19.1.0',
  'react-dom': '^19.1.0',
  '@tanstack/react-query': '^5.90.0',
  '@tanstack/react-router': '^1.170.0',
  i18next: '^25.0.0 || ^26.0.0',
  'react-i18next': '^16.0.0 || ^17.0.0',
};

/** The project's package.json (merged into an existing one: missing scripts and dependencies are added). */
export function packageJson(
  options: StarterOptions,
  existing: Record<string, unknown> | null,
): string {
  const base = existing ?? { name: options.name, version: '0.1.0', private: true };
  const merge = (key: string, extra: Record<string, string>) => ({
    ...extra,
    ...((base[key] as Record<string, string> | undefined) ?? {}),
  });
  const pkg = {
    ...base,
    type: 'module',
    scripts: merge('scripts', {
      start: 'node --env-file=.env src/server.ts',
      web: 'vite',
      'build:web': 'vite build',
      migrate: 'shutro-erp migrate',
      seed: 'shutro-erp seed',
      'docker:up': 'docker compose up -d --build',
    }),
    engines: { node: '>=24', ...((base['engines'] as Record<string, string> | undefined) ?? {}) },
    dependencies: merge('dependencies', {
      'shutro-erp': `^${options.koshVersion}`,
      ...REACT,
    }),
    devDependencies: merge('devDependencies', {
      vite: '^7.1.0',
      '@vitejs/plugin-react': '^5.0.0',
      tailwindcss: '^4.1.0',
      '@tailwindcss/vite': '^4.1.0',
      '@types/react': '^19.1.0',
      '@types/react-dom': '^19.1.0',
    }),
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function modulesTs(_options: StarterOptions): string {
  const apps = Object.keys(APPS) as AppName[];
  const imports = apps.map((a) => `import { ${APPS[a].server} } from 'shutro-erp/${a}';`);
  return `/**
 * The apps this installation can install (the catalogue). The database records which are installed: Settings → Apps
 * in the back-office, or \`npx shutro-erp apps\`, installs, disables and enables them. \`base\` (users, companies, sign-in)
 * and Settings are always installed. Add your own modules here (\`defineModule\` from \`shutro-erp/modules-sdk\`),
 * then install them from Settings → Apps.
 */
import { base } from 'shutro-erp';
import { automation } from 'shutro-erp/automation';
import { integrations } from 'shutro-erp/integrations';
import { mail } from 'shutro-erp/mail';
import { notify } from 'shutro-erp/notify';
import { realtime } from 'shutro-erp/realtime';
import { settings } from 'shutro-erp/settings';
import { assistant } from 'shutro-erp/assistant';
import { dataImport } from 'shutro-erp/import';
import { studio } from 'shutro-erp/studio';
${imports.join('\n')}

export const modules = [base, settings, realtime, notify, mail, automation, integrations, studio, dataImport, assistant${apps.map((a) => `, ${APPS[a].server}`).join('')}];
`;
}

export function serverTs(): string {
  return `/**
 * The Shutro ERP API server: \`npm start\` (reads .env). It serves the installed apps of src/modules.ts, and switches to
 * the new set without a restart when apps are installed or disabled (here or on another server).
 */
import { createAppHost, startAppHost } from 'shutro-erp';
import { modules } from './modules.ts';

const env = process.env;
const host = await createAppHost({
  databaseUrl: String(env['DATABASE_URL']),
  catalogue: modules,
  migrationsDir: 'migrations',
  ...(env['VALKEY_URL'] ? { valkeyUrl: env['VALKEY_URL'] } : {}),
  // Secure cookies need HTTPS: on by default in production (SHUTRO_ERP_SECURE_COOKIES=false for plain HTTP).
  auth: { secureCookies: (env['SHUTRO_ERP_SECURE_COOKIES'] ?? env['KOSH_SECURE_COOKIES'] ?? String(env['NODE_ENV'] === 'production')) === 'true' },
});
const address = await startAppHost(host, { port: Number(env['PORT'] ?? 3000), host: env['HOST'] ?? '127.0.0.1' });
process.stdout.write(\`Shutro ERP API on \${address}\\n\`);
`;
}

export function viteConfig(options: StarterOptions): string {
  return `/** The back-office app: \`npm run web\` (proxies /api to the server, same origin for the session cookie). */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { koshPwa } from 'shutro-erp/ui/vite';
import { defineConfig } from 'vite';

const api = process.env['SHUTRO_ERP_API'] ?? process.env['KOSH_API'] ?? 'http://localhost:${options.port}';

export default defineConfig({
  // koshPwa: the service worker (the app opens offline and gets web push)
  plugins: [react(), tailwindcss(), koshPwa()],
  server: { port: ${options.webPort ?? 5173}, proxy: { '/api': { target: api, ws: true } } },
  preview: { port: ${options.webPort ?? 5173}, proxy: { '/api': { target: api, ws: true } } },
});
`;
}

export function indexHtml(options: StarterOptions): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="#1d4ed8" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <title>${options.name.replace(/[<>&"]/g, '')}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
`;
}

export function mainTsx(_options: StarterOptions): string {
  // Every catalogue app's web contribution: pages of apps installed later are already there.
  const web = [
    ...(Object.keys(APPS) as AppName[]).flatMap((a) => {
      const fn = APPS[a].web;
      return fn === undefined ? [] : [{ name: a as string, fn }];
    }),
    { name: 'settings', fn: 'registerSettingsWeb' },
    { name: 'notify', fn: 'registerNotifyWeb' },
    { name: 'mail', fn: 'registerMailWeb' },
    { name: 'automation', fn: 'registerAutomationWeb' },
    { name: 'integrations', fn: 'registerIntegrationsWeb' },
    { name: 'studio', fn: 'registerStudioWeb' },
    { name: 'assistant', fn: 'registerAssistantWeb' },
    { name: 'import', fn: 'registerImportWeb' },
  ].map(({ name, fn }) => {
    const messages = name === 'permissions' ? null : `${name}Messages`;
    return {
      line: `import { ${[messages, fn].filter((x) => x !== null).join(', ')} } from 'shutro-erp/${name}/web';`,
      call: `${fn}(registry);`,
      messages: messages === null ? null : `${name}: ${messages}`,
    };
  });
  const messages = web.map((w) => w.messages).filter((m) => m !== null);
  return `/** The back-office: the renderers of shutro-erp/ui plus every catalogue app's web contribution. */
import './index.css';
import { createDefaultRegistry, createKoshApi, KoshApp } from 'shutro-erp/ui';
${web.map((w) => w.line).join('\n')}
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const registry = createDefaultRegistry();
${web.map((w) => w.call).join('\n')}

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');
createRoot(root).render(
  <StrictMode>
    <KoshApp api={createKoshApi()} registry={registry} messages={{ ${messages.join(', ')} }} />
  </StrictMode>,
);
`;
}

/** The web app manifest: the back-office installs as an app on phones and desktops (RFC 0010 §3.10). */
export function manifest(options: StarterOptions): string {
  const name = options.name.replace(/[<>&"]/g, '');
  return `${JSON.stringify(
    {
      name,
      short_name: name.slice(0, 12),
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#f8f9fb',
      theme_color: '#1d4ed8',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    },
    null,
    2,
  )}\n`;
}

/** The app icon (replace it with the company's). */
export function icon(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Shutro ERP">
  <rect width="512" height="512" rx="112" fill="#1d4ed8"/>
  <path d="M156 128h56v112l108-112h72L270 258l128 126h-74L220 282v102h-64z" fill="#fff"/>
</svg>
`;
}

export function indexCss(): string {
  return `@import "tailwindcss";
@import "shutro-erp/ui/styles.css";

/* Tailwind scans Shutro ERP's components for the classes they use. */
@source "../../node_modules/shutro-erp/dist";
`;
}

export function gitignore(): string {
  return `node_modules/
dist/
.env
var/
`;
}

/** Three images from one build: the API (migrates, then serves) and nginx with the back-office. */
export function dockerfile(): string {
  return `# Shutro ERP images (shutro-erp init). Built by compose.yaml: docker compose up -d --build
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build:web && npm prune --omit=dev

# The API: applies pending migrations and seed data, then serves on port 3000.
FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
# Attachments (the files volume) are written by the unprivileged user.
RUN mkdir -p /app/var/attachments && chown -R node:node /app/var
USER node
EXPOSE 3000
CMD ["sh", "-c", "npx shutro-erp migrate && node src/server.ts"]

# The back-office: static files, /api proxied to the API.
FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
`;
}

export function nginxConf(): string {
  return `# The back-office (shutro-erp init): the built app, /api proxied to the API service.
server {
  listen 80;
  root /usr/share/nginx/html;
  client_max_body_size 30m;

  location /api/ {
    proxy_pass http://api:3000;
    # The realtime gateway (live updates) is a WebSocket.
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location / {
    try_files $uri /index.html;
  }
}
`;
}

/**
 * PostgreSQL, the API and the back-office. Credentials come from .env (POSTGRES_PASSWORD, ...); the API reaches
 * the database by its service name. DOCKER_DATABASE_URL points the API at another server instead.
 */
export function composeYaml(options: StarterOptions): string {
  const db = options.dockerDb ?? options.name.replace(/-/g, '_');
  /** A compose variable: `${NAME}` or `${NAME:-default}` (plain strings: nothing to escape). */
  const v = (name: string, fallback?: string) =>
    ['$', '{', name, fallback === undefined ? '' : fallback, '}'].join('');
  const user = v('POSTGRES_USER', ':-shutro');
  const lines = [
    '# Shutro ERP in Docker (shutro-erp init).',
    '#   docker compose up -d db          only PostgreSQL (the API runs with npm start)',
    '#   docker compose up -d --build     everything: the back-office on http://localhost:8080',
    `name: ${options.name}`,
    'services:',
    '  db:',
    '    image: postgres:18',
    '    restart: unless-stopped',
    '    environment:',
    `      POSTGRES_USER: ${user}`,
    `      POSTGRES_PASSWORD: ${v('POSTGRES_PASSWORD', ':?set POSTGRES_PASSWORD in .env')}`,
    `      POSTGRES_DB: ${v('POSTGRES_DB', `:-${db}`)}`,
    '    ports:',
    `      - "127.0.0.1:${v('POSTGRES_PORT', ':-5432')}:5432"`,
    '    volumes:',
    // PostgreSQL 18 images keep their data under /var/lib/postgresql (a versioned subdirectory).
    '      - db:/var/lib/postgresql',
    '    healthcheck:',
    // $$ is a literal $ for compose: the shell in the container expands the variable.
    `      test: ["CMD-SHELL", "pg_isready -U $${v('POSTGRES_USER', ':-shutro')}"]`,
    '      interval: 5s',
    '      retries: 30',
    '',
    '  api:',
    '    build:',
    '      context: .',
    '      target: api',
    '    restart: unless-stopped',
    '    env_file: .env',
    '    environment:',
    `      DATABASE_URL: ${v('DOCKER_DATABASE_URL', `:-postgres://${user}:${v('POSTGRES_PASSWORD')}@db:5432/${v('POSTGRES_DB', `:-${db}`)}`)}`,
    ...(options.fileStorage === false
      ? []
      : ['      SHUTRO_ERP_STORAGE_DIR: /app/var/attachments']),
    '      # Plain HTTP on localhost; set "true" when the site is served over HTTPS.',
    '      SHUTRO_ERP_SECURE_COOKIES: "false"',
    '    depends_on:',
    '      db:',
    '        condition: service_healthy',
    '    volumes:',
    '      - files:/app/var',
    '',
    '  web:',
    '    build:',
    '      context: .',
    '      target: web',
    '    restart: unless-stopped',
    '    ports:',
    `      - "${v('WEB_PORT', ':-8080')}:80"`,
    '    depends_on: [api]',
    '',
    'volumes:',
    '  db: {}',
    '  files: {}',
  ];
  return `${lines.join('\n')}\n`;
}

export function dockerignore(): string {
  return `node_modules
dist
var
.env
.git
`;
}

export function tsconfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'es2024',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        jsx: 'react-jsx',
        lib: ['es2024', 'dom', 'dom.iterable'],
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
      },
      include: ['src', 'vite.config.ts'],
    },
    null,
    2,
  )}\n`;
}

export function readme(options: StarterOptions): string {
  return `# ${options.name}

A [Shutro ERP](https://www.npmjs.com/package/shutro-erp) installation, created with \`shutro-erp init\`.

\`\`\`sh
npm install
npm start          # the API on http://localhost:${options.port}
npm run web        # the back-office on http://localhost:${options.webPort ?? 5173} (sign in as the administrator)
npx shutro-erp migrate   # after changing modules: plan and apply database migrations, load seed data
npx shutro-erp seed      # load seed data again
# Settings → Apps in the back-office installs, enables and disables apps (or, in the terminal:)
npx shutro-erp apps                   # the apps: installed, disabled, available
npx shutro-erp apps install <name>    # install an app (and what it needs) in one transaction
npx shutro-erp apps disable <name>    # switch an app off; its data stays (npx shutro-erp apps enable <name>)
npx shutro-erp module create <name>   # a new module in src/modules/<name>/
docker compose up -d --build    # everything in Docker: http://localhost:8080
\`\`\`

Settings (database, file storage, port) are in \`.env\`, which is not committed. Modules are listed in
\`src/modules.ts\`.
`;
}

/** The apps the installer offers (every app but the bridges, which come by themselves). */
export const SELECTABLE_APPS: readonly AppName[] = (Object.keys(APPS) as AppName[]).filter(
  (a) => APPS[a].bridge === undefined,
);

/** The bridges whose every connected app is in `apps`, and the localization of `country` among them. */
export function bridgesFor(apps: readonly AppName[], country = ''): AppName[] {
  return (Object.keys(APPS) as AppName[]).filter((a) => {
    const spec = APPS[a];
    if (spec.country !== undefined && spec.country !== country) return false;
    return spec.bridge?.every((b) => apps.includes(b)) === true;
  });
}

/** The names of the countries with a localization (the installer's list). */
export const COUNTRY_NAMES: Readonly<Record<string, string>> = { BD: 'Bangladesh', IN: 'India' };

/** The countries with a localization, for the installer's question. */
export const LOCALIZED_COUNTRIES: readonly string[] = Object.values(APPS).flatMap((a) =>
  a.country === undefined ? [] : [a.country],
);
