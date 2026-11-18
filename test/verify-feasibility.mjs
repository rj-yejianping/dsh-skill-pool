#!/usr/bin/env node
/**
 * Cross-platform strict gate for the host-bound MCP feasibility probe.
 *
 * `DSH_FEASIBILITY_REQUIRED=1 node --test test/mcp-feasibility.probe.mjs` is the
 * POSIX form; Windows `cmd` has no inline environment assignment, so this small
 * wrapper sets the variable for the child and forwards its exit code. It adds no
 * dependency and does not reinterpret the probe's result:
 *
 *   - installed DSH at the pinned version: probe runs, 21/21 pass -> exit 0
 *   - runtime absent / different version: probe fails every check -> nonzero
 *   - probe process killed or failed to start: nonzero
 *
 * The optional `npm run test:feasibility` intentionally stays skippable; this
 * command is the release gate and must never report success while unverified.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const probe = join(repositoryRoot, 'test', 'mcp-feasibility.probe.mjs')

const child = spawn(process.execPath, ['--test', probe], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: { ...process.env, DSH_FEASIBILITY_REQUIRED: '1' },
})

child.on('error', (error) => {
  console.error(`[feasibility] could not start the strict probe: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[feasibility] strict probe terminated by signal ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code === 0 ? 0 : code ?? 1
})
