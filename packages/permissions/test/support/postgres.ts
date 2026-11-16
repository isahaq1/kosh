/** Real PostgreSQL for integration tests (Testcontainers). */
import { testDatabase } from '@kosh/server/testing';

export async function startPostgres(): Promise<{ url: string; stop(): Promise<void> }> {
  const container = await testDatabase();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}
