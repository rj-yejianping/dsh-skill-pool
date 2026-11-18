/**
 * Real-DSH restriction lifecycle probe (host-bound).
 *
 * Mounts the installed Cordis/system-prompt/tools services, registers synthetic
 * tools, and exercises the real per-scope `tools.restrict()` layer. No state
 * file, profile or credentials are involved.
 *
 * Run: npm run test:restrict
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

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
    description: 'synthetic restriction probe tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: () => [{ type: 'text', text: name }],
    },
  }
}

async function harness() {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolsService)
  const key = {}
  let hostCtx
  let scoped
  const disposers = {}
  await root.plugin({
    name: 'restrict-lifecycle-probe',
    inject: ['tools'],
    apply(ctx) {
      hostCtx = ctx
      scoped = createScope(ctx, key)
      disposers.search = ctx.tools.register(definition('mcp__alpha__search'))
      disposers.echo = ctx.tools.register(definition('mcp__alpha__echo'))
    },
  })
  return {
    root,
    key,
    scoped,
    hostCtx,
    disposers,
    visible() {
      return root.tools.schemas(key).map((schema) => schema.name)
    },
    async dispose() {
      await root.fiber.dispose()
    },
  }
}

test('real DSH restrict layers intersect, unregister/re-register, and keep a documented dynamic gap', async () => {
  const h = await harness()
  try {
    assert.deepEqual(h.visible().sort(), ['mcp__alpha__echo', 'mcp__alpha__search'])

    const first = h.scoped.ctx.tools.restrict({ deny: ['mcp__alpha__echo'] })
    assert.deepEqual(h.visible(), ['mcp__alpha__search'])
    const second = h.scoped.ctx.tools.restrict({ deny: ['mcp__alpha__echo'] })
    first()
    assert.deepEqual(h.visible(), ['mcp__alpha__search'], 'intersection keeps the tool hidden')
    second()
    assert.deepEqual(h.visible().sort(), ['mcp__alpha__echo', 'mcp__alpha__search'])

    // Unregister and re-register the same public name under an active deny: the
    // layer still hides it, then disposing the layer reveals the new generation.
    const deny = h.scoped.ctx.tools.restrict({ deny: ['mcp__alpha__echo'] })
    h.disposers.echo()
    h.hostCtx.tools.register(definition('mcp__alpha__echo'))
    assert.deepEqual(h.visible(), ['mcp__alpha__search'], 'the deny covers the re-registered name')
    deny()
    assert.deepEqual(h.visible().sort(), ['mcp__alpha__echo', 'mcp__alpha__search'])

    // Residual gap: a brand-new public name is not in the static deny list and
    // is visible until the next activation re-computes a non-empty deny.
    const denyEcho = h.scoped.ctx.tools.restrict({ deny: ['mcp__alpha__echo'] })
    h.hostCtx.tools.register(definition('mcp__alpha__late'))
    assert.deepEqual(h.visible().sort(), ['mcp__alpha__late', 'mcp__alpha__search'])

    // Register the refreshed deny before releasing the old layer: the new layer
    // must cover both the old and the newly visible name first.
    const refreshed = h.scoped.ctx.tools.restrict({
      deny: ['mcp__alpha__echo', 'mcp__alpha__late'],
    })
    assert.deepEqual(h.visible(), ['mcp__alpha__search'])
    denyEcho()
    assert.deepEqual(h.visible(), ['mcp__alpha__search'], 'the refreshed layer survives releasing the old one')
    refreshed()
    assert.deepEqual(h.visible().sort(), ['mcp__alpha__echo', 'mcp__alpha__late', 'mcp__alpha__search'])
  } finally {
    await h.dispose()
  }
})
