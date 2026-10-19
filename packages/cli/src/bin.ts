#!/usr/bin/env node
import { runCli } from './index.js';
import { detectTerminal } from './ui.js';

process.exitCode = await runCli(process.argv.slice(2), (text) => process.stdout.write(text), {
  terminal: detectTerminal(process.stdout),
});
