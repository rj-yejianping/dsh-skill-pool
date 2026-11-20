/**
 * Synthetic real-Panel render harness (no browser, no live state).
 *
 * Implements a tiny React hooks runtime good enough for the production Panel
 * body: persistent state/refs, stable useCallback slots, effect-on-dependency
 * change, and synchronous re-render on setState. All network is stubbed.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

let captured
globalThis.window = {
  __ModuleLoader__: { load(spec) { captured = spec } },
}

const runtime = {
  cursor: 0,
  states: [],
  refs: [],
  callbacks: [],
  effects: [],
  rendering: false,
  pending: false,
  render: null,
}

function scheduleRender() {
  runtime.pending = true
  if (runtime.rendering) return
  queueMicrotask(() => {
    if (!runtime.pending || runtime.render === null) return
    runtime.pending = false
    runtime.render()
  })
}

function depsChanged(a, b) {
  if (!a || !b || a.length !== b.length) return true
  return a.some((value, index) => !Object.is(value, b[index]))
}

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.flat(Infinity) },
  }),
  useState(initial) {
    const index = runtime.cursor++
    if (!(index in runtime.states)) {
      runtime.states[index] = typeof initial === 'function' ? initial() : initial
    }
    return [
      runtime.states[index],
      (value) => {
        runtime.states[index] = typeof value === 'function' ? value(runtime.states[index]) : value
        scheduleRender()
      },
    ]
  },
  useEffect(effect, deps) {
    const index = runtime.cursor++
    const previous = runtime.effects[index]
    if (previous && !depsChanged(previous.deps, deps)) return
    if (previous && typeof previous.cleanup === 'function') previous.cleanup()
    runtime.effects[index] = { deps: deps || [], cleanup: undefined }
    const cleanup = effect()
    runtime.effects[index].cleanup = cleanup
  },
  useCallback(fn) {
    const index = runtime.cursor++
    if (!runtime.callbacks[index]) runtime.callbacks[index] = fn
    return runtime.callbacks[index]
  },
  useMemo(fn) {
    runtime.cursor++
    return fn()
  },
  useRef(current) {
    const index = runtime.cursor++
    if (!runtime.refs[index]) runtime.refs[index] = { current }
    return runtime.refs[index]
  },
  Fragment: Symbol('Fragment'),
}

await import('../client.js')

const plugin = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected client require: ${id}`)
})

let Panel
plugin.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register: (_spec, component) => { Panel = component },
  },
})

// ---------------------------------------------------------------- UI helpers

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (typeof node === 'string' || typeof node === 'number') { visit({ text: String(node) }); return }
  visit(node)
  if (node.props && node.props.children) walk(node.props.children, visit)
}

function textOf(node) {
  const parts = []
  walk(node, (entry) => { if (entry.text !== undefined) parts.push(entry.text) })
  return parts.join(' ')
}

function findAll(root, predicate) {
  const out = []
  walk(root, (node) => { if (node && !node.text && predicate(node)) out.push(node) })
  return out
}

function byText(root, exact) {
  return findAll(root, (node) => textOf(node).trim() === exact)
}

function click(node, text) {
  assert.equal(typeof node.props.onClick, 'function', `clickable: ${text}`)
  node.props.onClick({ currentTarget: { blur() {} }, target: {} })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------------- network stub

const calls = []
let boardState = {
  version: 4,
  settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
  skills: {
    shared: {
      enabled: true, modes: [], workspaces: [], modesFrom: 'group', workspacesFrom: 'group',
      sourceId: 'src_a', installedAt: '2026-11-18T00:00:00.000Z',
    },
  },
  mcp: {
    kb: { enabled: true, modes: [], workspaces: [], installedAt: '2026-11-18T00:00:00.000Z' },
  },
  sources: {
    src_a: {
      id: 'src_a', kind: 'git', label: 'example/project@main',
      url: 'https://github.com/example/project', provider: 'github', project: 'example/project',
      branch: 'main', subdir: '', skills: ['shared'], excluded: [], createdAt: '2026-11-18T00:00:00.000Z',
    },
  },
  groups: {
    'repo:example/project': {
      key: 'repo:example/project', kind: 'repo', enabled: true,
      modes: ['standard'], workspaces: ['/workspace'],
    },
  },
}

function boardPayload() {
  return {
    ok: true,
    state: boardState,
    inventory: {
      skills: [{
        name: 'shared', description: 'synthetic skill', path: '/tmp/shared', dir: '/tmp/shared',
        missing: false, sourceId: 'src_a', sourceLabel: 'example/project',
        groupKey: 'repo:example/project', groupName: 'example/project',
        enabled: true, modes: [], workspaces: [], modesFrom: 'group', workspacesFrom: 'group',
        effectiveModes: ['standard'], effectiveWorkspaces: ['/workspace'],
        installedAt: '2026-11-18T00:00:00.000Z', modelInvocable: true,
      }],
      nativeSkills: [],
      mcp: [{ server: 'kb', tools: ['mcp__kb__search'], toolCount: 1, managed: true, entryId: 'rp-kb', enabled: true, modes: [], workspaces: [] }],
      modes: [{ id: 'standard', name: 'Standard' }, { id: 'ptc', name: 'PTC' }],
      workspaces: [{ id: 'w1', name: 'workspace', path: '/workspace' }],
      defaultMode: 'standard',
    },
    mounts: { kb: { state: 'ready' } },
    meta: { file: '/tmp/does-not-exist/state.json', version: 'review' },
  }
}

let itemResponse = null
/** Tool rows served by `GET /mcp/tools`. */
let mcpToolRows = []
/** Text served by `POST /mcp/describe`. */
let describeText = ''

