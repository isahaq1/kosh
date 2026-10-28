#!/usr/bin/env node
import { applyEnvironmentNames } from '@kosh/server';
import { runCli } from './index.js';
import { detectTerminal } from './ui.js';

// SHUTRO_ERP_* settings, read under their older KOSH_* names.
applyEnvironmentNames();
process.exitCode = await runCli(process.argv.slice(2), (text) => process.stdout.write(text), {
  terminal: detectTerminal(process.stdout),
});
