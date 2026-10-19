/**
 * The ONE place Kosh imports Shutro (CLAUDE.md, Shutro integration; RFC 0002 §6.1). Every other package imports the
 * ORM from here (`@kosh/server/orm`), so the dependency can be renamed or swapped in one file; `pnpm lint` fails if
 * another file imports `shutro` directly.
 */
import * as core from 'shutro';
import * as driverPg from 'shutro/driver-pg';
import * as migrations from 'shutro/migrate';

/** The Shutro ORM API as Kosh uses it. */
export const orm: typeof core = core;
/** Shutro's PostgreSQL driver (pools, transactions); separate because some error names overlap the core's. */
export const pg: typeof driverPg = driverPg;
/** Shutro's schema migrations: plan against the live database, versioned SQL files, apply in order. */
export const migrate: typeof migrations = migrations;

export type * from 'shutro';
export type { Driver, DriverOptions } from 'shutro/driver-pg';
export type { MigrationFile, MigrationPlan, MigrationResult } from 'shutro/migrate';
