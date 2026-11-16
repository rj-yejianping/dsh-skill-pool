/**
 * Resource pool for DeepSeek Harness (single global pool).
 *
 * One Host plugin owns:
 * - a durable document (`$DSH_HOME/resource-pool/state.json`) holding the pool
 *   members (skills / MCP servers with per-item mode+workspace scopes) and the
 *   skill-library sources;
 * - the per-Agent gate that applies the pool to a live session by restricting
 *   tools, replacing the native `skill` loader with a filtered one, and stating
 *   the active pool in the system prompt;
 * - the HTTP surface the settings page calls, plus a `resource_pool_status`
 *   tool so an Agent can explain why a resource is missing.
 *
 * The settings page is the browser half (`./client`); no sidebar entry.
 *
 * @module dsh-skill-pool
 */

import { createRequire } from 'node:module'

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { StateStore, statePath } from './src/store.js'
import { registerWebApi } from './src/web-api.js'
import { createActivation, modeOf, workspaceOf } from './src/activation.js'
import { createMountTracker } from './src/uploads.js'
import { remountPoolServers } from './src/remount.js'
import { resolvePool } from './src/rules.js'

/** Loader plugin name. */
export const name = 'skill-pool'

/** Required services; everything else is discovered through `ctx.get`. */
export const inject = ['tools']

/**
 * Package version reported to the panel.
 *
 * Read from package.json instead of a literal: a duplicated version string is
 * exactly how the panel ended up claiming 0.3.0 while 0.3.1 was installed. Node
 * resolves `./package.json` because it is in this package's `exports`.
 */
const VERSION = (() => {
  try {
    return createRequire(import.meta.url)('./package.json').version
  } catch {
    return 'unknown'
  }
})()

/** Schemastery schema surfaced by `Config.listConfigs` and the profile patch. */
export const Config = z.object({
  file: z.string().default('').description('Absolute state file path; empty uses $DSH_HOME/resource-pool/state.json.'),
  promptLanguage: z.string().default('zh').description("Language of the injected pool summary: 'zh' | 'en'."),
  enabled: z.boolean().default(true).description('Master switch; false keeps the panel but never gates a session.'),
})

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ file?: string, promptLanguage?: string, enabled?: boolean }} [config] - validated configuration.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? undefined
  const file = typeof config.file === 'string' && config.file.trim().length > 0 ? config.file.trim() : statePath()
  const store = new StateStore({ file, logger, version: VERSION })
  const promptLanguage = config.promptLanguage === 'en' ? 'en' : 'zh'
  const masterEnabled = config.enabled !== false

  /** Effective document: the profile's master switch wins over the stored one. */
  const getState = async () => {
    const state = await store.read({ fresh: true })
    if (masterEnabled) return state
    return { ...state, settings: { ...state.settings, enabled: false } }
  }

  const activation = createActivation({ ctx, getState, logger, promptLanguage: () => promptLanguage })

  const meta = { version: VERSION, file, pluginName: 'dsh-skill-pool', promptLanguage }

  // Apply to existing Agents too: a plugin reload must not leave live sessions
  // ungated until they are recreated.
  ctx.inject(['agents'], () => {
    void activation.reapplyAll()
  })

  ctx.on('agent/created', async ({ agent }) => {
    // Listeners are awaited before creation resolves and before the Agent may
    // assemble its first request; `applyToAgent` contains its own failures.
    await activation.applyToAgent(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    activation.disposeAgent(agent)
  })

  // A preset switch changes which modes are in effect without touching the pool
  // document, so the session header alone would keep the old mode forever.
  // `agent-preset/selected` is emitted with (sessionId, presetId) after the Agent
  // has been rebound, which is exactly when the gate has to be recomputed.
  ctx.on('agent-preset/selected', (sessionId) => {
    const registry = ctx.get('agents')
    const live = typeof registry?.list === 'function' ? registry.list() : []
    const agent = live.find((candidate) => candidate?.session?.id === sessionId || candidate?.id === sessionId)
    if (agent === undefined) return
    void activation.applyToAgent(agent, { force: true })
  })

  // Registrations live on each Agent's context; release them when the plugin
  // unloads instead of waiting for Agent disposal.
  ctx.effect(() => () => activation.disposeAll(), 'resource-pool.activation')

  const mounts = createMountTracker()

  registerWebApi({
    ctx,
    store,
    mounts,
    meta,
    logger,
    onChanged: async () => {
      await activation.reapplyAll()
    },
  })

  // Storage keeps each MCP member's connection definition precisely so this
  // activation can restore it: a Host restart drops every Loader row, and
  // without this the pool would come back listing servers with zero tools.
  // Waiting for `loader` means the rows are created as soon as the service that
  // owns them exists, and the remount itself stays in the background.
  let remounted = false
  ctx.inject(['loader'], () => {
    if (remounted) return
    remounted = true
    void remountPoolServers({ ctx, getState, mounts, logger }).catch((error) => {
      logger?.warn?.(`[skill-pool] remount failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  // Read-only self-report: answers "why is this skill/MCP tool missing?" for the
  // calling Agent and doubles as the plugin's own health probe.
  const statusTool = defineTool({
    name: 'resource_pool_status',
    description:
      'Report the resource pool state for the current session: resolved Agent mode/workspace, which skills and MCP servers the pool activates here, and the pool size. Use it when a skill or MCP tool you expected is missing.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      const state = await getState()
      const agent = exec?.agent
      const mode = agent === undefined ? '' : modeOf(ctx, agent)
      const cwd = agent === undefined ? '' : workspaceOf(agent)
      const pool = resolvePool(state, { mode, cwd })
      return {
        plugin: 'dsh-skill-pool',
        version: VERSION,
        stateFile: file,
        promptLanguage,
        masterEnabled,
        mode,
        cwd,
        ...pool,
        counts: { skills: Object.keys(state.skills).length, mcp: Object.keys(state.mcp).length, sources: Object.keys(state.sources).length },
        settings: state.settings,
      }
    },
  })

  ctx.effect(() => ctx.tools.register(statusTool), 'resource-pool.status-tool')
}
