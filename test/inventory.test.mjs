import assert from 'node:assert/strict'
import test from 'node:test'

import { collectMcpServers, collectModes, collectModesAsync } from '../src/inventory.js'

/** Minimal plugin context stub for the mode collectors. */
function context() {
  const services = {
    agents: {
      list: () => [{ session: { header: { agentPreset: 'cordis' } } }],
    },
    agentPresets: {
      defaultId: 'standard',
      list: async () => [
        { id: 'standard', name: 'Standard', order: 1 },
        { id: 'cordis', name: 'Cordis', order: 2 },
      ],
    },
  }
  return { get: (name) => services[name] }
}

test('collectModes no longer offers the synthetic default mode', () => {
  const ids = collectModes(context()).map((mode) => mode.id)
  assert.deepEqual(ids, ['cordis'])
  assert.equal(ids.includes('default'), false)
})

test('collectModesAsync lists real presets by order and never default', async () => {
  const ids = (await collectModesAsync(context())).map((mode) => mode.id)
  assert.deepEqual(ids, ['standard', 'cordis'])
})

test('a session whose preset is unknown is still listed once', async () => {
  const services = {
    agents: { list: () => [{ session: { header: { agentPreset: 'custom' } } }] },
    agentPresets: { list: async () => [{ id: 'standard', name: 'Standard', order: 1 }] },
  }
  const ids = (await collectModesAsync({ get: (name) => services[name] })).map((mode) => mode.id)
  assert.deepEqual(ids, ['standard', 'custom'])
})

test('collectMcpServers does not attribute an ambiguous public name to a server prefix', () => {
  const ctx = {
    get: (name) => (name === 'tools' ? { schemas: () => [{ name: 'mcp__alpha__search' }, { name: 'mcp__alpha__a__x' }, { name: 'mcp__alpha___b' }] } : undefined),
  }
  const rows = collectMcpServers(ctx)
  const alpha = rows.find((row) => row.serverName === 'alpha')
  assert.deepEqual(alpha.tools, ['mcp__alpha__search'])
  assert.equal(alpha.toolCount, 1)
})
