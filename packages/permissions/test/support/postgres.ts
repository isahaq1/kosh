/** Real PostgreSQL for integration tests (Testcontainers). */
import { PostgreSqlContainer } from '@testcontainers/postgresql';

export async function startPostgres(): Promise<{ url: string; stop(): Promise<void> }> {
  const container = await new PostgreSqlContainer('postgres:18').start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}
