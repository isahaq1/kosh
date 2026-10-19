#!/usr/bin/env node
// Committed launcher for the built CLI: pnpm links a workspace bin only when its file exists at install time, which
// is before `pnpm build` writes dist/ (a fresh clone in CI would have no `kosh` command).
import '../dist/bin.js';
