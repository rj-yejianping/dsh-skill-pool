/**
 * Session-scope resolution for the single global pool.
 *
 * Every pool member carries two independent filters — Agent modes and
 * workspaces — and both must admit the session (AND). An empty filter admits
 * everything, so a freshly added member is active everywhere by default.
 *
 * Pure functions only: the same helpers serve the Host gate and the panel's
 * preview.
 *
 * @module dsh-skill-pool/rules
 */

/** Prefix of every MCP tool registered by `dsh-mcp-client`. */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * Normalize a path for comparison (forward slashes, no trailing slash).
 * @param {unknown} value - candidate path.
 * @returns {string} comparable path, or ''.
 */
export function comparablePath(value) {
  if (typeof value !== 'string') return ''
  let path = value.trim().replace(/\\/g, '/')
  if (path.length === 0) return ''
  path = path.replace(/\/{2,}/g, '/')
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/**
 * Whether two paths name the same directory.
 * @param {unknown} left - first path.
 * @param {unknown} right - second path.
 * @returns {boolean} equality after lexical normalization.
 */
export function samePath(left, right) {
  const a = comparablePath(left)
  const b = comparablePath(right)
  return a.length > 0 && a === b
}

/**
 * Whether `child` sits inside `parent` (or is `parent` itself).
 * @param {unknown} child - candidate descendant path.
 * @param {unknown} parent - candidate ancestor path.
 * @returns {boolean} whether the descendant relationship holds.
 */
export function isUnder(child, parent) {
  const a = comparablePath(child)
  const b = comparablePath(parent)
  if (a.length === 0 || b.length === 0) return false
  if (a === b) return true
  return a.startsWith(b.endsWith('/') ? b : `${b}/`)
}

/**
 * Group key of one source record: the repository when it has one, else the
 * import itself. Empty when the record names neither.
 *
 * @param {{project?: string, id?: string}|null|undefined} source - source record.
 * @returns {string} `repo:<project>`, `import:<id>`, or ''.
 */
export function groupKeyOfSource(source) {
  if (source === null || typeof source !== 'object') return ''
  const project = typeof source.project === 'string' ? source.project.trim() : ''
  if (project.length > 0) return `repo:${project}`
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  return id.length > 0 ? `import:${id}` : ''
}

/**
 * Group key of one pool member, following its source.
 *
 * @param {object} state - normalized document.
 * @param {{sourceId?: string}|null|undefined} member - pool member.
 * @returns {string} group key, or '' when the member has no source.
 */
export function groupKeyOfMember(state, member) {
  if (member === null || typeof member !== 'object') return ''
  const sourceId = typeof member.sourceId === 'string' ? member.sourceId : ''
  if (sourceId.length === 0) return ''
  const sources = state?.sources
  if (sources === null || typeof sources !== 'object') return ''
  return groupKeyOfSource(sources[sourceId])
}

/**
 * The group record one member belongs to, if any.
 *
 * @param {object} state - normalized document.
 * @param {{sourceId?: string}|null|undefined} member - pool member.
 * @returns {object|undefined} group record.
 */
export function groupOfMember(state, member) {
  const key = groupKeyOfMember(state, member)
  if (key.length === 0) return undefined
  const groups = state?.groups
  if (groups === null || typeof groups !== 'object') return undefined
  const group = groups[key]
  return group !== null && typeof group === 'object' ? group : undefined
}

/**
 * Resolve one member's effective scope after group inheritance.
 *
 * `modesFrom` / `workspacesFrom` are `group` (inherit) or `self` (this member's
 * own list); the store normalizes them, so a member without one keeps its own
 * list. A missing group falls back to the member's own list.
 *
 * @param {object} state - normalized document.
 * @param {{modes?: string[], workspaces?: string[], modesFrom?: string, workspacesFrom?: string}} member - pool member.
 * @returns {{modes: string[], workspaces: string[]}} effective scope.
 */
export function effectiveScope(state, member) {
  const group = groupOfMember(state, member)
  const ownModes = Array.isArray(member?.modes) ? member.modes : []
  const ownWorkspaces = Array.isArray(member?.workspaces) ? member.workspaces : []
  const inheritModes = member?.modesFrom === 'group' && group !== undefined
  const inheritWorkspaces = member?.workspacesFrom === 'group' && group !== undefined
  return {
    modes: inheritModes && Array.isArray(group.modes) ? group.modes : ownModes,
    workspaces: inheritWorkspaces && Array.isArray(group.workspaces) ? group.workspaces : ownWorkspaces,
  }
}

/**
 * Whether one member is switched on, taking its group's switch into account.
 *
 * A disabled group disables every member without touching their own flag, so
 * turning the repository back on restores exactly the previous per-member state.
 *
 * @param {object} state - normalized document.
 * @param {{enabled?: boolean, sourceId?: string}} member - pool member.
 * @returns {boolean} whether the member may be active.
 */
export function effectiveEnabled(state, member) {
  if (member?.enabled === false) return false
  const group = groupOfMember(state, member)
  return group === undefined ? true : group.enabled !== false
}

/**
 * Whether one member's scope admits a session.
 *
 * `allModes` / `allWorkspaces` drop one dimension entirely: the panel's "all"
 * preview option asks "what would be visible if this dimension did not filter",
 * which is not the same as passing an empty mode or cwd.
 *
 * @param {{modes?: string[], workspaces?: string[]}|null|undefined} entry - pool member scope.
 * @param {{mode?: string, cwd?: string, allModes?: boolean, allWorkspaces?: boolean}} target - session identity.
 * @returns {boolean} whether both filters admit the session.
 */
export function scopeMatches(entry, { mode, cwd, allModes, allWorkspaces } = {}) {
  if (entry === null || typeof entry !== 'object') return false
  const modes = Array.isArray(entry.modes) ? entry.modes : []
  const workspaces = Array.isArray(entry.workspaces) ? entry.workspaces : []
  if (allModes !== true && modes.length > 0) {
    const targetMode = typeof mode === 'string' ? mode : ''
    if (!modes.includes(targetMode)) return false
  }
  if (allWorkspaces !== true && workspaces.length > 0) {
    const targetPath = comparablePath(cwd)
    if (targetPath.length === 0) return false
    if (!workspaces.some((workspace) => isUnder(targetPath, workspace))) return false
  }
  return true
}

/**
 * Whether one pool member is active for a session (present, enabled, admitted).
 * @param {{enabled?: boolean, modes?: string[], workspaces?: string[]}|null|undefined} entry - pool member scope.
 * @param {{mode?: string, cwd?: string}} target - session identity.
 * @returns {boolean} whether the member is active.
 */
export function itemActive(entry, target = {}) {
  if (entry === null || typeof entry !== 'object') return false
  if (entry.enabled === false) return false
  return scopeMatches(entry, target)
}

/**
 * Resolve the pool for one session.
 *
 * @param {object} state - normalized document.
 * @param {{mode?: string, cwd?: string, allModes?: boolean, allWorkspaces?: boolean}} target - session identity.
 * @returns {{gated: boolean, skills: string[], mcpServers: string[],
 *   gateSkills: boolean, gateMcp: boolean}} resolved pool.
 */
export function resolvePool(state, { mode, cwd, allModes, allWorkspaces } = {}) {
  const settings = state?.settings ?? {}
  const empty = { gated: false, skills: [], mcpServers: [], gateSkills: false, gateMcp: false }
  if (settings.enabled === false) return empty

  const target = { mode, cwd, allModes, allWorkspaces }
  const skillsMap = state?.skills !== null && typeof state?.skills === 'object' ? state.skills : {}
  const mcpMap = state?.mcp !== null && typeof state?.mcp === 'object' ? state.mcp : {}

  const skills = Object.entries(skillsMap)
    .filter(([, entry]) =>
      itemActive(
        { ...entry, ...effectiveScope(state, entry), enabled: effectiveEnabled(state, entry) },
        target,
      ),
    )
    .map(([name]) => name)
    .sort()
  const mcpServers = Object.entries(mcpMap)
    .filter(([, entry]) => itemActive({ ...entry, enabled: effectiveEnabled(state, entry) }, target))
    .map(([name]) => name)
    .sort()

  // Gate each namespace only when that namespace has pool members: importing a
  // single MCP server must not hide every skill, and vice versa.
  //
  // Skills need no switch of their own in v3: the pool owns its library, so
  // "member or not" is already the whole decision. MCP keeps `mcpGate` because
  // its members are Loader-managed servers that may exist outside the pool.
  const hasSkillMembers = Object.keys(skillsMap).length > 0
  const hasMcpMembers = Object.keys(mcpMap).length > 0
  const gateSkills = hasSkillMembers
  const gateMcp = hasMcpMembers && settings.mcpGate !== false
  return {
    gated: gateSkills || gateMcp,
    skills: hasSkillMembers ? skills : [],
    mcpServers: hasMcpMembers ? mcpServers : [],
    gateSkills,
    gateMcp,
  }
}

/**
 * Whether an MCP public tool name has more than one plausible server split.
 *
 * The public name is `mcp__<server>__<raw>`, and neither `server` nor `raw` is
 * prevented from containing `__`. Parsing at the first separator can therefore
 * attribute an external `alpha__a` tool to an allowed `alpha` server. Callers
 * use this predicate to deny an ambiguous name instead of allowing it by
 * prefix. This is deliberately conservative: a legitimate raw name containing
 * `__` is hidden too.
 *
 * @param {unknown} toolName - model-facing tool name.
 * @returns {boolean} whether the server boundary is ambiguous (or malformed).
 */
export function isAmbiguousMcpToolName(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_TOOL_PREFIX)) return false
  // A 12-hex suffix is the host's lossy-normalization/truncation marker. Such a
  // name may have lost a server separator, so it cannot be prefix-allowed.
  if (/_[0-9a-f]{12}$/.test(toolName)) return true
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  // Every position that can split rest into non-empty server + non-empty raw.
  // Overlapping separators matter: `a___b` can split as (`a`, `_b`) or
  // (`a_`, `b`), so `indexOf('__', first + 2)` is not enough.
  const splits = []
  for (let index = 1; index + 2 < rest.length; index += 1) {
    if (rest[index] === '_' && rest[index + 1] === '_') splits.push(index)
  }
  return splits.length !== 1
}

/**
 * Parse the MCP Server name out of one public tool name.
 * @param {unknown} toolName - model-facing tool name such as `mcp__qcc__search`.
 * @returns {string} server name, or '' when the name is not an MCP tool.
 */
export function mcpServerOf(toolName) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_TOOL_PREFIX)) return ''
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  const separator = rest.indexOf('__')
  const server = separator >= 0 ? rest.slice(0, separator) : rest
  return server.trim()
}
