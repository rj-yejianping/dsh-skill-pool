/**
 * Per-Agent application of the single global resource pool.
 *
 * The pool is the user's library, so "what the pool activates" is exactly
 * "what this Agent may see". Two effects express that, one per namespace:
 *
 * 1. Skills — a library provider is registered on the **Agent's own context**.
 *    `SkillRegistry.registerProvider` files a provider into the layer of the
 *    calling context's scope, and an Agent's scope key is the Agent object, so
 *    that layer is visible to this Agent alone. A skill the pool did not admit
 *    is therefore absent from this Agent's catalog AND unloadable: strict hiding
 *    falls out of the registry instead of tool replacement.
 * 2. MCP — `agent.ctx.tools.restrict({ deny })` removes exactly the public tool
 *    names of servers the pool did not activate. There is no layered equivalent
 *    for tools, so this remains a restriction.
 *
 * A system-prompt section then states the mode, workspace and what is active, so
 * the model neither guesses nor tries to recall a resource it cannot reach.
 *
 * Everything is computed before the live activation is released, so a
 * configuration change never leaves a window where the old restrictions are
 * lifted but the new ones are not installed yet. Registrations are owned by
 * `agent.ctx` and released on disposal.
 *
 * @module dsh-skill-pool/activation
 */

import { librarySkillsRoot } from './library.js'
import { createLibraryProvider } from './provider.js'
import { isAmbiguousMcpToolName, mcpServerOf, MCP_TOOL_PREFIX, resolvePool } from './rules.js'

/** Labels of effects that restrict the MCP tool surface (normal or fallback). */
const RESTRICT_LABELS = new Set(['mcp-restrict', 'mcp-restrict-fallback'])

/**
 * Read the Agent mode of one live Agent.
 * @param {object} ctx - plugin context.
 * @param {any} agent - live Agent.
 * @returns {string} preset id, never empty.
 */
export function modeOf(ctx, agent) {
  // Order matters. `session.header.agentPreset` is a snapshot taken when the
  // session was created and is never rewritten, so a session that switched preset
  // before its first turn keeps reporting the original one forever. The live
  // sources must win, or the pool resolves against a mode the Agent is not in.
  const registry = ctx.get('agentPresets')
  if (registry !== undefined && typeof registry.composedPreset === 'function' && agent?.ctx !== undefined) {
    try {
      const composed = registry.composedPreset(agent.ctx)
      if (typeof composed === 'string' && composed.length > 0) return composed
    } catch {
      /* fall through to the logged selection */
    }
  }
  // The preset projection is the latest `agent-preset/selected` in the session log.
  const projections = ctx.get('sessionProjections')
  if (projections !== undefined && typeof projections.stateOf === 'function' && agent?.session !== undefined) {
    try {
      const selected = projections.stateOf(agent.session, 'agentPreset')
      if (typeof selected === 'string' && selected.length > 0) return selected
    } catch {
      /* fall through to the creation-time header */
    }
  }
  const header = agent?.session?.header?.agentPreset
  if (typeof header === 'string' && header.trim().length > 0) return header.trim()
  return 'default'
}

/**
 * Whether the preset a live Agent actually runs differs from its session header.
 *
 * A switch before the first turn only appends `agent-preset/selected`; the header
 * stays as the creation snapshot. Callers use this to notice that re-applying the
 * pool is warranted even though no document changed.
 *
 * @param {object} ctx - plugin context.
 * @param {any} agent - live Agent.
 * @returns {boolean} whether the header is stale for this Agent.
 */
export function presetHeaderStale(ctx, agent) {
  const header = agent?.session?.header?.agentPreset
  if (typeof header !== 'string' || header.trim().length === 0) return false
  return modeOf(ctx, agent) !== header.trim()
}

/**
 * Read the working directory of one live Agent.
 * @param {any} agent - live Agent.
 * @returns {string} absolute directory or the process cwd.
 */
export function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  return process.cwd()
}

