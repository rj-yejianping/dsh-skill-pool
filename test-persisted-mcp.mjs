/**
 * Local acceptance checks for the persisted-MCP change (not shipped).
 * Run: node test-persisted-mcp.mjs
 */
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  StateStore,
  cleanMcpDefinition,
  defaultState,
  normalizeState,
  removeItem,
  upsertItem,
} from './src/store.js'
import { createMountTracker } from './src/uploads.js'
import { remountPoolServers } from './src/remount.js'

const definition = {
  transport: 'streamable-http',
  serverName: 'kb',
  url: 'http://example.invalid/mcp',
  headers: { Authorization: 'Bearer secret' },
}

// 1. a definition survives normalization and scope-only edits
let state = upsertItem(defaultState(), 'mcp', 'kb', { enabled: true, modes: ['standard'], workspaces: [] }, { definition })
assert.deepEqual(state.mcp.kb.definition, definition)
state = upsertItem(state, 'mcp', 'kb', { enabled: false, modes: [], workspaces: [] })
assert.equal(state.mcp.kb.enabled, false, 'scope edit applies')
assert.deepEqual(state.mcp.kb.definition, definition, 'scope edit keeps definition')

// 2. junk definitions are dropped, never stored
assert.equal(cleanMcpDefinition({ headers: { a: 1 } }), undefined)
assert.equal(cleanMcpDefinition('nope'), undefined)

// 3. skill members never gain a definition
let skillState = upsertItem(defaultState(), 'skill', 'demo', { enabled: true, modes: [], workspaces: [] })
assert.equal('definition' in skillState.skills.demo, false)

// 4. removal drops it again
assert.equal(Object.hasOwn(removeItem(state, 'mcp', 'kb').mcp, 'kb'), false)

// 5. unknown document versions still reset (no silent migration)
assert.deepEqual(normalizeState({ version: 2, mcp: { kb: { definition } } }).mcp, {})

// 6. the file is written 0600 because it can hold an Authorization header
const dir = await mkdtemp(join(tmpdir(), 'rp-test-'))
const file = join(dir, 'state.json')
const store = new StateStore({ file })
await store.write(state)
const info = await stat(file)
assert.equal(info.mode & 0o777, 0o600, 'state file is owner-only')
assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcp.kb.definition, definition)

// 7. boot remount rebuilds the loader row from the stored definition only
const created = []
const ctx = {
  get(name) {
    if (name === 'loader') {
      return {
        resolve(id) {
          throw new Error(`unknown entry ${id}`)
        },
        async create(entry) {
          created.push(entry)
        },
        async update() {
          throw new Error('unexpected update')
        },
      }
    }
    if (name === 'tools') return { schemas: () => [{ name: 'mcp__kb__search' }] }
    return undefined
  },
}
const mounts = createMountTracker()
const result = await remountPoolServers({ ctx, getState: async () => state, mounts })
// member is disabled in `state` by now, so it must be skipped
assert.deepEqual(result.mounted, [])
assert.deepEqual(result.skipped, ['kb'])

const enabled = upsertItem(defaultState(), 'mcp', 'kb', { enabled: true, modes: [], workspaces: [] }, { definition })
const result2 = await remountPoolServers({ ctx, getState: async () => enabled, mounts })
assert.deepEqual(result2.mounted, ['kb'])
await new Promise((resolve) => setTimeout(resolve, 150))
assert.equal(mounts.status().kb.state, 'ready', 'remount reaches ready when tools appear')
assert.equal(created.length, 1)
assert.equal(created[0].id, 'rp-kb')
assert.equal(created[0].name, '@deepseek-ai/dsh-mcp-client')
assert.deepEqual(created[0].config, definition)

console.log('all persisted-MCP checks passed')
