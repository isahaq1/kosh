/** Helpers for module demo seeders (RFC 0008 §5.8). */

/** The id of the record of `model` named `name` (the module's own data, or an earlier seeder's). */
export async function idByName(env: unknown, model: string, name: string): Promise<number> {
  const found = await (
    (env as { model(name: never): unknown }).model(model as never) as {
      search(q: unknown): Promise<{ ids: readonly number[] }>;
    }
  ).search({ where: { name }, limit: 1 });
  const id = found.ids[0];
  if (id === undefined) throw new Error(`Demo data: no ${model} named "${name}".`);
  return id;
}
