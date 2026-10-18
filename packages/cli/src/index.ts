/**
 * @packageDocumentation
 * `@kosh/cli`: kosh new | dev | module:create | migrate | build (RFC 0001). Commands follow their RFC approvals.
 */

/** Package identity, until the RFC 0001 implementation lands. */
export const PACKAGE: { readonly name: string; readonly rfc: string } = Object.freeze({
  name: '@kosh/cli',
  rfc: 'RFC 0001',
});

/** Runs the CLI; returns the exit code. */
export async function runCli(
  argv: readonly string[],
  write: (text: string) => void,
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help') {
    write(
      'Usage: kosh <command>\n\nCommands (coming with RFC 0001): new, dev, module:create, migrate, build\n',
    );
    return argv.length === 0 ? 2 : 0;
  }
  write(`Unknown command '${argv[0]}'. Run kosh --help.\n`);
  return 2;
}
