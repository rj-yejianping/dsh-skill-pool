/**
 * Always-resident `<server>_discover` entries for progressive MCP services.
 *
 * A progressive service keeps its business tools out of the model request until
 * the Agent calls its one discover entry. This module owns that entry: it
 * derives the name, refuses conflicting or invalid names instead of renaming
 * silently, registers the tool globally behind a synchronous `when(context)`,
 * and implements the discover call itself.
 *
 * The controller is deliberately policy-free: it answers "may this Agent see
 * this service?" from the per-Agent record the activation layer maintains
 * (`recordOf`) and lifts the progressive deny layers with `expandService`, so a
 * discover call grants exactly the permission the pool already granted and
 * never more. Nothing here is persisted: expansion is per-Agent, in memory.
 *
 * A discover result is a catalog, never a connection: it carries public tool
 * names and description summaries only, so URLs, headers, env values and
 * resource payloads cannot leak through it.
 *
 * `defineTool` is injected because this package does not depend on
 * `@deepseek-ai/dsh-tools` (the host supplies it at install time); omitting it
 * falls back to an identity function so the module stays directly unit-testable.
 *
 * @module dsh-skill-pool/disclosure
 */

import { isAmbiguousMcpToolName, mcpServerOf, MCP_TOOL_PREFIX, toolActive } from './rules.js'
import { cleanDescription } from './store.js'

/** Maximum model-facing tool name length accepted by the platform. */
const NAME_LIMIT = 64

/** Suffix that turns a sanitized service name into its discover entry name. */
const DISCOVER_SUFFIX = '_discover'

/** Maximum description characters copied into one catalog summary. */
const SUMMARY_LIMIT = 200

/** Label prefix of the effect that owns one discover registration. */
const EFFECT_LABEL = 'resource-pool.discover:'

/** Fixed sentence returned by a successful discover call. */
const NEXT_STEP = 'Expansion takes effect on the next model step.'

/** Log prefix shared with the rest of the plugin. */
const LOG_PREFIX = '[resource-pool]'

/**
 * Derive the model-facing discover tool name of one MCP service.
 *
 * Normalization is fixed: lowercase, every run of characters outside
 * `[a-z0-9_]` becomes one `_`, repeated `_` collapse, leading/trailing `_` are
 * stripped, then `_discover` is appended. A name is never silently repaired
 * beyond that: an empty result, a leading digit or a name over the platform
 * limit returns no name and a reason, so the caller skips registration instead
 * of inventing a different tool.
 *
 * @param {unknown} server - pool service name.
 * @returns {{name: string, error: ''|'empty'|'invalid'}} derived name, or `''` name plus the reason.
 */
export function deriveDiscoverName(server) {
  const source = typeof server === 'string' ? server : ''
  const base = source
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (base.length === 0) return { name: '', error: 'empty' }
  const name = base + DISCOVER_SUFFIX
  // A digit cannot start a tool name, and an over-long name cannot be registered.
  if (/^[0-9]/.test(name)) return { name: '', error: 'invalid' }
  if (name.length > NAME_LIMIT) return { name: '', error: 'empty' }
  return { name, error: '' }
}

/**
 * Build the discover tool description for one service.
 *
 * The user description is display text (already cleaned by the store); without
 * one a neutral generic sentence is used instead of guessing the service's
 * purpose. The fixed tail states exactly what the call does and that it grants
 * no permission.
 *
 * @param {string} server - pool service name.
 * @param {unknown} member - MCP pool member.
 * @returns {string} model-facing tool description.
 */
function describeService(server, member) {
  const user = cleanDescription(member?.description)
  const prefix = user.length > 0 ? user : `Discover the tools of MCP server "${server}".`
  return (
    `${prefix}\n\n`
    + `Call this tool to reveal the MCP tools of server "${server}" for this session. `
    + 'Expansion takes effect on the next model step and grants no extra permission.'
  )
}

/**
 * Condense one tool description into a catalog summary.
 * @param {unknown} description - registered tool description.
 * @returns {string} single-line summary of at most {@link SUMMARY_LIMIT} characters.
 */
function summaryOf(description) {
  if (typeof description !== 'string') return ''
  return description.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LIMIT)
}

