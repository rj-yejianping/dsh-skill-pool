/**
 * Real Panel render smoke test.
 *
 * The browser bundle has no renderer harness, so this uses a minimal React stub
 * that exercises the Panel function body (hooks, branches, warning banner). A
 * pure helper test cannot catch an undefined hook variable.
 *
 * The stub also serializes the returned element tree to text so the MCP member
 * card can be asserted without a real renderer. `useState` seeds the first
 * hook (the board) with a fixture; every other hook keeps its initial value.
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

/** Board fixture injected into Panel's first `useState` (the board). */
let boardSeed = null
/** Hook call counter for one Panel() invocation (reset by each test). */
let hookIndex = 0

function renderText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderText).join(' ')
  if (typeof node !== 'object') return ''
  const props = node.props || {}
  const propText = []
  for (const key of ['aria-label', 'title', 'placeholder', 'value']) {
    if (typeof props[key] === 'string' && props[key].length > 0) propText.push(props[key])
  }
  return [...propText, ...node.children.map(renderText)].join(' ')
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => {
    const index = hookIndex++
    if (index === 0) return [boardSeed, () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
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

let Panel
const ctx = {
  slots: {
    inject: (_name, callback) => callback(),
    register: (_spec, component) => {
      Panel = component
    },
  },
}
plugin.apply(ctx)

function renderPanel() {
  hookIndex = 0
  return renderText(Panel())
}

/** One MCP member with display configuration and a per-tool draft. */
function mcpBoard(options = {}) {
  const entry = plugin.boardState.normalizeEntry({
    enabled: true,
    modes: [],
    workspaces: [],
    description: '知识库检索',
    disclosure: 'progressive',
    tools: {
      'mcp__kb__search': { enabled: false, modes: ['standard'], workspaces: ['/w'] },
      'mcp__kb__gone': { enabled: true, modes: [], workspaces: [] },
    },
  })
  return {
    state: {
      version: 4,
      settings: { enabled: true, mcpGate: options.mcpGate !== false, gateDefaultSkills: false },
      skills: {},
      mcp: { kb: entry },
      sources: {},
      groups: {},
    },
    inventory: {
      skills: [],
      nativeSkills: [],
      mcp: [
        {
          server: 'kb',
          tools: ['mcp__kb__search'],
          toolCount: 1,
          managed: false,
          entryId: '',
          enabled: true,
          modes: [],
          workspaces: [],
          installedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      modes: [{ id: 'standard', name: 'Standard' }],
      workspaces: [],
      defaultMode: 'standard',
    },
    mounts: { kb: { state: 'ready', error: '' } },
    meta: { file: '/tmp/state.json', version: 'test' },
  }
}

test('the settings Panel renders without undefined hook state', () => {
  assert.equal(typeof Panel, 'function', 'Panel was registered')
  boardSeed = null
  assert.doesNotThrow(() => renderPanel())
})

test('an MCP row renders its description, injection switch and per-tool block', () => {
  boardSeed = mcpBoard()
  const html = renderPanel()
  // `TEXT.cardMcp` (en) and the tool block title are the two anchors the brief
  // names; the rest pin the new controls to the MCP row.
  assert.ok(html.includes('MCP servers'), html)
  assert.ok(html.includes('Tools'), html)
  assert.ok(html.includes('Purpose description'), html)
  assert.ok(html.includes('AI generate'), html)
  assert.ok(html.includes('Progressive injection'), html)
  assert.ok(html.includes('mcp__kb__search'), html)
  assert.ok(html.includes('mcp__kb__gone'), html)
})

test('the MCP row warns when the MCP gate is off', () => {
  boardSeed = mcpBoard({ mcpGate: false })
  const html = renderPanel()
  assert.ok(html.includes('MCP gate is off, progressive injection has no effect'), html)
})