globalThis.fetch = async (url, init = {}) => {
  const method = (init.method || 'GET').toUpperCase()
  const target = String(url)
  calls.push({ method, target, body: init.body })
  let payload
  if (target.includes('/mcp/tools')) {
    payload = {
      ok: true,
      server: 'kb',
      description: '',
      disclosure: 'progressive',
      discover: { ok: true, reason: '' },
      tools: mcpToolRows,
    }
  } else if (target.includes('/mcp/tool')) {
    const body = JSON.parse(init.body || '{}')
    const member = boardState.mcp[body.server]
    const tools = { ...member.tools }
    if (body.clear === true) delete tools[body.tool]
    else tools[body.tool] = { enabled: body.enabled, modes: body.modes, workspaces: body.workspaces }
    boardState = {
      ...boardState,
      mcp: { ...boardState.mcp, [body.server]: { ...member, tools } },
    }
    payload = { ok: true, state: boardState }
  } else if (target.includes('/mcp/config')) {
    const body = JSON.parse(init.body || '{}')
    const member = boardState.mcp[body.server]
    const next = { ...member }
    if (body.description !== undefined) next.description = body.description
    if (body.disclosure !== undefined) next.disclosure = body.disclosure
    boardState = { ...boardState, mcp: { ...boardState.mcp, [body.server]: next } }
    payload = { ok: true, state: boardState }
  } else if (target.includes('/mcp/describe')) {
    payload = { ok: true, description: describeText }
  } else if (target.includes('/item')) {
    const body = JSON.parse(init.body || '{}')
    if (typeof itemResponse === 'function') payload = await itemResponse(body)
    else payload = { ok: true, state: boardState }
    if (payload && payload.ok && payload.state) boardState = payload.state
  } else if (target.includes('/resolve')) {
    payload = { ok: true, pool: { mode: 'standard', cwd: '/workspace', gated: true, gateSkills: true, gateMcp: false, skills: ['shared'], mcpServers: [] } }
  } else {
    payload = boardPayload()
  }
  return { ok: true, status: 200, json: async () => payload }
}

// ------------------------------------------------------------------- render

let tree = null

/** Drop every hook slot so a test can start from a fresh first render. */
function resetRuntime() {
  runtime.cursor = 0
  runtime.states = []
  runtime.refs = []
  runtime.callbacks = []
  runtime.effects = []
}

function render() {
  runtime.rendering = true
  runtime.cursor = 0
  try {
    tree = Panel()
  } finally {
    runtime.rendering = false
  }
}

