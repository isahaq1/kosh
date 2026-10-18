/**
 * The ONE place Kosh imports Shutro (CLAUDE.md, Shutro integration; RFC 0002 §6.1). Every other package imports the
 * ORM from here (`@kosh/server/orm`), so the dependency can be renamed or swapped in one file; `pnpm lint` fails if
 * another file imports `shutro` directly.
 */
import * as shutro from 'shutro';

/** The Shutro ORM API, as Kosh uses it. */
export const orm: typeof shutro = shutro;

export type * from 'shutro';
