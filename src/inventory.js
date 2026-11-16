/**
 * Live inventory for the settings page (§6.1).
 *
 * v3 supplies library skills through a provider registered on *each Agent's own
 * context*, so the global registry view deliberately cannot see them: the pool
 * document is the source of truth for pool members and the on-disk library is
 * the source of truth for their descriptions/paths/digests. The registry is
 * only used for the read-only "system skills" section.
 *
 * Everything here is defensive: a missing service, a provider failure or an
 * unreadable directory degrades that one field instead of failing the whole
 * read.
 *
 * @module dsh-skill-pool/inventory
 */

import { join } from 'node:path'

import { listLibrarySkills } from './library.js'
import { MCP_TOOL_PREFIX, effectiveEnabled, effectiveScope, groupKeyOfSource, mcpServerOf } from './rules.js'
import { mcpEntryId } from './uploads.js'

/** Provider name the library provider registers under (must match §3). */
const LIBRARY_PROVIDER = 'resource-pool'

/** Maximum rows kept in one inventory section. */
const MAX_ROWS = 500
/** Maximum description length returned per skill. */
const DESCRIPTION_LIMIT = 300

/** Read one optional service without throwing. */
function optional(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** Clamp one description for the picker. */
function clipDescription(value) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > DESCRIPTION_LIMIT ? `${text.slice(0, DESCRIPTION_LIMIT - 1)}…` : text
}

/** Whether a skill name looks like a usable catalog entry. */
function isPlainString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Collect the skill catalog for one scope.
 *
 * @param {object} ctx - plugin context.
 * @param {{ cwd?: string, agent?: object }} [options] - lookup identity.
 * @returns {Promise<Array<object>>} skill summaries.
 */
async function skillsFor(ctx, { cwd, agent } = {}) {
  const skills = optional(ctx, 'skills')
  if (skills === undefined || typeof skills.snapshot !== 'function') return []
  const options = {}
  if (typeof cwd === 'string' && cwd.length > 0) options.cwd = cwd
  if (agent !== undefined) options.scope = agent
  let snapshot
  try {
    snapshot = await skills.snapshot(options)
  } catch {
    return []
  }
  const list = Array.isArray(snapshot?.skills) ? snapshot.skills : []
  const out = []
  for (const skill of list) {
    if (skill === null || typeof skill !== 'object') continue
    if (!isPlainString(skill.name)) continue
    out.push({
      name: skill.name.trim(),
      description: clipDescription(skill.description),
      path: typeof skill.path === 'string' ? skill.path : '',
      source: typeof skill.source === 'string' ? skill.source : '',
      provider: typeof skill.provider === 'string' ? skill.provider : '',
      modelInvocable: skill.invocation?.modelInvocable !== false,
      userInvocable: skill.invocation?.userInvocable !== false,
    })
  }
  return out
}

/**
 * Union every live Agent's skill catalog with the global one.
 *
 * @param {object} ctx - plugin context.
 * @param {{ cwd?: string, agent?: object }} [options] - preferred identity.
 * @returns {Promise<Array<object>>} de-duplicated skill summaries.
 */
export async function collectSkills(ctx, { cwd, agent } = {}) {
  const byName = new Map()
  const add = (entries) => {
    for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry)
  }
  add(await skillsFor(ctx, { cwd }))
  if (agent !== undefined) add(await skillsFor(ctx, { cwd, agent }))
  const agents = optional(ctx, 'agents')
  const live = typeof agents?.list === 'function' ? agents.list() : []
  for (const each of live.slice(0, 8)) {
    try {
      add(await skillsFor(ctx, { cwd: each?.session?.header?.cwd ?? cwd, agent: each }))
    } catch {
      /* one broken agent must not hide the rest */
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)).slice(0, MAX_ROWS)
}

/**
 * Build the `skills` section: one row per pool member (§6.1), enriched from the
 * on-disk library. A member whose directory disappeared is returned with
 * `missing: true` instead of being dropped, so the panel can explain and clean
 * up a broken entry.
 *
 * @param {object} state - normalized document.
 * @param {Array<object>} librarySkills - `listLibrarySkills()` output.
 * @param {string} libraryRoot - library skills root.
 * @returns {Array<object>} skill rows.
 */