function rerender() {
  scheduleRender()
}

test('the real Panel renders the persistent degradation banner and inherit interaction', async () => {
runtime.render = render
render()
await sleep(30)
rerender()
await sleep(30)

// The first GET must have populated the board: the skill row is now real.
const expand = findAll(tree, (node) => node.props && node.props['aria-label'] === 'Expand')[0]
assert.ok(expand, 'group caret rendered')
click(expand, 'expand group')
await sleep(30)
assert.ok(textOf(tree).includes('shared'), 'the synthetic skill row rendered')
assert.ok(textOf(tree).includes('kb'), 'the synthetic MCP row rendered')
assert.ok(textOf(tree).includes('1 tools'), 'the MCP tool count rendered')
assert.ok(textOf(tree).includes('(inherited)'), 'the inherited marker rendered on the condition chips')

// Expand the condition editor via the member Modes chip (the group header has
// its own chips; the member row's chips come later in the tree).
const memberChips = findAll(
  tree,
  (node) => node.props && node.props.role === 'button' && node.props.title === 'Conditions',
)
const modesChip = memberChips.find((node) => textOf(node).includes('(inherited)'))
assert.ok(modesChip, 'member conditions chip exists')
click(modesChip, 'member conditions chip')
await sleep(20)

assert.ok(textOf(tree).includes('inherit'), 'inherit control rendered')
const custom = byText(tree, 'custom')
assert.equal(custom.length >= 2, true, 'two inherit toggles rendered (modes + workspaces)')
click(custom[0], 'modes custom')

await sleep(500) // 320ms debounce + flush

const itemCall = calls.find((call) => call.method === 'POST' && call.target.includes('/item'))
assert.ok(itemCall, 'autosave POST /item fired')
const body = JSON.parse(itemCall.body)
assert.equal(body.modesFrom, 'self')
assert.deepEqual(body.modes, ['standard'], 'panel sent the inherited value while switching to self')

// The server response carries a redacted activation warning; it must render as
// a persistent banner (not just a 3.2s toast).
itemResponse = async (requestBody) => ({
  ok: true,
  state: {
    ...boardState,
    skills: {
      ...boardState.skills,
      shared: { ...boardState.skills.shared, modes: requestBody.modes, modesFrom: requestBody.modesFrom },
    },
  },
  warning: { code: 'resource-pool/activation-degraded', message: 'Saved, but 1 session kept its old restriction.' },
})

const secondCustom = byText(tree, 'custom')[0]
assert.ok(secondCustom, 'custom toggle still present after save')
click(secondCustom, 'custom again')
await sleep(500)

const rendered = textOf(tree)
assert.ok(rendered.includes('Saved, but 1 session kept its old restriction.'), 'activation warning banner rendered')
assert.ok(rendered.includes('shared'), 'resource row still rendered next to the banner')

// A later successful GET (refresh) must not clear the warning.
const refresh = byText(tree, 'Refresh')[0]
assert.ok(refresh, 'refresh button rendered')
click(refresh, 'refresh')
await sleep(60)
assert.ok(textOf(tree).includes('Saved, but 1 session kept its old restriction.'), 'warning survived a successful refresh')

// Closing it clears the banner explicitly.
const close = byText(tree, 'Close')[0]
assert.ok(close, 'close button on banner rendered')
click(close, 'close')
await sleep(30)
assert.equal(textOf(tree).includes('Saved, but 1 session kept its old restriction.'), false, 'close dismissed the warning')

// Other tabs render their production bodies as well.
const sourcesTab = byText(tree, 'Sources')[0]
assert.ok(sourcesTab, 'Sources tab rendered')
click(sourcesTab, 'Sources tab')
await sleep(30)
assert.ok(textOf(tree).includes('example/project'), 'source row rendered')
assert.ok(textOf(tree).includes('Update'), 'source update control rendered')

const settingsTab = byText(tree, 'Settings')[0]
assert.ok(settingsTab, 'Settings tab rendered')
click(settingsTab, 'Settings tab')
await sleep(30)
assert.equal(textOf(tree).includes('Group switches'), false, 'the group-switch card is gone')
assert.ok(textOf(tree).includes('State file'), 'settings state file row rendered')

console.log(JSON.stringify({
  ok: true,
  itemBody: body,
  calls: calls.map((call) => `${call.method} ${call.target.split('?')[0]}`),
}, null, 2))
})

