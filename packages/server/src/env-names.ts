/**
 * The environment's names: installations set `SHUTRO_ERP_*` (the product's name, as in the docs and new projects);
 * the code reads the older `KOSH_*` names, which keep working. Applied once where a process starts (the server, the
 * CLI): each `SHUTRO_ERP_X` that is set fills `KOSH_X` unless that one is set too.
 */
const PREFIX = 'SHUTRO_ERP_';

/** Copies `SHUTRO_ERP_*` variables to their `KOSH_*` names in `env` (the process's by default); returns `env`. */
export function applyEnvironmentNames(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const [name, value] of Object.entries(env))
    if (name.startsWith(PREFIX) && value !== undefined) {
      const old = `KOSH_${name.slice(PREFIX.length)}`;
      if (env[old] === undefined) env[old] = value;
    }
  return env;
}
