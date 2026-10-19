/**
 * The ONE place Kosh imports Shutro (CLAUDE.md, Shutro integration; RFC 0002 §6.1). Every other package imports the
 * ORM from here (`@isahaq/kosh-server/orm`), so the dependency can be renamed or swapped in one file; `pnpm lint` fails if
 * another file imports `shutro` directly.
 */
import * as core from 'shutro';
import * as driverPg from 'shutro/driver-pg';

/** The Shutro ORM API as Kosh uses it. */
export const orm: typeof core = core;
/** Shutro's PostgreSQL driver (pools, transactions); separate because some error names overlap the core's. */
export const pg: typeof driverPg = driverPg;

export type * from 'shutro';
export type { Driver, DriverOptions } from 'shutro/driver-pg';
