/** Real PostgreSQL and Valkey for integration tests (Testcontainers). */

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { type TestDatabase, testDatabase } from '../../src/testing.js';

export interface Services {
  readonly databaseUrl: string;
  readonly valkeyUrl: string;
  stop(): Promise<void>;
}

export async function startServices(): Promise<Services> {
  const [postgres, valkey] = (await Promise.all([
    testDatabase(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start(),
  ])) as [TestDatabase, StartedTestContainer];
  return {
    databaseUrl: postgres.getConnectionUri(),
    valkeyUrl: `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`,
    async stop() {
      await Promise.all([postgres.stop(), valkey.stop()]);
    },
  };
}
