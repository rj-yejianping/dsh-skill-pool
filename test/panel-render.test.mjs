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
/** Extra seeded `useState` value for one hook index (the MCP tool catalog). */
let hookSeed = null
/**
 * Additional hook seeds by index. The `expanded` map is hook 6, so a test that
 * wants the tools block open seeds that single object with
 * `{'mcp-tools:kb': true}`.
 */
let hookSeeds = new Map()
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
    if (hookSeed !== null && hookSeed.index === index) return [hookSeed.value, () => {}]
    if (hookSeeds.has(index)) return [hookSeeds.get(index), () => {}]
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
    modes: options.modes === undefined ? [] : options.modes,
    workspaces: options.workspaces === undefined ? [] : options.workspaces,
    description: '知识库检索',
    disclosure: options.disclosure === 'full' ? 'full' : 'progressive',
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

test('an MCP row renders its description and injection switch, with tools folded away', () => {
  boardSeed = mcpBoard()
  const html = renderPanel()
  // `TEXT.cardMcp` (en) and the tool block title are the two anchors the brief
  // names; the rest pin the new controls to the MCP row.
  assert.ok(html.includes('MCP servers'), html)
  assert.ok(html.includes('Tools'), html)
  assert.ok(html.includes('Purpose description'), html)
  assert.ok(html.includes('AI generate'), html)
  assert.ok(html.includes('Progressive injection'), html)
  // The per-tool block is collapsed by default: a 15-tool server must not push
  // the next member off-screen the moment its card renders.
  assert.equal(html.includes('mcp__kb__search'), false, 'the tool list is folded by default')
  assert.equal(html.includes('mcp__kb__gone'), false, 'the tool list is folded by default')
})

/** The per-tool catalog seed for the `kb` fixture (hook 19). */
const KB_CATALOG = {
  kb: {
    status: 'ready',
    error: '',
    discover: { ok: true, reason: '' },
    tools: [
      {
        name: 'mcp__kb__search',
        summary: 'Search the knowledge base for a phrase.',
        registered: true,
        ambiguous: false,
      },
      { name: 'mcp__kb__gone', summary: '', registered: true, ambiguous: false },
    ],
  },
}

test('an opened tool row keeps its description folded until the name is clicked', () => {
  boardSeed = mcpBoard()
  hookSeeds = new Map([
    [6, { 'mcp-tools:kb': true }],
    [19, KB_CATALOG],
  ])
  const folded = renderPanel()
  assert.ok(folded.includes('mcp__kb__search'), folded)
  assert.equal(
    folded.includes('Search the knowledge base for a phrase.'),
    false,
    'the row summary stays folded',
  )

  hookSeeds = new Map([
    [6, { 'mcp-tools:kb': true, 'mcp-tool-summary:kb:mcp__kb__search': true }],
    [19, KB_CATALOG],
  ])
  const opened = renderPanel()
  assert.ok(opened.includes('Search the knowledge base for a phrase.'), opened)
  hookSeeds = new Map()
})

test('a tool without its own scope shows the MCP server scope as inherited', () => {
  boardSeed = mcpBoard({ modes: ['standard'], workspaces: ['/w'] })
  hookSeeds = new Map([
    [6, { 'mcp-tools:kb': true }],
    [19, KB_CATALOG],
  ])
  const html = renderPanel()
  // `mcp__kb__gone` has no explicit modes/workspaces, so both chips follow the
  // member; `mcp__kb__search` carries its own values and must stay untagged.
  assert.ok(html.includes('Modes: Standard (from server)'), html)
  assert.ok(html.includes('Workspaces: w (from server)'), html)
  assert.equal((html.match(/\(from server\)/g) || []).length, 2, html)
  assert.ok(html.includes('Modes: Standard'), html)
  hookSeeds = new Map()
})

test('a tool of an unrestricted member carries no inherited tag', () => {
  // "inherit" only means something when the member restricts the dimension;
  // otherwise the tag would claim an inheritance that grants everything.
  boardSeed = mcpBoard()
  hookSeeds = new Map([
    [6, { 'mcp-tools:kb': true }],
    [19, KB_CATALOG],
  ])
  const html = renderPanel()
  assert.equal((html.match(/\(from server\)/g) || []).length, 0, html)
  hookSeeds = new Map()
})

test('the MCP row warns when the MCP gate is off', () => {
  boardSeed = mcpBoard({ mcpGate: false })
  const html = renderPanel()
  assert.ok(html.includes('MCP gate is off, progressive injection has no effect'), html)
})

/** Return the first element (walking the tree) whose props match `match`. */
function findElement(node, match) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.props && match(node.props)) return node
  for (const child of node.children || []) {
    const found = findElement(child, match)
    if (found !== undefined) return found
  }
  return undefined
}

/** The injection switch element of the MCP member card (a function component). */
function injectionSwitch() {
  hookIndex = 0
  return findElement(Panel(), (props) => props.label === 'Tool injection')
}

test('the MCP card explains an unavailable discover entry', () => {
  boardSeed = mcpBoard()
  hookSeed = {
    index: 19,
    value: { kb: { status: 'ready', error: '', tools: [], discover: { ok: false, reason: 'name-conflict' } } },
  }
  const html = renderPanel()
  assert.ok(html.includes('Discover entry unavailable: name conflict'), html)
  // The member is already progressive: switching back to full must stay possible.
  assert.equal(injectionSwitch()?.props.disabled, false)
  hookSeed = null
})

test('a full-injection member whose discover entry cannot register cannot be switched to progressive', () => {
  boardSeed = mcpBoard({ disclosure: 'full' })
  hookSeed = {
    index: 19,
    value: { kb: { status: 'ready', error: '', tools: [], discover: { ok: false, reason: 'invalid-name' } } },
  }
  renderPanel()
  const toggle = injectionSwitch()
  assert.ok(toggle, 'the injection switch renders')
  assert.equal(toggle.props.disabled, true, 'the switch would not work, so it is disabled')
  hookSeed = null
})
