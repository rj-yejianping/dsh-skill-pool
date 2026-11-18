/**
 * Real ToolsService + activation probe (host-bound).
 *
 * Mounts the installed Cordis/system-prompt/tools services and drives the
 * production activation manager with a real agent scope. It injects a real
 * unregister-between-schemas-and-restrict race. No state file, profile or
 * credentials are used.
 *
 * Run: npm run test:activation
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createActivation } from '../src/activation.js'
import { normalizeState, StateReadError } from '../src/store.js'

const DSH_ROOT = process.env.DSH_FEASIBILITY_ROOT ?? '/opt/dsh/lib/node_modules/@deepseek-ai/dsh'
const load = (id) => import(pathToFileURL(join(DSH_ROOT, 'node_modules', id)).href)
const [{ Context }, { createScope }, { default: SystemPrompt }, { default: ToolsService }] = await Promise.all([
  load('@deepseek-ai/cordis/lib/index.js'),
  load('@deepseek-ai/dsh-scope/lib/index.js'),
  load('@deepseek-ai/dsh-system-prompt/lib/index.js'),
  load('@deepseek-ai/dsh-tools/lib/index.js'),
])

function definition(name) {
  return {
    name,
    description: 'synthetic activation probe tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: () => [{ type: 'text', text: name }],
    },
  }
}

function stateWith({ deny = [], allow = [], extra = [] } = {}) {
  const mcp = {}
  for (const name of [...deny, ...allow, ...extra]) {
    mcp[name] = {
      enabled: true,
      modes: deny.includes(name) || extra.includes(name) ? ['b'] : [],
      workspaces: [],
      installedAt: '2026-11-19T00:00:00.000Z',
    }
  }
  return normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, injectSummary: false, gateDefaultSkills: false },
    skills: {}, sources: {}, groups: {}, mcp,
  })
}

async function harness(names) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolsService)
  const key = {}
  let hostCtx
  let scoped
  await root.plugin({
    name: 'activation-restrict-probe',
    inject: ['tools'],
    apply(ctx) {
      hostCtx = ctx
      scoped = createScope(ctx, key)
      for (const name of names) ctx.tools.register(definition(name))
    },
  })
  const agent = {
    session: { header: { agentPreset: 'a', cwd: '/workspace' } },
    ctx: scoped.ctx,
  }
  const toolsView = { schemas: () => root.tools.schemas() }
  const logger = { warn() {}, debug() {}, info() {} }
  return {
    root,
    key,
    agent,
    hostCtx,
    toolsView,
    logger,
    visible() {
      return root.tools.schemas(key).map((schema) => schema.name).sort()
    },
    async dispose() {
      await root.fiber.dispose()
    },
  }
}

test('real activation: an all-allowed zero-layer record gets a conservative deny on later failure', async () => {
  const h = await harness(['mcp__kb__search', 'mcp__other__x'])
  let state = stateWith({ allow: ['kb', 'other'] })
  let corrupt = false
  const activation = createActivation({
    ctx: { get: (name) => (name === 'tools' ? h.toolsView : h.root.get(name)) },
    getState: async () => {
      if (corrupt) throw new StateReadError('resource-pool/state-invalid-json', 'synthetic corrupt state')
      return state
    },
    logger: h.logger,
    libraryRoot: () => '/nonexistent-library',
  })
  try {
    await activation.applyToAgent(h.agent)
    assert.deepEqual(h.visible(), ['mcp__kb__search', 'mcp__other__x'], 'all tools allowed: no layer')

    h.hostCtx.tools.register(definition('mcp__new__x'))
    state = stateWith({ allow: ['kb', 'other'] })
    corrupt = true
    const result = await activation.applyToAgent(h.agent, { force: true, conservative: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'resource-pool/activation-conservative')
    assert.deepEqual(h.visible(), [], 'kb, other and the new tool are conservatively denied')

    activation.disposeAgent(h.agent)
    assert.deepEqual(h.visible(), ['mcp__kb__search', 'mcp__new__x', 'mcp__other__x'], 'lifecycle disposer releases the fallback')
  } finally {
    activation.disposeAll()
    await h.dispose()
  }
})

test('real activation: a raced restrict registration keeps successes and converges on retry', async () => {
  const names = ['mcp__kb__search', 'mcp__other__x', 'mcp__third__x']
  const h = await harness(names)
  let state = stateWith({ deny: ['kb', 'other', 'third'] })
  const activation = createActivation({
    ctx: { get: (name) => (name === 'tools' ? h.toolsView : h.root.get(name)) },
    getState: async () => state,
    logger: h.logger,
    libraryRoot: () => '/nonexistent-library',
  })
  try {
    await activation.applyToAgent(h.agent)
    assert.deepEqual(h.visible(), [], 'initial per-tool denies hide all three')

    // A fourth denied tool appears; a real unregister happens between
    // tools.schemas() and its restrict() call.
    state = stateWith({ deny: ['kb', 'other', 'third'], extra: ['fourth'] })
    const fourthDisposer = h.hostCtx.tools.register(definition('mcp__fourth__x'))
    const normalSchemas = h.toolsView.schemas
    let raced = false
    h.toolsView.schemas = () => {
      const schemas = normalSchemas()
      if (!raced) {
        raced = true
        fourthDisposer()
      }
      return schemas
    }
    const degraded = await activation.applyToAgent(h.agent, { force: true })
    assert.equal(degraded.ok, true)
    assert.equal(degraded.degraded, true)
    assert.deepEqual(h.visible(), [], 'old and successful layers still hide everything currently registered')

    // Re-register the raced tool and retry: the next activation converges.
    h.hostCtx.tools.register(definition('mcp__fourth__x'))
    h.toolsView.schemas = normalSchemas
    const recovered = await activation.applyToAgent(h.agent, { force: true })
    assert.equal(recovered.degraded, undefined)
    assert.deepEqual(h.visible(), [], 'all four denied after convergence')

    activation.disposeAgent(h.agent)
    assert.deepEqual(h.visible(), ['mcp__fourth__x', 'mcp__kb__search', 'mcp__other__x', 'mcp__third__x'])
  } finally {
    activation.disposeAll()
    await h.dispose()
  }
})
