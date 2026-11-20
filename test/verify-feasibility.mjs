#!/usr/bin/env node
/**
 * Cross-platform strict gate for a host-bound MCP probe.
 *
 * `DSH_FEASIBILITY_REQUIRED=1 node --test <probe>` is the POSIX form; Windows
 * `cmd` has no inline environment assignment, so this small wrapper sets the
 * variable for the child and forwards its exit code. It adds no dependency and
 * does not reinterpret the probe's result:
 *
 *   - installed DSH at the pinned version: probe runs, every check passes -> exit 0
 *   - runtime absent / different version: probe fails every check -> nonzero
 *   - probe process killed or failed to start: nonzero
 *
 * The optional `npm run test:feasibility` / `npm run test:progressive` stay
 * intentionally skippable; these commands are the release gates and must never
 * report success while unverified.
 *
 * Usage:
 *   node test/verify-feasibility.mjs [probe]
 *
 * With no argument the feasibility probe is the gate (backwards compatible);
 * `npm run verify:progressive` passes `test/mcp-progressive.probe.mjs`.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const argument = process.argv[2]
const probe = argument === undefined || argument.length === 0
  ? join(repositoryRoot, 'test', 'mcp-feasibility.probe.mjs')
  : isAbsolute(argument) ? argument : resolve(repositoryRoot, argument)
const label = probe.endsWith('mcp-progressive.probe.mjs') ? 'progressive' : 'feasibility'

if (!existsSync(probe)) {
  console.error(`[${label}] strict probe not found: ${probe}`)
  process.exit(1)
}

const child = spawn(process.execPath, ['--test', probe], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: { ...process.env, DSH_FEASIBILITY_REQUIRED: '1' },
})

child.on('error', (error) => {
  console.error(`[${label}] could not start the strict probe: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[${label}] strict probe terminated by signal ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code === 0 ? 0 : code ?? 1
})