function skillRows(state, librarySkills, libraryRoot) {
  const byName = new Map(librarySkills.map((entry) => [entry.name, entry]))
  const sources = state.sources !== null && typeof state.sources === 'object' ? state.sources : {}
  const members = state.skills !== null && typeof state.skills === 'object' ? state.skills : {}
  const rows = []
  for (const [name, member] of Object.entries(members)) {
    const installed = byName.get(name)
    const fallbackPath = typeof libraryRoot === 'string' && libraryRoot.length > 0
      ? join(libraryRoot, name, 'SKILL.md')
      : ''
    const source = member.sourceId === undefined ? undefined : sources[member.sourceId]
    const groupKey = groupKeyOfSource(source)
    const effective = effectiveScope(state, member)
    rows.push({
      name,
      description: typeof installed?.description === 'string' ? installed.description : '',
      path: typeof installed?.path === 'string' ? installed.path : fallbackPath,
      sourceId: typeof member.sourceId === 'string' ? member.sourceId : '',
      sourceLabel: typeof source?.label === 'string' ? source.label : '',
      // The panel groups rows by this key and edits the scope once per group.
      groupKey,
      groupName: groupKey.startsWith('repo:') ? groupKey.slice(5) : typeof source?.label === 'string' ? source.label : '',
      enabled: member.enabled !== false,
      effectiveEnabled: effectiveEnabled(state, member),
      modes: Array.isArray(member.modes) ? [...member.modes] : [],
      workspaces: Array.isArray(member.workspaces) ? [...member.workspaces] : [],
      modesFrom: member.modesFrom === 'self' ? 'self' : 'group',
      workspacesFrom: member.workspacesFrom === 'self' ? 'self' : 'group',
      effectiveModes: Array.isArray(effective.modes) ? [...effective.modes] : [],
      effectiveWorkspaces: Array.isArray(effective.workspaces) ? [...effective.workspaces] : [],
      digest: typeof installed?.digest === 'string'
        ? installed.digest
        : typeof member.digest === 'string' ? member.digest : '',
      installedAt: typeof member.installedAt === 'string' ? member.installedAt : '',
      modelInvocable: installed === undefined ? true : installed.modelInvocable !== false,
      missing: installed === undefined,
    })
    if (rows.length >= MAX_ROWS) break
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Build the read-only `nativeSkills` section: skills the global registry knows
 * that this plugin does not supply (§6.1).
 *
 * @param {Array<object>} catalog - live skill summaries.
 * @param {object} state - normalized document.
 * @returns {Array<object>} native skill rows.
 */
function nativeSkillRows(catalog, state) {
  const members = state.skills !== null && typeof state.skills === 'object' ? state.skills : {}
  const rows = []
  for (const skill of catalog) {
    if (skill.provider === LIBRARY_PROVIDER) continue
    if (Object.hasOwn(members, skill.name)) continue
    rows.push({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      provider: skill.provider,
    })
    if (rows.length >= MAX_ROWS) break
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Collect mounted MCP servers and the public tool names they registered.
 *
 * A server is discovered from two independent observations so a server keeps
 * its entry even when one side is temporarily unavailable:
 * - its managed `@deepseek-ai/dsh-mcp-client` Loader row (`rp-<serverName>`),
 *   which carries `config.serverName` and the transport;
 * - the live global tool names under `mcp__<serverName>__`.
 *
 * @param {object} ctx - plugin context.
 * @returns {Array<object>} servers with their tools.
 */
export function collectMcpServers(ctx) {
  /** @type {Map<string, {serverName: string, transport: string, tools: string[], source: string}>} */
  const byServer = new Map()
  const ensure = (serverName) => {
    let entry = byServer.get(serverName)
    if (entry === undefined) {
      entry = { serverName, transport: '', tools: [], source: 'tool', entryId: '', managed: false }
      byServer.set(serverName, entry)
    }
    return entry
  }

  const tools = optional(ctx, 'tools')
  if (tools !== undefined && typeof tools.schemas === 'function') {
    try {
      for (const schema of tools.schemas()) {
        const name = schema?.name
        if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) continue
        const server = mcpServerOf(name)
        if (server.length === 0) continue
        ensure(server).tools.push(name)
      }
    } catch {
      /* tool runtime unavailable; loader rows may still describe servers */
    }
  }

  const loader = optional(ctx, 'loader')
  if (loader !== undefined && typeof loader.entries === 'function') {
    try {
      for (const entry of loader.entries()) {
        const name = entry?.options?.name
        if (name !== '@deepseek-ai/dsh-mcp-client') continue
        if (entry.disabled === true) continue
        const config = entry.options?.config ?? {}
        const serverName = typeof config.serverName === 'string' && config.serverName.length > 0
          ? config.serverName
          : String(entry.options?.id ?? '').replace(/^[^-]+-/, '')
        if (serverName.length === 0) continue
        const record = ensure(serverName)
        const id = String(entry.options?.id ?? '')
        if (id.length > 0) record.entryId = id
        // Rows created by this plugin use the "rp-" prefix; the connector uses "mcp-".
        if (id.startsWith('rp-')) record.managed = true
        if (record.transport.length === 0) record.transport = typeof config.transport === 'string' ? config.transport : ''
        record.source = record.source === 'tool' ? 'tool+loader' : 'loader'
      }
    } catch {
      /* loader unavailable; keep tool-derived servers */
    }
  }

  return [...byServer.values()]
    .map((entry) => ({
      serverName: entry.serverName,
      transport: entry.transport,
      tools: [...new Set(entry.tools)].sort(),
      toolCount: new Set(entry.tools).size,
      entryId: entry.entryId,
      managed: entry.managed,
      source: entry.source,
    }))
    .sort((left, right) => left.serverName.localeCompare(right.serverName))
}

/**
 * Build the `mcp` section: one row per pool member (§6.1), enriched with the
 * tools and loader row currently observed.
 *
 * @param {object} ctx - plugin context.
 * @param {object} state - normalized document.
 * @returns {Array<object>} MCP rows.
 */
function mcpRows(ctx, state) {
  let observed = []
  try {
    observed = collectMcpServers(ctx)
  } catch {
    observed = []
  }
  const byName = new Map(observed.map((entry) => [entry.serverName, entry]))
  const members = state.mcp !== null && typeof state.mcp === 'object' ? state.mcp : {}
  const rows = []
  for (const [server, member] of Object.entries(members)) {
    const live = byName.get(server)
    rows.push({
      server,
      tools: Array.isArray(live?.tools) ? [...live.tools] : [],
      managed: live?.managed === true,
      entryId: live?.entryId !== undefined && live.entryId.length > 0 ? live.entryId : mcpEntryId(server),
      enabled: member.enabled !== false,
      modes: Array.isArray(member.modes) ? [...member.modes] : [],
      workspaces: Array.isArray(member.workspaces) ? [...member.workspaces] : [],
      installedAt: typeof member.installedAt === 'string' ? member.installedAt : '',
    })
    if (rows.length >= MAX_ROWS) break
  }
  return rows.sort((left, right) => left.server.localeCompare(right.server))
}

/**
 * Collect Agent modes known without awaiting the preset registry: the modes live
 * sessions already use and an explicitly requested mode. The synthetic id the
 * host falls back to when a session carries no preset is *not* offered here: it
 * names no real preset, so a member scoped to it could never be hit.
 * @param {object} ctx - plugin context.
 * @param {{ currentMode?: string }} [options] - mode to include even when unlisted.
 * @returns {Array<{id: string, name: string, order?: number}>} modes.
 */
export function collectModes(ctx, { currentMode } = {}) {
  /** @type {Map<string, {id: string, name: string, order?: number}>} */
  const byId = new Map()
  const add = (id) => {
    if (typeof id !== 'string' || id.trim().length === 0) return
    const key = id.trim()
    if (!byId.has(key)) byId.set(key, { id: key, name: key })
  }
  const agents = optional(ctx, 'agents')
  const live = typeof agents?.list === 'function' ? agents.list() : []
  for (const agent of live) add(agent?.session?.header?.agentPreset)
  if (typeof currentMode === 'string') add(currentMode)
  return [...byId.values()]
}

/**
 * Collect Agent modes, awaiting the preset registry for display names and order.
 * @param {object} ctx - plugin context.
 * @param {{ currentMode?: string }} [options] - mode to include even when unlisted.
 * @returns {Promise<Array<{id: string, name: string, order?: number}>>} modes.
 */
export async function collectModesAsync(ctx, options = {}) {
  const byId = new Map(collectModes(ctx, options).map((mode) => [mode.id, mode]))
  const registry = optional(ctx, 'agentPresets')
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      const presets = await registry.list()
      if (Array.isArray(presets)) {
        for (const preset of presets) {
          const id = typeof preset?.id === 'string' ? preset.id.trim() : ''
          if (id.length === 0) continue
          byId.set(id, {
            id,
            name: typeof preset.name === 'string' && preset.name.length > 0 ? preset.name : id,
            ...(typeof preset.order === 'number' ? { order: preset.order } : {}),
          })
        }
      }
    } catch {
      /* registry failure leaves the live/default modes */
    }
  }
  return [...byId.values()].sort((left, right) => (left.order ?? 999) - (right.order ?? 999) || left.name.localeCompare(right.name))
}

/**
 * Collect workspaces plus any working directory a live session uses.
 * @param {object} ctx - plugin context.
 * @returns {Array<{id: string, name: string, path: string}>} workspaces.
 */
export function collectWorkspaces(ctx) {
  const registry = optional(ctx, 'workspaceRegistry')
  /** @type {Map<string, {id: string, name: string, path: string}>} */
  const byPath = new Map()
  let list = []
  try {
    list = typeof registry?.list === 'function' ? registry.list() : []
  } catch {
    list = []
  }
  for (const workspace of list) {
    const path = typeof workspace?.path === 'string' ? workspace.path : ''
    if (path.length === 0) continue
    const name = typeof workspace.title === 'string' && workspace.title.length > 0 ? workspace.title : path
    byPath.set(path, { id: typeof workspace.id === 'string' ? workspace.id : path, name, path })
  }
  const agents = optional(ctx, 'agents')
  const live = typeof agents?.list === 'function' ? agents.list() : []
  for (const agent of live) {
    const path = agent?.session?.header?.cwd
    if (typeof path !== 'string' || path.length === 0) continue
    if (byPath.has(path)) continue
    byPath.set(path, { id: path, name: path.split('/').filter(Boolean).pop() ?? path, path })
  }
  return [...byPath.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Build the complete inventory payload for the panel (§6.1).
 *
 * @param {object} ctx - plugin context.
 * @param {{
 *   state?: object,
 *   libraryRoot?: string,
 *   cwd?: string,
 *   agent?: object,
 *   currentMode?: string,
 * }} [options] - document, library root, and preferred identity.
 * @returns {Promise<{skills: object[], nativeSkills: object[], mcp: object[],
 *   modes: string[], workspaces: string[]}>} inventory.
 */
export async function buildInventory(ctx, options = {}) {
  const state = options.state !== null && typeof options.state === 'object' ? options.state : defaultInventoryState()
  const libraryRoot = typeof options.libraryRoot === 'string' ? options.libraryRoot : ''
  const [librarySkills, catalog, collectedModes] = await Promise.all([
    listLibrarySkills(libraryRoot.length > 0 ? { root: libraryRoot } : {}).catch(() => []),
    collectSkills(ctx, options).catch(() => []),
    collectModesAsync(ctx, { currentMode: options.currentMode }).catch(() => []),
  ])
  const skills = skillRows(state, librarySkills, libraryRoot)
  const nativeSkills = nativeSkillRows(catalog, state)
  const mcp = mcpRows(ctx, state)

  // §6.1 returns plain ids/paths: the panel renders them in multi-selects and
  // sends the chosen values straight back to `/item`.
  const modeIds = []
  for (const mode of collectedModes) {
    if (typeof mode?.id !== 'string' || mode.id.length === 0) continue
    if (!modeIds.includes(mode.id)) modeIds.push(mode.id)
  }
  const modes = modeIds
  const registry = optional(ctx, 'agentPresets')
  let defaultMode = ''
  try {
    const id = registry?.defaultId
    if (typeof id === 'string') defaultMode = id.trim()
  } catch {
    /* a broken registry leaves the caller to pick the first mode */
  }
  let workspaces = []
  try {
    workspaces = collectWorkspaces(ctx)
      .map((workspace) => workspace.path)
      .filter((path) => typeof path === 'string' && path.length > 0)
  } catch {
    workspaces = []
  }
  return { skills, nativeSkills, mcp, modes, workspaces, defaultMode: defaultMode.length > 0 ? defaultMode : (modes[0] ?? '') }
}

/** Minimal document used when the caller has no state yet. */
function defaultInventoryState() {
  return { skills: {}, mcp: {}, sources: {} }
}