/**
 * Create the activation manager.
 * @param {object} options - manager options.
 * @param {object} options.ctx - plugin context.
 * @param {(fresh?: boolean) => Promise<object>} options.getState - read the current document.
 * @param {{ debug?: Function, warn?: Function }} [options.logger] - logger.
 * @param {() => string} [options.libraryRoot] - library skills root override.
 * @returns {object} manager with applyToAgent/reapplyAll/disposeAgent/disposeAll.
 */
export function createActivation({ ctx, getState, logger, libraryRoot = () => librarySkillsRoot() }) {
  /** @type {WeakMap<object, {disposers: {dispose: Function, label: string}[], signature: string, activated: boolean, chain: Promise<void>}>} */
  const agents = new WeakMap()

  /** Dispose one recorded registration, tolerating an already-disposed effect. */
  const disposeEntry = (entry) => {
    try {
      entry.dispose()
    } catch {
      /* already disposed */
    }
  }

  /** Release every registration owned for one Agent. */
  const release = (agent) => {
    const record = agents.get(agent)
    if (record === undefined) return
    for (const entry of record.disposers.reverse()) disposeEntry(entry)
    record.disposers = []
    record.signature = ''
    record.activated = false
    record.conservative = false
    record.degraded = false
    record.underRestricted = false
    record.mcpGateActive = false
  }

  /** Signature of a decision, used to skip no-op re-applications. */
  const signatureOf = (pool, allowed, libraryNames) =>
    JSON.stringify({
      gated: pool.gated,
      skills: allowed,
      mcp: pool.mcpServers,
      gs: pool.gateSkills,
      gm: pool.gateMcp,
      lib: libraryNames,
    })

  /**
   * Serialize applications per Agent.
   *
   * A failure for an Agent that already has a live activation is contained: the
   * previous registrations stay installed and are never released before the new
   * ones are known to be safe. A failure for an Agent with no activation is
   * propagated to the caller, so `agent/created` rejects and no ungated Agent is
   * published.
   */
  const applyToAgent = async (agent, { force = false, conservative = false } = {}) => {
    if (agent?.ctx === undefined) return
    let record = agents.get(agent)
    if (record === undefined) {
      record = {
        disposers: [],
        signature: '',
        activated: false,
        conservative: false,
        degraded: false,
        underRestricted: false,
        mcpGateActive: false,
        chain: Promise.resolve(),
      }
      agents.set(agent, record)
    }
    const run = record.chain.then(() => applyNow(agent, record, { force }))
    // Keep the per-Agent chain fulfilled even when this application failed, so a
    // later retry (after the file is repaired) is not wedged behind it.
    record.chain = run.then(
      () => undefined,
      () => undefined,
    )
    try {
      await run
      if (record.underRestricted) {
        return {
          ok: false,
          code: 'resource-pool/activation-incomplete',
          message: 'MCP deny is incomplete; a tool whose restrict layer failed may be callable until the next replay',
          underRestricted: true,
          overRestricted: record.degraded === true,
          conservative: false,
          noVisibleTools: false,
        }
      }
      return record.degraded
        ? {
            ok: true,
            degraded: true,
            code: 'resource-pool/activation-over-restricted',
            message: 'some previously denied tools are not currently visible; old deny layers were retained and may over-restrict',
            underRestricted: false,
            overRestricted: true,
            conservative: false,
            noVisibleTools: false,
          }
        : { ok: true, underRestricted: false, overRestricted: false, conservative: false, noVisibleTools: false }
    } catch (error) {
      const hadActivation = record.activated
      logger?.warn?.(`[resource-pool] activation failed: ${error instanceof Error ? error.message : String(error)}`)
      if (hadActivation) {
        // A conservative fallback is refreshable: every explicit re-apply must
        // see newly registered MCP tools even while the document is unreadable.
        if (record.conservative && conservative) {
          try {
            return conservativeResult(agent)
          } catch (gateError) {
            logger?.warn?.(`[resource-pool] conservative MCP gate refresh failed: ${gateError instanceof Error ? gateError.message : String(gateError)}`)
            const retained = record.disposers.some((entry) => RESTRICT_LABELS.has(entry.label))
            return {
              ok: false,
              code: 'resource-pool/activation-degraded',
              message: 'state unavailable; conservative MCP deny refresh failed and previous layers were retained',
              fallbackFailed: true,
              retainedOldGate: retained,
              underRestricted: false,
              overRestricted: false,
              conservative: false,
              noVisibleTools: false,
            }
          }
        }
        // A healthy old layer is deliberately still installed. Reporting success
        // would hide a degraded state; rejecting would make the Agent unusable
        // even though its previous, authorized gate still protects it.
        const hasRestrictLayer = record.disposers.some((entry) => RESTRICT_LABELS.has(entry.label))
        if (conservative && record.mcpGateActive !== false && !hasRestrictLayer) {
          // The previous successful activation intentionally allowed every
          // visible tool (so it had zero restrict layers). Treating that as a
          // "retained gate" would leave a later failure ungated. Install a
          // conservative deny for all currently known MCP tools instead.
          try {
            return conservativeResult(agent)
          } catch (gateError) {
            logger?.warn?.(
              `[resource-pool] conservative MCP gate failed without a prior layer: ${gateError instanceof Error ? gateError.message : String(gateError)}`,
            )
            return {
              ok: false,
              code: 'resource-pool/activation-degraded',
              message: 'state unavailable and no prior MCP restriction could be installed',
              fallbackFailed: true,
              retainedOldGate: false,
            }
          }
        }
        if (hasRestrictLayer) {
          return {
            ok: false,
            code: 'resource-pool/activation-degraded',
            message: 'activation failed; previous MCP restriction layer retained',
            retainedOldGate: true,
            underRestricted: false,
            overRestricted: false,
            conservative: false,
            noVisibleTools: false,
          }
        }
        return {
          ok: false,
          code: 'resource-pool/activation-degraded',
          message: 'activation failed; no prior MCP restriction layer to retain',
          retainedOldGate: false,
          underRestricted: false,
          overRestricted: false,
          conservative: false,
          noVisibleTools: false,
        }
      }
      if (conservative) {
        // A live Agent with no layer of ours (for example one that existed before
        // a plugin reload) cannot be left ungated while the document is
        // unreadable. Deny every currently visible MCP tool and keep the Agent
        // alive; dynamic additions remain a documented gap.
        try {
          return conservativeResult(agent)
        } catch (gateError) {
          logger?.warn?.(
            `[resource-pool] conservative MCP gate failed: ${gateError instanceof Error ? gateError.message : String(gateError)}`,
          )
          return {
            ok: false,
            code: 'resource-pool/activation-degraded',
            message: 'state unavailable; conservative MCP deny could not be installed',
            fallbackFailed: true,
            retainedOldGate: false,
            underRestricted: false,
            overRestricted: false,
            conservative: false,
            noVisibleTools: false,
          }
        }
      }
      // This is also the only safe response for an Agent with no previous gate:
      // no caller may be told "activated" while nothing protects the Agent.
      throw error
    }
  }

  /**
   * Apply a deny-all-visible-MCP layer to one live Agent when the state cannot
   * be read and there is no previous layer to keep. This is deliberately a
   * static list: newly registered MCP tools can still appear, as documented.
   */
  const applyConservativeGate = (agent) => {
    const tools = ctx.get('tools')
    if (tools === undefined || typeof tools.schemas !== 'function') {
      throw new Error('global tools service is unavailable')
    }
    const schemas = tools.schemas()
    if (!Array.isArray(schemas)) throw new Error('global tool list is not an array')
    const visible = schemas
      .map((schema) => schema?.name)
      .filter((name) => typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX))
    const visibleSet = new Set(visible)
    const record = agents.get(agent)
    if (record === undefined) throw new Error('agent activation record is missing')

    if (visible.length === 0) {
      // Keep every previous per-tool layer: an absent tool may simply be
      // between generations, and we cannot register its name again now. There
      // is nothing we can truthfully claim as a newly installed deny. Any old
      // denied name is currently invisible, so retaining it is over-restriction
      // risk (we cannot know whether it is still meant to be denied).
      const retainedNames = record.disposers
        .filter((entry) => RESTRICT_LABELS.has(entry.label))
        .flatMap((entry) => (Array.isArray(entry.deny) ? entry.deny : []))
      const over = retainedNames.length > 0
      record.signature = ''
      record.activated = true
      record.conservative = true
      record.degraded = over
      record.underRestricted = false
      logger?.warn?.('[resource-pool] state unavailable; no visible MCP tools, kept previous conservative deny')
      return { visible: 0, failed: 0, under: false, over, kept: record.disposers.length > 0 }
    }

    const previous = record.disposers
    const oldRestrictions = []
    for (const entry of previous) {
      if (RESTRICT_LABELS.has(entry.label)) oldRestrictions.push(entry)
      else disposeEntry(entry)
    }
    const pending = []
    const failedNames = []
    const newEntries = []
    try {
      for (const name of visible) {
        try {
          const dispose = agent.ctx.effect(
            () => agent.ctx.tools.restrict({ deny: [name] }),
            'resource-pool.mcp-restrict-fallback',
          )
          const entry = {
            dispose: typeof dispose === 'function' ? dispose : () => {},
            label: 'mcp-restrict-fallback',
            deny: [name],
          }
          pending.push(entry)
          newEntries.push(entry)
        } catch (error) {
          failedNames.push(name)
          logger?.warn?.(
            `[resource-pool] one conservative MCP deny could not be registered (retaining old layers): ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      const oldCoverage = new Set(oldRestrictions.flatMap((entry) => (Array.isArray(entry.deny) ? entry.deny : [])))
      let retained = []
      let retainedInvisible = false
      if (failedNames.length > 0) {
        retained = oldRestrictions
        retainedInvisible = oldRestrictions.length > 0
      } else {
        for (const entry of oldRestrictions) {
          const names = Array.isArray(entry.deny) ? entry.deny : []
          if (names.some((name) => !visibleSet.has(name))) {
            retained.push(entry)
            retainedInvisible = true
          } else {
            disposeEntry(entry)
          }
        }
      }
      record.disposers = [...pending, ...retained]

      const retainedCoverage = new Set(
        retained.flatMap((entry) => (Array.isArray(entry.deny) ? entry.deny : [])),
      )
      for (const entry of newEntries) {
        const name = entry.deny?.[0]
        if (!retainedCoverage.has(name)) continue
        disposeEntry(entry)
        const index = pending.indexOf(entry)
        if (index >= 0) pending.splice(index, 1)
        record.disposers = record.disposers.filter((candidate) => candidate !== entry)
      }

      const over = retained.some((entry) =>
        (Array.isArray(entry.deny) ? entry.deny : []).some((name) => !visibleSet.has(name)),
      )
      record.signature = ''
      record.activated = true
      record.conservative = true
      record.degraded = over
      const under = failedNames.some((name) => !oldCoverage.has(name))
      record.underRestricted = under
      logger?.warn?.(
        failedNames.length > 0
          ? `[resource-pool] state unavailable; conservative MCP deny is incomplete (${failedNames.length} failed)`
          : `[resource-pool] state unavailable; conservative MCP deny covers ${visible.length} visible tool${visible.length === 1 ? '' : 's'}`,
      )
      return { visible: visible.length, failed: failedNames.length, under, over, kept: retainedInvisible }
    } catch (error) {
      for (const entry of pending.reverse()) disposeEntry(entry)
      throw error
    }
  }

  /**
   * Convert one conservative-gate outcome into the exact external result.
   * A partial failure is under-restriction; empty visibility never claims a
   * deny was installed; success is the conservative mode result.
   */
  const conservativeResult = (agent) => {
    const info = applyConservativeGate(agent)
    const common = {
      underRestricted: info.under === true,
      overRestricted: info.over === true,
      conservative: info.visible > 0,
      noVisibleTools: info.visible === 0,
    }
    if (info.under) {
      return {
        ok: false,
        code: 'resource-pool/activation-incomplete',
        message: 'state unavailable; conservative MCP deny is incomplete and a failed tool may be callable',
        ...common,
      }
    }
    if (info.visible === 0) {
      return {
        ok: false,
        code: 'resource-pool/activation-degraded',
        message: info.kept
          ? 'state unavailable; no MCP tools visible, previous layers kept, no new deny installed'
          : 'state unavailable; no MCP tools visible, no deny could be installed',
        ...common,
      }
    }
    return {
      ok: false,
      code: 'resource-pool/activation-conservative',
      message: 'state unavailable; conservative MCP deny applied to visible tools',
      ...common,
    }
  }

  /** Build one Agent's registrations. Runs serialized per Agent. */
  const applyNow = async (agent, record, { force }) => {
    // This read is fail-closed: a corrupt/unreadable/unsupported document throws
    // instead of resolving to an empty pool. It happens before any live
    // registration is touched, so an already-gated Agent keeps its old layers.
    const state = await getState()
    const settings = state.settings ?? {}
    const mode = modeOf(ctx, agent)
    const cwd = workspaceOf(agent)
    const pool = resolvePool(state, { mode, cwd })
    // Only servers this Agent may use enter the summary.
    const servers = pool.gateMcp ? [...pool.mcpServers] : []

    // The pool owns every library skill, so an Agent sees a skill only when the
    // pool admits it here. A disabled master switch means "do not gate at all",
    // which for a per-Agent provider means "admit the whole library".
    const libraryNames = Object.keys(state.skills ?? {}).sort()
    const allowed = settings.enabled === false ? libraryNames : pool.skills
    const signature = `${signatureOf(pool, allowed, libraryNames)}|${mode}|${cwd}`
    if (!force && record.signature === signature) return

    const tools = ctx.get('tools')
    const skills = agent.ctx.get('skills')

    // ---- Compute the whole next activation before touching the live one.
    const allowedSkills = new Set(allowed)
    let denyMcp = []
    let observedMcp = 0
    const visibleMcpNames = []
    if (pool.gateMcp) {
      // A missing/unreadable global tool surface is not "nothing to hide": it
      // means the MCP gate cannot be established. Treat it as an activation
      // failure instead of publishing an Agent without its deny layer.
      if (tools === undefined || typeof tools.schemas !== 'function') {
        throw new Error('MCP gate is required but the global tools service is unavailable')
      }
      let schemas
      try {
        schemas = tools.schemas()
      } catch (error) {
        throw new Error('MCP gate is required but the global tool list could not be read', { cause: error })
      }
      if (!Array.isArray(schemas)) throw new Error('MCP gate is required but the global tool list is not an array')
      const allowedServers = new Set(pool.mcpServers)
      let ambiguous = 0
      for (const schema of schemas) {
        const name = schema?.name
        if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) continue
        observedMcp += 1
        visibleMcpNames.push(name)
        if (isAmbiguousMcpToolName(name)) {
          // The public name cannot be attributed to one server; deny rather than
          // allow by a prefix that an external server could share.
          ambiguous += 1
          denyMcp.push(name)
          continue
        }
        if (!allowedServers.has(mcpServerOf(name))) denyMcp.push(name)
      }
      if (ambiguous > 0) {
        logger?.warn?.(`[resource-pool] denied ${ambiguous} ambiguous MCP tool name${ambiguous === 1 ? '' : 's'} to avoid cross-server prefix allow`)
      }
    }

    // ---- Apply transactionally: install the new MCP deny while the old one is
    // still active (restrictions intersect, so this can only tighten), release
    // only the non-critical old effects, and release the old deny last. A
    // failed critical registration leaves the previous gate untouched.
    const previous = record.disposers
    const pending = []
    let incomplete = false
    const addEffect = (register, label, { critical = false, deny } = {}) => {
      try {
        const dispose = agent.ctx.effect(register, `resource-pool.${label}`)
        pending.push({
          dispose: typeof dispose === 'function' ? dispose : () => {},
          label,
          ...(Array.isArray(deny) ? { deny: [...deny] } : {}),
        })
        return true
      } catch (error) {
        if (critical) throw error
        incomplete = true
        logger?.debug?.(`[resource-pool] ${label} registration failed: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }

    let retainedInvisible = false
    let underRestricted = false
    let overRestricted = false
    try {
      // Separate old restriction layers before registering anything.
      const oldRestrictions = []
      for (const entry of previous) {
        if (RESTRICT_LABELS.has(entry.label)) oldRestrictions.push(entry)
        else disposeEntry(entry)
      }
      record.disposers = oldRestrictions

      const visibleSet = new Set(visibleMcpNames)
      // Old layers that cover an invisible name will be retained; their visible
      // denied names are already covered, so do not stack duplicates.
      const retainedCoverage = new Set(
        oldRestrictions
          .filter((entry) => {
            const names = Array.isArray(entry.deny) ? entry.deny : []
            return names.some((name) => !visibleSet.has(name))
          })
          .flatMap((entry) => (Array.isArray(entry.deny) ? entry.deny : [])),
      )
      const failedNames = []
      const newEntries = []
      let restrictFailures = 0
      if (pool.gateMcp && observedMcp > 0) {
        for (const name of denyMcp) {
          if (retainedCoverage.has(name)) continue
          try {
            const dispose = agent.ctx.effect(
              () => agent.ctx.tools.restrict({ deny: [name] }),
              'resource-pool.mcp-restrict',
            )
            const entry = {
              dispose: typeof dispose === 'function' ? dispose : () => {},
              label: 'mcp-restrict',
              deny: [name],
            }
            pending.push(entry)
            newEntries.push(entry)
          } catch (error) {
            restrictFailures += 1
            failedNames.push(name)
            incomplete = true
            logger?.warn?.(
              `[resource-pool] one MCP restrict layer could not be registered (retaining old layers): ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }

      // Skill providers and prompt sections are keyed by name, so the old
      // registration of that kind must be gone before the new one is inserted.
      // They are not a rights-widening boundary: if the new one fails, the Agent
      // has no pool skills / summary, which fails closed for this Agent.
      if (allowedSkills.size > 0) {
        if (skills === undefined || typeof skills.registerProvider !== 'function') {
          logger?.warn?.('[resource-pool] skills registry unavailable; library skills cannot be served')
        } else {
          const root = libraryRoot()
          addEffect(
            () => skills.registerProvider((control) => createLibraryProvider({ root, allowed: allowedSkills, logger, control })),
            'skill-provider',
          )
        }
      }

      if (!pool.gateMcp) {
        // Explicit no-gate intent: release every layer, including names that
        // are not currently visible.
        for (const entry of oldRestrictions) disposeEntry(entry)
        record.disposers = pending
      } else if (observedMcp === 0) {
        // No MCP tool is visible: we cannot name anything new, so keep every old
        // per-tool layer (transient host generation change).
        record.disposers = [...pending, ...oldRestrictions]
        retainedInvisible = oldRestrictions.length > 0
        overRestricted = oldRestrictions.some((entry) =>
          (Array.isArray(entry.deny) ? entry.deny : []).some((name) => !visibleSet.has(name)),
        )
      } else if (restrictFailures > 0) {
        // A brand-new Agent has no prior authorization to fall back on: partial
        // MCP coverage must fail creation.
        if (!record.activated) throw new Error('MCP restrict registration failed for a new Agent')
        const oldCoverage = new Set(
          oldRestrictions.flatMap((entry) => (Array.isArray(entry.deny) ? entry.deny : [])),
        )
        // Drop a successful new layer if an old retained layer already covers
        // the same name, so repeated failures cannot grow the active set.
        for (const entry of newEntries) {
          const name = entry.deny?.[0]
          if (!oldCoverage.has(name)) continue
          disposeEntry(entry)
          const index = pending.indexOf(entry)
          if (index >= 0) pending.splice(index, 1)
        }
        retainedInvisible = oldRestrictions.length > 0
        underRestricted = failedNames.some((name) => !oldCoverage.has(name))
        const deniedSet = new Set(denyMcp)
        overRestricted = oldRestrictions.some((entry) =>
          (Array.isArray(entry.deny) ? entry.deny : []).some(
            (name) => !visibleSet.has(name) || !deniedSet.has(name),
          ),
        )
        record.disposers = [...pending, ...oldRestrictions]
      } else {
        const retained = []
        for (const entry of oldRestrictions) {
          const names = Array.isArray(entry.deny) ? entry.deny : []
          // A name not visible now cannot be re-registered; keep the old layer
          // that covers it. If it also covered a currently visible allowed name,
          // the old layer must stay too (it cannot be split), so the result is
          // reported as degraded rather than claimed fully applied.
          if (names.some((name) => !visibleSet.has(name))) {
            retained.push(entry)
            retainedInvisible = true
          } else {
            disposeEntry(entry)
          }
        }
        record.disposers = [...pending, ...retained]
        const deniedSet = new Set(denyMcp)
        overRestricted = retained.some((entry) =>
          (Array.isArray(entry.deny) ? entry.deny : []).some(
            (name) => !visibleSet.has(name) || !deniedSet.has(name),
          ),
        )
      }

      record.activated = true
      record.mcpGateActive = pool.gateMcp
      // Any retained layer covering a currently invisible name means the last
      // safe activation could not be reconstructed exactly. Keep conservative
      // semantics so a later state failure refreshes coverage for new tools.
      // An under-restriction activation has no complete prior gate, so a later
      // state failure must attempt a conservative refresh even if some new
      // per-tool layers succeeded and there were no old layers.
      record.conservative = retainedInvisible || underRestricted
      record.degraded = overRestricted
      record.underRestricted = underRestricted
      record.signature = incomplete || retainedInvisible ? '' : signature
    } catch (error) {
      // No successful commit: remove anything this attempt registered and leave
      // the previous gate (still in `record.disposers`) in force. Clear the
      // signature so a later ordinary re-apply retries the failed layer set.
      for (const entry of pending.reverse()) disposeEntry(entry)
      record.signature = ''
      throw error
    }

    logger?.debug?.(
      `[resource-pool] activated mode=${mode} cwd=${cwd} skills=${allowedSkills.size}/${libraryNames.length} mcpHidden=${denyMcp.length}`,
    )
  }

  /** Re-apply the current document to every live Agent. */
  const reapplyAll = async () => {
    const registry = ctx.get('agents')
    const live = typeof registry?.list === 'function' ? registry.list() : []
    // A failure for one Agent must not stop the others, and it must not be
    // reported as a successful application for that Agent. Messages are fixed
    // so callers can show a warning without echoing tool names or state bytes.
    const results = await Promise.all(
      live.map(async (agent) => {
        try {
          return await applyToAgent(agent, { force: true, conservative: true })
        } catch (error) {
          logger?.warn?.(`[resource-pool] re-apply failed: ${error instanceof Error ? error.message : String(error)}`)
          return { ok: false, code: 'resource-pool/activation-failed', message: 'activation failed' }
        }
      }),
    )
    const failed = results.filter((result) => result !== undefined && result.ok === false)
    const count = (key) => results.filter((result) => result?.[key] === true).length
    const under = count('underRestricted')
    const over = count('overRestricted')
    const conservative = count('conservative')
    const noVisible = count('noVisibleTools')
    const retainedOldGate = count('retainedOldGate')
    const fallbackFailed = count('fallbackFailed')
    const degraded = over
    const seen = new Set()
    const warnings = []
    for (const result of results) {
      if (result === undefined || typeof result.code !== 'string' || typeof result.message !== 'string') continue
      if (result.ok === true && result.degraded !== true) continue
      const key = `${result.code}|${result.message}`
      if (seen.has(key)) continue
      seen.add(key)
      warnings.push({ code: result.code, message: result.message })
    }
    return {
      total: live.length,
      failed: failed.length,
      degraded,
      under,
      over,
      conservative,
      noVisible,
      retainedOldGate,
      fallbackFailed,
      warnings,
    }
  }

  /** Release one Agent's registrations. */
  const disposeAgent = (agent) => {
    release(agent)
    agents.delete(agent)
  }

  /** Release every Agent's registrations (plugin unload). */
  const disposeAll = () => {
    const registry = ctx.get('agents')
    const live = typeof registry?.list === 'function' ? registry.list() : []
    for (const agent of live) disposeAgent(agent)
  }

  return { applyToAgent, reapplyAll, disposeAgent, disposeAll }
}
