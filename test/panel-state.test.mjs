/**
 * The Settings panel's board reconciliation.
 *
 * The browser bundle is a plain module-loader factory with no renderer test
 * harness in this package. It exposes its pure reconciliation seam so this test
 * can exercise the exact production function used by `loadBoard`: a GET that was
 * started before a newer local edit (or before a save response) must not replace
 * that edit, while a failure-time reload still preserves an unsaved draft.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

await import('../client.js')

const React = {
  createElement: () => null,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (current) => ({ current }),
  Fragment: {},
}
const plugin = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected client require: ${id}`)
})

/** Document shape the panel consumes. */
function documentWith(description) {
  return {
    version: 4,
    settings: { enabled: true, mcpGate: true, injectSummary: true, gateDefaultSkills: false },
    skills: {},
    mcp: {
      kb: { enabled: true, modes: ['a'], workspaces: [], description },
      private: { enabled: true, modes: ['b'], workspaces: [] },
    },
    sources: {},
    groups: {},
  }
}

function draftOf(description) {
  return { enabled: true, modes: ['a'], workspaces: [], description }
}

test('board reconciliation is a real export of the client bundle', () => {
  assert.equal(typeof plugin.boardState?.applyLoadedBoard, 'function')
})

test('a reload with the same edit revision keeps an unsaved local draft', () => {
  const current = {
    state: documentWith('Draft purpose typed but not saved'),
    inventory: { mcp: [] },
    mounts: { kb: { state: 'ready' } },
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('Stored purpose from disk'),
    inventory: { mcp: [{ server: 'kb' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 7,
    currentRevision: 7,
    drafts: new Map([['mcp:kb', draftOf('Draft purpose typed but not saved')]]),
  })

  // The row draft survives, while inventory/meta/metadata are still refreshed.
  assert.equal(next.state.mcp.kb.description, 'Draft purpose typed but not saved')
  assert.deepEqual(next.inventory, loaded.inventory)
  assert.deepEqual(next.mounts, loaded.mounts)
  assert.deepEqual(next.meta, loaded.meta)
})

test('a reload started before a newer edit never replaces the state', () => {
  const current = {
    state: documentWith('Newest local purpose'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('Stale server purpose'),
    inventory: { mcp: [{ server: 'kb' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 7,
    currentRevision: 8,
    drafts: new Map(),
  })

  assert.equal(next.state, current.state, 'stale GET does not replace state')
  assert.equal(next.state.mcp.kb.description, 'Newest local purpose')
  assert.deepEqual(next.inventory, loaded.inventory)
  assert.deepEqual(next.meta, loaded.meta)
})

test('a reload with no local changes applies the server document', () => {
  const current = {
    state: documentWith('Old local purpose'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'old' },
  }
  const loaded = {
    state: documentWith('Fresh server purpose'),
    inventory: { mcp: [{ server: 'kb' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 7,
    currentRevision: 7,
    drafts: new Map(),
  })

  assert.equal(next.state.mcp.kb.description, 'Fresh server purpose')
  assert.deepEqual(next.inventory, loaded.inventory)
})

test('the initial load is applied unchanged', () => {
  const loaded = {
    state: documentWith('Initial purpose'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'new' },
  }
  const next = plugin.boardState.applyLoadedBoard(null, loaded, {
    startedRevision: 0,
    currentRevision: 0,
    drafts: new Map(),
  })
  assert.equal(next, loaded)
})

test('a draft for a member absent from the authoritative document is never re-added', () => {
  const current = {
    state: documentWith('Draft for a member deleted elsewhere'),
    inventory: { mcp: [] },
    mounts: {},
    meta: { version: 'old' },
  }
  const authoritative = documentWith('Unused server purpose')
  delete authoritative.mcp.kb
  const loaded = {
    state: authoritative,
    inventory: { mcp: [{ server: 'private' }] },
    mounts: {},
    meta: { version: 'new' },
  }

  const next = plugin.boardState.applyLoadedBoard(current, loaded, {
    startedRevision: 9,
    currentRevision: 9,
    drafts: new Map([['mcp:kb', draftOf('Draft for a member deleted elsewhere')]]),
  })

  assert.equal(Object.hasOwn(next.state.mcp, 'kb'), false, 'no phantom row is resurrected')
  assert.equal(next.state.mcp.private.enabled, true)
  assert.deepEqual(next.inventory, loaded.inventory)
})

test('orphaned drafts are exposed with their unsaved entry for a visible warning', () => {
  const authoritative = documentWith('Server purpose')
  delete authoritative.mcp.kb
  authoritative.skills['still-here'] = { enabled: true, modes: ['a'], workspaces: [] }
  const orphans = plugin.boardState.orphanedDrafts(authoritative, new Map([
    ['mcp:kb', draftOf('Unsaved knowledge base text')],
    ['skill:still-here', { enabled: false, modes: ['a'], workspaces: [] }],
  ]))

  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].key, 'mcp:kb')
  assert.equal(orphans[0].entry.description, 'Unsaved knowledge base text')
})

test('a save response cannot resurrect a member deleted meanwhile', () => {
  const current = documentWith('Fresh local state')
  delete current.mcp.kb
  const canonical = { enabled: true, modes: ['a'], workspaces: [], description: 'Stale save result' }
  const next = plugin.boardState.applyItemSave(current, 'mcp', 'kb', canonical)
  assert.equal(next, current, 'the removed row is not re-added by its old save response')
  assert.equal(Object.hasOwn(next.mcp, 'kb'), false)
})

test('a save response still updates an existing member', () => {
  const current = documentWith('Old purpose')
  const canonical = { enabled: true, modes: ['a'], workspaces: [], description: 'Saved purpose' }
  const next = plugin.boardState.applyItemSave(current, 'mcp', 'kb', canonical)
  assert.equal(next.mcp.kb.description, 'Saved purpose')
  assert.equal(next.mcp.private.enabled, true)
})

test('the discarded-draft warning preserves the unsaved text visibly', () => {
  const message = plugin.boardState.draftLossMessage([
    { key: 'mcp:kb', entry: { enabled: true, modes: ['a'], workspaces: [], description: 'Unsaved knowledge base text' } },
  ])
  assert.ok(message.includes('kb'), message)
  assert.ok(message.includes('Unsaved knowledge base text'), message)
  assert.ok(message.toLowerCase().includes('unsaved'), message)
})
