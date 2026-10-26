/**
 * The starter project `kosh init` writes: an API server and the back-office app, both importing `kosh-erp`.
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
  | 'sale_project';
export interface AppSpec {
  readonly label: string;
  /** Shown next to the app in the installer (where the terminal shows pictographs). */
  readonly icon: string;
  /** The module's export in `kosh-erp/<app>`. */
  readonly server: string;
  /** The web registration in `kosh-erp/<app>/web` (apps built only from views and actions have none). */
  readonly web?: string;
  /** A bridge (RFC 0008 §5.1): not offered in the installer; proposed when the apps it connects are installed. */
  readonly bridge?: readonly AppName[];
}

/** The apps `kosh init` can install (base and Settings are always there), in the order the installer lists them. */
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
  sale_project: {
    label: 'Bridge: tasks and projects from sales orders (Sales ↔ Projects)',
    icon: '🔗',
    server: 'saleProject',
    bridge: ['sales', 'project'],
  },
};

export interface StarterOptions {
  readonly name: string;
  readonly apps: readonly AppName[];
  readonly port: number;
  readonly koshVersion: string;
  /** The database name of the Docker PostgreSQL service (compose.yaml). */
  readonly dockerDb?: string;
  /** Attachments in a folder (KOSH_STORAGE_DIR) rather than S3. */
  readonly fileStorage?: boolean;
}

const REACT = {
  react: '^19.1.0',
  'react-dom': '^19.1.0',
  '@tanstack/react-query': '^5.90.0',
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
      migrate: 'kosh migrate',
      seed: 'kosh seed',
      'docker:up': 'docker compose up -d --build',
    }),
    engines: { node: '>=24', ...((base['engines'] as Record<string, string> | undefined) ?? {}) },
    dependencies: merge('dependencies', {
      'kosh-erp': `^${options.koshVersion}`,
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
  const imports = apps.map((a) => `import { ${APPS[a].server} } from 'kosh-erp/${a}';`);
  return `/**
 * The apps this installation can install (the catalogue). The database records which are installed: Settings → Apps
 * in the back-office, or \`npx kosh apps\`, installs, disables and enables them. \`base\` (users, companies, sign-in)
 * and Settings are always installed. Add your own modules here (\`defineModule\` from \`kosh-erp/modules-sdk\`),
 * then install them from Settings → Apps.
 */
import { base } from 'kosh-erp';
import { mail } from 'kosh-erp/mail';
import { notify } from 'kosh-erp/notify';
import { realtime } from 'kosh-erp/realtime';
import { settings } from 'kosh-erp/settings';
${imports.join('\n')}

export const modules = [base, settings, realtime, notify, mail${apps.map((a) => `, ${APPS[a].server}`).join('')}];
`;
}

export function serverTs(): string {
  return `/**
 * The Kosh API server: \`npm start\` (reads .env). It serves the installed apps of src/modules.ts, and switches to
 * the new set without a restart when apps are installed or disabled (here or on another server).
 */
import { createAppHost, startAppHost } from 'kosh-erp';
import { modules } from './modules.ts';

const env = process.env;
const host = await createAppHost({
  databaseUrl: String(env['DATABASE_URL']),
  catalogue: modules,
  migrationsDir: 'migrations',
  ...(env['VALKEY_URL'] ? { valkeyUrl: env['VALKEY_URL'] } : {}),
  // Secure cookies need HTTPS: on by default in production (KOSH_SECURE_COOKIES=false for plain HTTP).
  auth: { secureCookies: (env['KOSH_SECURE_COOKIES'] ?? String(env['NODE_ENV'] === 'production')) === 'true' },
});
const address = await startAppHost(host, { port: Number(env['PORT'] ?? 3000), host: env['HOST'] ?? '127.0.0.1' });
process.stdout.write(\`Kosh API on \${address}\\n\`);
`;
}

export function viteConfig(options: StarterOptions): string {
  return `/** The back-office app: \`npm run web\` (proxies /api to the server, same origin for the session cookie). */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { koshPwa } from 'kosh-erp/ui/vite';
import { defineConfig } from 'vite';

const api = process.env['KOSH_API'] ?? 'http://localhost:${options.port}';

export default defineConfig({
  // koshPwa: the service worker (the app opens offline and gets web push)
  plugins: [react(), tailwindcss(), koshPwa()],
  server: { proxy: { '/api': { target: api, ws: true } } },
  preview: { proxy: { '/api': { target: api, ws: true } } },
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
  ].map(({ name, fn }) => {
    const messages = name === 'permissions' ? null : `${name}Messages`;
    return {
      line: `import { ${[messages, fn].filter((x) => x !== null).join(', ')} } from 'kosh-erp/${name}/web';`,
      call: `${fn}(registry);`,
      messages: messages === null ? null : `${name}: ${messages}`,
    };
  });
  const messages = web.map((w) => w.messages).filter((m) => m !== null);
  return `/** The back-office: the renderers of kosh-erp/ui plus every catalogue app's web contribution. */
import './index.css';
import { createDefaultRegistry, createKoshApi, KoshApp } from 'kosh-erp/ui';
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Kosh">
  <rect width="512" height="512" rx="112" fill="#1d4ed8"/>
  <path d="M156 128h56v112l108-112h72L270 258l128 126h-74L220 282v102h-64z" fill="#fff"/>
</svg>
`;
}

export function indexCss(): string {
  return `@import "tailwindcss";
@import "kosh-erp/ui/styles.css";

/* Tailwind scans Kosh's components for the classes they use. */
@source "../../node_modules/kosh-erp/dist";
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
  return `# Kosh images (kosh init). Built by compose.yaml: docker compose up -d --build
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
CMD ["sh", "-c", "npx kosh migrate && node src/server.ts"]

# The back-office: static files, /api proxied to the API.
FROM nginx:1.27-alpine AS web
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
`;
}

export function nginxConf(): string {
  return `# The back-office (kosh init): the built app, /api proxied to the API service.
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
  const user = v('POSTGRES_USER', ':-kosh');
  const lines = [
    '# Kosh in Docker (kosh init).',
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
    `      test: ["CMD-SHELL", "pg_isready -U $${v('POSTGRES_USER', ':-kosh')}"]`,
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
    ...(options.fileStorage === false ? [] : ['      KOSH_STORAGE_DIR: /app/var/attachments']),
    '      # Plain HTTP on localhost; set "true" when the site is served over HTTPS.',
    '      KOSH_SECURE_COOKIES: "false"',
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

A [Kosh](https://www.npmjs.com/package/kosh-erp) installation, created with \`kosh init\`.

\`\`\`sh
npm install
npm start          # the API on http://localhost:${options.port}
npm run web        # the back-office on http://localhost:5173 (sign in as the administrator)
npx kosh migrate   # after changing modules: plan and apply database migrations, load seed data
npx kosh seed      # load seed data again
# Settings → Apps in the back-office installs, enables and disables apps (or, in the terminal:)
npx kosh apps                   # the apps: installed, disabled, available
npx kosh apps install <name>    # install an app (and what it needs) in one transaction
npx kosh apps disable <name>    # switch an app off; its data stays (npx kosh apps enable <name>)
npx kosh module create <name>   # a new module in src/modules/<name>/
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

/** The bridges whose every connected app is in `apps`. */
export function bridgesFor(apps: readonly AppName[]): AppName[] {
  return (Object.keys(APPS) as AppName[]).filter((a) => {
    return APPS[a].bridge?.every((b) => apps.includes(b)) === true;
  });
}
