/**
 * @packageDocumentation
 * `@kosh/server`: the Fastify server, module loading, the per-request Shutro environment, health checks, rate
 * limiting, logging and telemetry (RFC 0002). Shutro is reached only through `./orm.ts` (`@kosh/server/orm`).
 */
export { IDEMPOTENCY_TABLE, idempotencyTableStatements, type Outcome } from './api/idempotency.js';
export {
  type ApiField,
  type ApiModel,
  apiModels,
  defaultFields,
  schemaName,
} from './api/metadata.js';
export { fieldSchema, openApiDocument } from './api/openapi.js';
export { registerRestApi } from './api/rest.js';
export { HttpProblem, type Problem, problemOf, ServerConfigError } from './errors.js';
export {
  type Authenticator,
  denyAll,
  languageOf,
  type RequestIdentity,
  type RequestRunOptions,
  runOptionsOf,
} from './identity.js';
export { orm, pg } from './orm.js';
export { buildKoshRegistry, KOSH_VERSION, type KoshRegistry } from './registry.js';
export { createServer, type KoshServer, type ServerOptions, startServer } from './server.js';
export { startTelemetry, type Telemetry, tracer } from './telemetry.js';
