/**
 * First installation of `base`: a currency, the first company and the first administrator, in one audited system
 * scope. Run once, after the schema exists.
 */
import type { Env, Shutro } from '../orm.js';
import type { AuthService } from './service.js';

/** Options of {@link installBase}. */
export interface InstallBaseOptions {
  readonly company: { readonly name: string; readonly currency: string };
  readonly admin: { readonly login: string; readonly name: string; readonly password: string };
}

/** Creates the first company and administrator; returns their ids. */
export async function installBase(
  shutro: Shutro,
  auth: AuthService,
  options: InstallBaseOptions,
): Promise<{ company: number; admin: number }> {
  const company = await shutro.bootstrap({ reason: 'install base' }, async (env: Env) => {
    const model = (name: string) =>
      env.model(name as never) as unknown as {
        create(rows: readonly unknown[]): Promise<{ ids: readonly number[] }>;
      };
    const [currency] = (await model('res.currency').create([{ name: options.company.currency }]))
      .ids;
    const [created] = (
      await model('res.company').create([{ name: options.company.name, currency }])
    ).ids;
    return created as number;
  });
  const admin = await auth.createUser({
    ...options.admin,
    company,
    companies: [company],
    groups: ['base.admin'],
  });
  return { company, admin };
}
