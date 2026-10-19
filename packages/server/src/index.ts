/**
 * @packageDocumentation
 * `@kosh/server`: the Fastify server, module loading, the per-request Shutro environment, health checks, rate
 * limiting, logging and telemetry (RFC 0002). Shutro is reached only through `./orm.ts` (`@kosh/server/orm`).
 */
export { generateClient, typeOf } from './api/client.js';
export { IDEMPOTENCY_TABLE, idempotencyTableStatements, type Outcome } from './api/idempotency.js';
export {
  type ApiField,
  type ApiModel,
  apiModels,
  defaultFields,
  publicApiModels,
  schemaName,
} from './api/metadata.js';
export { type MenuNode, moduleVisible, Navigation } from './api/navigation.js';
export { fieldSchema, openApiDocument, openApiOf } from './api/openapi.js';
export { registerRestApi } from './api/rest.js';
export { type ServedView, type ViewField, ViewRegistry } from './api/views.js';
export { type AuditInput, audit } from './audit.js';
export {
  administrators,
  isAdministratorUser,
  keepingAdministrator,
  LAST_ADMINISTRATOR,
} from './auth/admins.js';
export { base, baseShutro } from './auth/base.js';
export {
  digest,
  hashPassword,
  newTotpSecret,
  otpauthUri,
  randomToken,
  totp,
  verifyPassword,
  verifyTotp,
} from './auth/crypto.js';
export { type InstallBaseOptions, installBase } from './auth/install.js';
export { registerAuthRoutes } from './auth/routes.js';
export {
  type AuthOptions,
  AuthService,
  cookieOf,
  SESSION_COOKIE,
  type SessionInfo,
  timeOf,
  type UserInfo,
} from './auth/service.js';
export { HttpProblem, type Problem, problemOf, ServerConfigError } from './errors.js';
export {
  type Authenticator,
  denyAll,
  isSuperuser,
  languageOf,
  type RequestIdentity,
  type RequestRunOptions,
  runOptionsOf,
} from './identity.js';
export { migrate, orm, pg } from './orm.js';
export { buildKoshRegistry, KOSH_VERSION, type KoshRegistry } from './registry.js';
export {
  createServer,
  type KoshServer,
  type ModuleContext,
  type ServerOptions,
  startServer,
} from './server.js';
export { startTelemetry, type Telemetry, tracer } from './telemetry.js';