/**
 * Render a value as one JSON text block (the plugin's tool output shape).
 * @param {unknown} _args - validated arguments (unused).
 * @param {unknown} value - tool result.
 * @returns {{type: 'text', text: string}[]} model-facing content.
 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Create the progressive-disclosure controller.
 *
 * @param {object} options - controller options.
 * @param {object} options.ctx - plugin context; only `get` and `effect` are optional.
 * @param {{ warn?: Function, debug?: Function }} [options.logger] - logger.
 * @param {() => Promise<object>} [options.getState] - read the current document.
 * @param {(agent: any) => object|undefined} [options.recordOf] - per-Agent activation record.
 * @param {(agent: any, server: string) => {ok: true}|{ok: false, error: string}} [options.expandService] - lift one service's progressive layers.
 * @param {(agent: any) => string} [options.modeOf] - read one Agent's mode.
 * @param {(agent: any) => string} [options.workspaceOf] - read one Agent's workspace.
 * @param {() => boolean} [options.enabled] - whether progressive disclosure is available at all.
 * @param {(def: object) => object} [options.defineTool] - host `defineTool`, identity when absent.
 * @returns {{sync: (state: object) => void, dispose: () => void}} controller.
 */
export function createMcpDisclosure({
  ctx,
  logger,
  getState,
  recordOf,
  expandService,
  modeOf,
  workspaceOf,
  enabled,
  defineTool,
} = {}) {
  const make = typeof defineTool === 'function' ? defineTool : (def) => def
  /** @type {Map<string, {name: string, description: string, dispose: Function}>} */
  const entries = new Map()
  /** Whether a sync pass is running (guards synchronous `tools/change` re-entry). */
  let syncing = false

  /** Log a warning without ever letting logging break a sync. */
  const warn = (message) => {
    try {
      logger?.warn?.(`${LOG_PREFIX} ${message}`)
    } catch {
      /* a logger failure must not change disclosure behaviour */
    }
  }

  /** Describe one error without leaking anything but the message. */
  const messageOf = (error) => (error instanceof Error ? error.message : String(error))

  /**
   * Whether progressive disclosure may be offered at all.
   *
   * False means "register nothing": without the global guard the activation
   * layer reports no progressive services, so a discover entry could only be
   * dead weight. A throwing predicate is treated as unavailable.
   */
  const progressiveEnabled = () => {
    if (typeof enabled !== 'function') return true
    try {
      return enabled() !== false
    } catch {
      return false
    }
  }

  /** Resolve the global tools service through the context (directly or via `get`). */
  const toolsOf = () => {
    if (ctx?.tools !== undefined && ctx?.tools !== null) return ctx.tools
    if (typeof ctx?.get === 'function') {
      try {
        return ctx.get('tools')
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /** Run a registration callback through `ctx.effect` (falling back to a bare call). */
  const effectOf = (register, label) => {
    if (typeof ctx?.effect === 'function') return ctx.effect(register, label)
    return register()
  }

  /** Read the global tool schemas, or report that they are unavailable. */
  const readSchemas = () => {
    const tools = toolsOf()
    if (tools === undefined || typeof tools.schemas !== 'function') {
      return { ok: false, error: 'the global tools service is unavailable' }
    }
    try {
      const schemas = tools.schemas()
      if (!Array.isArray(schemas)) return { ok: false, error: 'the global tool list is not an array' }
      return { ok: true, schemas }
    } catch (error) {
      return { ok: false, error: `the global tool list could not be read: ${messageOf(error)}` }
    }
  }

  /**
   * Services that should own a discover entry in this document.
   *
   * Progressive only exists on top of the MCP gate, so a gate-off or
   * master-off document yields no targets. Member scope is not consulted here:
   * the entry is global and its `when` asks the per-Agent record, so one
   * registration serves every Agent the pool admits.
   */
  const targetsOf = (state) => {
    const targets = new Map()
    if (state === null || typeof state !== 'object') return targets
    const settings = state.settings ?? {}
    if (settings.enabled === false) return targets
    if (settings.mcpGate === false) return targets
    const mcp = state.mcp
    if (mcp === null || typeof mcp !== 'object') return targets
    for (const [server, member] of Object.entries(mcp)) {
      if (member === null || typeof member !== 'object') continue
      if (member.enabled === false) continue
      if (member.disclosure !== 'progressive') continue
      targets.set(server, member)
    }
    return targets
  }

  /** Release one server's registration. */
  const release = (server) => {
    const entry = entries.get(server)
    if (entry === undefined) return
    entries.delete(server)
    try {
      entry.dispose?.()
    } catch (error) {
      warn(`discover entry for "${server}" could not be released: ${messageOf(error)}`)
    }
  }

  /**
   * The synchronous visibility predicate of one discover entry.
   *
   * It answers from the per-Agent record only: a missing or not-yet-activated
   * record, a record built by the conservative fallback (the document was
   * unreadable, so the record cannot prove what the pool holds), a gate-off
   * record and a service the pool no longer treats as progressive all yield
   * `false`. It is synchronous and side-effect free, as the tool registry
   * requires.
   */
  const whenOf = (server) => (context) => {
    try {
      const agent = context?.agent
      if (agent === undefined || agent === null) return false
      const record = typeof recordOf === 'function' ? recordOf(agent) : undefined
      if (record === undefined || record === null || record.activated !== true) return false
      // A conservative record is a deny-all snapshot taken while the state was
      // unreadable. It cannot say which services are progressive, so the entry
      // stays invisible instead of guessing (spec §2/§7).
      if (record.conservative === true) return false
      if (record.gateMcp !== true) return false
      return record.progressiveServers instanceof Set && record.progressiveServers.has(server)
    } catch {
      return false
    }
  }

  /**
   * Whether the MCP manager reports this service as connected.
   *
   * Only an authoritative "connected" is treated as usable. A manager that is
   * absent or has no entry for the service degrades to the registry, exactly as
   * documented: the catalog is then the visible tool list.
   *
   * @returns {boolean} true only when a manager entry exists and is not connected.
   */
  const isOffline = (server) => {
    if (typeof ctx?.get !== 'function') return false
    let manager
    try {
      manager = ctx.get('mcpManager')
    } catch {
      return false
    }
    if (manager === null || typeof manager !== 'object' || typeof manager.list !== 'function') return false
    let views
    try {
      views = manager.list()
    } catch {
      return false
    }
    if (!Array.isArray(views)) return false
    const view = views.find((candidate) => candidate?.name === server)
    if (view === undefined) return false
    return view.status?.state !== 'connected'
  }

  /** Read one Agent's mode for per-tool scope evaluation; '' when unavailable. */
  const modeFor = (agent) => {
    if (typeof modeOf !== 'function') return ''
    try {
      return modeOf(agent)
    } catch {
      return ''
    }
  }

  /** Read one Agent's workspace for per-tool scope evaluation. */
  const workspaceFor = (agent) => {
    if (typeof workspaceOf !== 'function') return ''
    try {
      return workspaceOf(agent)
    } catch {
      return ''
    }
  }

  /** The exact refusal shared by every "this Agent may not discover it" case. */
  const notInPool = () => ({ ok: false, error: 'not-in-pool' })

  /**
   * Execute one discover call.
   *
   * The order is deliberate: the per-Agent record and the live document decide
   * whether this Agent may see the service at all, the manager decides whether
   * the connection is usable, and only then is any catalog read. Every failure
   * returns a distinct error code and never expands the service, so an empty or
   * stale catalog is never reported as success.
   *
   * Returned codes are exactly this closed set; upstream strings are never
   * passed through to the model:
   * - `state-unavailable` — no activation record, an unfinished activation, a
   *   conservative (deny-all) record, an unreadable document, or a malformed
   *   per-tool snapshot;
   * - `not-in-pool` — the gate is off, the service left this Agent's pool, the
   *   document now says disabled/full, or the record is malformed;
   * - `offline` — the `mcpManager` knows the service and it is not connected
   *   (also returns `service`);
   * - `tools-unavailable` — the registry cannot be read (also the catch-all for
   *   an unexpected failure);
   * - `no-tools` — the catalog exists but offers this Agent nothing it may see
   *   (also returns `service` and `hidden` counts);
   * - `expand-failed` — the expansion itself was refused by the activation layer.
   *
   * @param {{server: string, description: string, member: object}} entry - registration facts.
   * @param {unknown} _args - validated arguments (unused).
   * @param {{agent?: any}} [exec] - execution context.
   * @returns {Promise<object>} discover result.
   */
  const runDiscover = async ({ server, description, member }, _args, exec) => {
    try {
      const agent = exec?.agent
      const record = agent === undefined || typeof recordOf !== 'function' ? undefined : recordOf(agent)
      if (record === undefined || record === null || record.activated !== true) {
        return { ok: false, error: 'state-unavailable' }
      }
      // A conservative record denies every tool at dispatch because the state
      // was unreadable when it was built. It cannot bound a catalog, so the
      // answer stays `state-unavailable` even if the file is readable again.
      if (record.conservative === true) return { ok: false, error: 'state-unavailable' }
      if (record.gateMcp !== true) return notInPool()
      if (!(record.progressiveServers instanceof Set) || !record.progressiveServers.has(server)) {
        return notInPool()
      }
      if (!(record.allowedServers instanceof Set) || !record.allowedServers.has(server)) {
        return notInPool()
      }
      // A malformed per-tool snapshot cannot bound the catalog, so it is
      // unreadable state rather than an empty (allowing) denial set.
      if (!(record.toolDenied instanceof Set)) return { ok: false, error: 'state-unavailable' }

      // The record can lag behind a switch to full injection (its re-apply has
      // not necessarily run yet), so the live document is re-read before any
      // tool name is disclosed.
      let live = member
      if (typeof getState === 'function') {
        try {
          live = await getState()
        } catch {
          return { ok: false, error: 'state-unavailable' }
        }
        if (live === null || typeof live !== 'object') return { ok: false, error: 'state-unavailable' }
        const settings = live.settings ?? {}
        if (settings.enabled === false || settings.mcpGate === false) return notInPool()
        const current = live.mcp?.[server]
        if (current === null || typeof current !== 'object') return notInPool()
        if (current.enabled === false) return notInPool()
        if (current.disclosure !== 'progressive') return notInPool()
      }

      // Offline first: a catalog left behind by a dead connection is not usable.
      if (isOffline(server)) return { ok: false, error: 'offline', service: server }

      const listed = readSchemas()
      if (listed.ok !== true) return { ok: false, error: 'tools-unavailable' }

      /** @type {{name: string, description: string}[]} */
      const attributable = []
      let ambiguous = 0
      for (const schema of listed.schemas) {
        const name = schema?.name
        if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) continue
        if (mcpServerOf(name) !== server) continue
        if (isAmbiguousMcpToolName(name)) {
          ambiguous += 1
          continue
        }
        attributable.push({ name, description: typeof schema.description === 'string' ? schema.description : '' })
      }

      const total = attributable.length + ambiguous
      const configs = live?.mcp?.[server]?.tools ?? member?.tools
      const toolConfigs = configs !== null && typeof configs === 'object' ? configs : {}
      const target = { mode: modeFor(agent), cwd: workspaceFor(agent) }
      /** @type {{name: string, description: string}[]} */
      const allowed = []
      let disabled = 0
      let outOfScope = 0
      for (const tool of attributable) {
        const config = toolConfigs[tool.name]
        const active = config === undefined || config === null || toolActive(config, target)
        if (active && !record.toolDenied.has(tool.name)) {
          allowed.push(tool)
        } else if (active) {
          // The record refuses a tool its config does not: keep the refusal and
          // report it as a scope omission instead of inventing a new category.
          outOfScope += 1
        } else if (config?.enabled === false) {
          disabled += 1
        } else {
          outOfScope += 1
        }
      }
      const hidden = { total, disabled, outOfScope, ambiguous }
      if (allowed.length === 0) return { ok: false, error: 'no-tools', service: server, hidden }

      if (typeof expandService !== 'function') return { ok: false, error: 'expand-failed' }
      let result
      try {
        result = expandService(agent, server)
      } catch {
        return { ok: false, error: 'expand-failed' }
      }
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        // Only our own closed set reaches the model. `not-activated` means the
        // record the check above used is already stale, which is unreadable
        // state; every other upstream code is an expansion failure.
        const error = result?.error === 'not-activated' ? 'state-unavailable' : 'expand-failed'
        return { ok: false, error }
      }
      return {
        ok: true,
        service: server,
        description,
        expanded: true,
        tools: allowed.map((tool) => ({ name: tool.name, summary: summaryOf(tool.description) })),
        hidden,
        nextStep: NEXT_STEP,
      }
    } catch {
      // Any unexpected failure is a failure to read the catalog, never a
      // successful expansion of an unknown service.
      return { ok: false, error: 'tools-unavailable' }
    }
  }

  /**
   * Reconcile registrations with one document (synchronous, never throws).
   *
   * Newly targeted services get an entry, services that left (removed,
   * disabled, gate off, switched to full, or progressive unavailable) lose
   * theirs, and a description edit re-registers so the model sees the new text.
   * Removal never needs the live tool list; when that list cannot be read only
   * additions are skipped (a name conflict could not be ruled out). A name that
   * cannot be derived or is already taken is reported and skipped; it is never
   * silently renamed.
   *
   * A synchronous `tools/change` re-entry returns immediately: the outer pass
   * has just registered a name but not recorded it yet, so a nested pass would
   * misread our own tool as a conflict.
   *
   * @param {object} state - current document.
   */
  const sync = (state) => {
    if (syncing) return
    syncing = true
    try {
      const targets = progressiveEnabled() ? targetsOf(state) : new Map()
      const tools = toolsOf()
      if (tools === undefined || typeof tools.register !== 'function') {
        for (const server of [...entries.keys()]) release(server)
        if (targets.size > 0) warn('discover entries are unavailable: the global tools service is not exposed')
        return
      }

      // Removal is authoritative from our own registry: it must not depend on a
      // readable tool list.
      for (const server of [...entries.keys()]) {
        if (!targets.has(server)) release(server)
      }

      const listed = readSchemas()
      if (listed.ok !== true) {
        // Additions need the live name list because a conflict cannot be ruled
        // out without it. Entries for still-targeted services are kept; their
        // `when` and `execute` read the live record and document, so they stay
        // invisible and unreachable while the service is not progressive.
        warn(`discover additions skipped: ${listed.error}`)
        return
      }

      // Our own registrations are not conflicts, so a repeated sync is
      // idempotent even though their names are in the live list.
      const own = new Set([...entries.values()].map((entry) => entry.name))
      const taken = new Set()
      for (const schema of listed.schemas) {
        const name = schema?.name
        if (typeof name === 'string' && !own.has(name)) taken.add(name)
      }

      /** @type {Map<string, {name: string, description: string, member: object}>} */
      const desired = new Map()
      for (const server of [...targets.keys()].sort()) {
        const derived = deriveDiscoverName(server)
        if (derived.error !== '') {
          warn(`discover entry for "${server}" is unavailable: ${derived.error} name`)
          continue
        }
        if (taken.has(derived.name)) {
          warn(`discover entry for "${server}" is unavailable: the name "${derived.name}" is already taken`)
          continue
        }
        taken.add(derived.name)
        desired.set(server, {
          name: derived.name,
          description: describeService(server, targets.get(server)),
          member: targets.get(server),
        })
      }

      // Remove before adding: a renamed service may otherwise collide with the
      // registration it is replacing.
      for (const [server, entry] of [...entries]) {
        const next = desired.get(server)
        if (next === undefined || next.name !== entry.name) release(server)
      }

      for (const [server, next] of desired) {
        const current = entries.get(server)
        if (current !== undefined && current.description === next.description) continue
        if (current !== undefined) release(server)
        // One bad definition (an invalid schema, a registration race) must not
        // block the other services' entries.
        try {
          const definition = make({
            name: next.name,
            description: next.description,
            parameters: {},
            output: {
              schema: { type: 'object', additionalProperties: true, properties: {} },
              render: renderJson,
            },
            execute: (args, exec) => runDiscover(
              { server, description: next.description, member: next.member },
              args,
              exec,
            ),
          })
          const dispose = effectOf(
            () => tools.register(definition, { when: whenOf(server) }),
            EFFECT_LABEL + server,
          )
          entries.set(server, {
            name: next.name,
            description: next.description,
            dispose: typeof dispose === 'function' ? dispose : () => {},
          })
        } catch (error) {
          warn(`discover entry for "${server}" could not be registered: ${messageOf(error)}`)
        }
      }
    } catch (error) {
      // Registration problems are reported per service where possible; anything
      // that escapes here must still not break the caller's re-apply.
      warn(`discover sync failed: ${messageOf(error)}`)
    } finally {
      syncing = false
    }
  }

  /** Release every registration (plugin unload). */
  const dispose = () => {
    for (const server of [...entries.keys()]) release(server)
  }

  return { sync, dispose }
}
