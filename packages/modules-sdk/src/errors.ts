/** A manifest that cannot be right, found by `defineModule` itself. The message says what and how to fix it. */
export class ModuleDefinitionError extends Error {
  readonly module: string;
  readonly hint: string;
  constructor(module: string, problem: string, hint: string) {
    super(`Module '${module}': ${problem} ${hint}`);
    this.name = 'ModuleDefinitionError';
    this.module = module;
    this.hint = hint;
  }
}

/** A set of modules that cannot be loaded together (dependencies, versions, references between modules). */
export class ModuleLoadError extends Error {
  readonly hint: string;
  constructor(problem: string, hint: string) {
    super(`${problem} ${hint}`);
    this.name = 'ModuleLoadError';
    this.hint = hint;
  }
}