test('the MCP card saves an AI-generated description and inherits the member scope', async () => {
  resetRuntime()
  calls.length = 0
  itemResponse = null
  describeText = 'Generated purpose text.'
  mcpToolRows = [
    { name: 'mcp__kb__search', summary: 'Search the knowledge base.', registered: true, ambiguous: false },
  ]
  boardState = {
    version: 4,
    settings: { enabled: true, mcpGate: true, gateDefaultSkills: false },
    skills: {},
    sources: {},
    groups: {},
    mcp: {
      kb: {
        enabled: true,
        modes: ['standard'],
        workspaces: [],
        description: '',
        disclosure: 'progressive',
        tools: {},
        installedAt: '2026-11-18T00:00:00.000Z',
      },
    },
  }
  runtime.render = render
  render()
  await sleep(40)

  // Folded by default: the member card renders, its tool rows do not.
  assert.equal(textOf(tree).includes('mcp__kb__search'), false, 'tools folded by default')

  const toolsHead = findAll(
    tree,
    (node) => node.props && node.props.role === 'button' && textOf(node).includes('Tools'),
  )[0]
  assert.ok(toolsHead, 'tools header rendered')
  click(toolsHead, 'tools header')
  await sleep(40)
  assert.ok(textOf(tree).includes('mcp__kb__search'), 'the tool row appears after expanding')

  // A second disclosure level: the row summary stays folded until the name is
  // clicked, so a long catalog stays a list.
  assert.equal(textOf(tree).includes('Search the knowledge base.'), false, 'row summary folded')
  const toolName = findAll(
    tree,
    (node) => node.props && node.props.role === 'button' && textOf(node).trim() === 'mcp__kb__search',
  )[0]
  assert.ok(toolName, 'the tool name is a disclosure trigger')
  click(toolName, 'tool name')
  await sleep(40)
  assert.ok(textOf(tree).includes('Search the knowledge base.'), 'row summary opens on click')

  // An unconfigured tool follows the member scope and says so.
  assert.ok(textOf(tree).includes('Modes: Standard (from server)'), textOf(tree))

  // AI generation must reach the Host, not only the field: a description the
  // panel never queued used to vanish on the next board read.
  const aiButton = byText(tree, 'AI generate')[0]
  assert.ok(aiButton, 'AI generate rendered')
  click(aiButton, 'AI generate')
  await sleep(200)
  const configCall = calls.find((call) => call.method === 'POST' && call.target.includes('/mcp/config'))
  assert.ok(configCall, 'the generated description was saved')
  assert.equal(JSON.parse(configCall.body).description, describeText)
  assert.equal(boardState.mcp.kb.description, describeText, 'the Host kept the generated text')

  // Choosing "set separately" seeds the editor with the inherited value, so the
  // switch from inherit to explicit never drops the member scope.
  const modesChip = findAll(
    tree,
    (node) =>
      node.props &&
      node.props.role === 'button' &&
      textOf(node).trim().startsWith('Modes: Standard (from server)'),
  )[0]
  assert.ok(modesChip, 'the inherited modes chip rendered')
  click(modesChip, 'tool modes chip')
  await sleep(40)
  const custom = findAll(
    tree,
    (node) => node.props && typeof node.props.onClick === 'function' && textOf(node).trim() === 'custom',
  )[0]
  assert.ok(custom, 'the separate-setting control rendered')
  click(custom, 'tool modes custom')
  await sleep(500)
  const toolCall = calls.find((call) => call.method === 'POST' && call.target.includes('/mcp/tool'))
  assert.ok(toolCall, 'per-tool scope save fired')
  const toolBody = JSON.parse(toolCall.body)
  assert.equal(toolBody.tool, 'mcp__kb__search')
  assert.deepEqual(toolBody.modes, ['standard'], 'the inherited value was copied, not dropped')
})
