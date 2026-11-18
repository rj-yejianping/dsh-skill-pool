/**
 * Real host-generated MCP public-name probe.
 *
 * Uses the installed dsh-mcp-client naming function for colliding synthetic
 * identities; no state, profile or credentials are used. Not part of the
 * portable default suite.
 *
 * Run: npm run test:naming
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

import { collectMcpServers } from '../src/inventory.js'
import { hasServerTools } from '../src/mount.js'
import { isAmbiguousMcpToolName, mcpServerOf } from '../src/rules.js'

const DSH_ROOT = process.env.DSH_FEASIBILITY_ROOT ?? '/opt/dsh/lib/node_modules/@deepseek-ai/dsh'

async function publicToolName() {
  const module = await import(
    pathToFileURL(join(DSH_ROOT, 'node_modules/@deepseek-ai/dsh-mcp-client/lib/types/tools.js')).href
  )
  return module.publicToolName
}

test('host-generated colliding names are treated as ambiguous everywhere', async () => {
  const generate = await publicToolName()
  const short = generate('a_', 'b')
  const shortAlt = generate('a', '_b')
  const longServer = `alpha__${'b'.repeat(45)}`
  const long = generate(longServer, 'tool12')
  console.log(JSON.stringify({ short, shortAlt, long }))

  assert.equal(short, shortAlt, 'the host gives two identities the same public name')
  for (const name of [short, long]) {
    assert.equal(isAmbiguousMcpToolName(name), true, name)
    const ctx = { get: (key) => (key === 'tools' ? { schemas: () => [{ name }] } : undefined) }
    assert.equal(hasServerTools(ctx, 'a'), false, `ready must not use ${name}`)
    assert.equal(hasServerTools(ctx, 'alpha'), false, `ready must not use ${name}`)
    assert.deepEqual(
      collectMcpServers(ctx).filter((row) => row.serverName === 'a' || row.serverName === 'alpha'),
      [],
      `inventory must not attribute ${name}`,
    )
    assert.equal(mcpServerOf(name).length > 0, true)
  }

  // Control: a normal name is still attributable and ready.
  const normal = generate('alpha', 'search')
  assert.equal(isAmbiguousMcpToolName(normal), false)
  const normalCtx = { get: (key) => (key === 'tools' ? { schemas: () => [{ name: normal }] } : undefined) }
  assert.equal(hasServerTools(normalCtx, 'alpha'), true)
  assert.deepEqual(collectMcpServers(normalCtx)[0].tools, [normal])
})
