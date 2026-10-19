/**
 * The starter project `kosh init` writes: an API server and the back-office app, both importing `kosh-erp`.
 * Server files run on Node.js directly (type stripping); the back-office is a Vite app proxying `/api` to the server.
 */

export type AppName = 'permissions' | 'reporting' | 'messaging';
export interface AppSpec {
  readonly label: string;
  /** Shown next to the app in the installer (where the terminal shows pictographs). */
  readonly icon: string;
  /** The module's export in `kosh-erp/<app>`. */
  readonly server: string;
  /** The web registration in `kosh-erp/<app>/web`. */
  readonly web: string;
}

/** The framework apps `kosh init` can install (base is always there). */
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

export function modulesTs(options: StarterOptions): string {
  const imports = options.apps.map((a) => `import { ${APPS[a].server} } from 'kosh-erp/${a}';`);
  return `/**
 * The modules of this installation. \`base\` (users, companies, sign-in) comes with every module; add your own
 * modules here (\`defineModule\` from \`kosh-erp/modules-sdk\`), then run \`npx kosh migrate\`.
 */
import { base } from 'kosh-erp';
${imports.join('\n')}

export const modules = [base${options.apps.map((a) => `, ${APPS[a].server}`).join('')}];
`;
}

export function serverTs(): string {
  return `/** The Kosh API server: \`npm start\` (reads .env). */
import { createServer, startServer } from 'kosh-erp';
import { modules } from './modules.ts';

const env = process.env;
const server = await createServer({
  databaseUrl: String(env['DATABASE_URL']),
  modules,
  ...(env['VALKEY_URL'] ? { valkeyUrl: env['VALKEY_URL'] } : {}),
  // Secure cookies need HTTPS: on by default in production (KOSH_SECURE_COOKIES=false for plain HTTP).
  auth: { secureCookies: (env['KOSH_SECURE_COOKIES'] ?? String(env['NODE_ENV'] === 'production')) === 'true' },
});
const address = await startServer(server, { port: Number(env['PORT'] ?? 3000), host: env['HOST'] ?? '127.0.0.1' });
process.stdout.write(\`Kosh API on \${address}\\n\`);
`;
}

export function viteConfig(options: StarterOptions): string {
  return `/** The back-office app: \`npm run web\` (proxies /api to the server, same origin for the session cookie). */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env['KOSH_API'] ?? 'http://localhost:${options.port}';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': api } },
  preview: { proxy: { '/api': api } },
});
`;
}

export function indexHtml(options: StarterOptions): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>${options.name.replace(/[<>&"]/g, '')}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
`;
}

export function mainTsx(options: StarterOptions): string {
  const web = options.apps.map((a) => {
    const fn = APPS[a].web;
    const messages = a === 'permissions' ? null : `${a}Messages`;
    return {
      line: `import { ${[messages, fn].filter((x) => x !== null).join(', ')} } from 'kosh-erp/${a}/web';`,
      call: `${fn}(registry);`,
      messages: messages === null ? null : `${a}: ${messages}`,
    };
  });
  const messages = web.map((w) => w.messages).filter((m) => m !== null);
  return `/** The back-office: the renderers of kosh-erp/ui plus each installed app's web contribution. */
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
npx kosh module create <name>   # a new module in src/modules/<name>/
docker compose up -d --build    # everything in Docker: http://localhost:8080
\`\`\`

Settings (database, file storage, port) are in \`.env\`, which is not committed. Modules are listed in
\`src/modules.ts\`.
`;
}
