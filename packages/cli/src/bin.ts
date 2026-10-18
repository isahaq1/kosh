#!/usr/bin/env node
import { runCli } from './index.js';

process.exitCode = await runCli(process.argv.slice(2), (text) => process.stdout.write(text));
