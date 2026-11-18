/**
 * Durable resource-pool state (v4): one global pool, which *is* the user's
 * resource library.
 *
 * The document keeps five maps:
 * - `skills` / `mcp`: resource name -> membership (`enabled`, `modes`,
 *   `workspaces`) plus provenance (`sourceId`, `digest`, `installedAt`). A
 *   resource is in the pool exactly when it has an entry: an import writes the
 *   entry in the same transaction, there is no separate "add to pool" step.
 *   An `mcp` member also keeps its `definition` (URL/command/headers), which is
 *   what a Host restart re-mounts the `mcp-client` row from — see remount.js.
 *   A skill additionally carries `modesFrom` / `workspacesFrom`: `group` means
 *   "use the group of its source", `self` means "use my own list".
 * - `groups`: one scope per *repository* (`repo:<project>`) or, for imports
 *   without a repository, per import (`import:<sourceId>`). Members inherit it
 *   unless they opt out, so one edit scopes a whole repository.
 * - `sources`: where installed skills came from (git repository, ZIP archive or
 *   an uploaded file set), used to check for updates, update, or remove what a
 *   source installed.
 * - `settings`: the switches the panel exposes (§2.1).
 *
 * A v3 document is migrated (see `migrateV3`), not dropped: groups are derived
 * from what the members already do, so gating is identical before and after.
 * Any other version is reset to an empty document: v1/v2 used a different
 * membership model (a separate library and pool), and guessing a mapping would
 * silently change what is gated.
 *
 * Writes are atomic and serialized; the module has no Cordis imports so
 * `node --test` can load it directly.
 *
 * @module dsh-skill-pool/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { groupKeyOfSource } from './rules.js'

/** Current document version. */
export const STATE_VERSION = 4

/** The one older version this module upgrades instead of discarding. */
export const LEGACY_VERSION = 3

/** Group records keyed by `repo:<project>` or `import:<sourceId>`. */
export const GROUP_KINDS = ['repo', 'import']

/** Default file name under the DSH home. */
export const STATE_FILE_NAME = 'resource-pool/state.json'

/** Namespaces that hold pool members. */
export const KINDS = ['skill', 'mcp']

/** Provenance kinds a source record may have. */
export const SOURCE_KINDS = ['git', 'zip', 'files']

/** Git providers supported by the library (self-hosted GitLab is out of scope). */
export const GIT_PROVIDERS = ['github', 'gitlab']

/** Outcomes of one "check for updates" run, stored on the source (§2.1). */
export const CHECK_STATUSES = ['up-to-date', 'update-available', 'error']

/** Switches the panel may patch. */
export const SETTING_KEYS = ['enabled', 'mcpGate', 'injectSummary', 'gateDefaultSkills']

/** Conservative identifier grammar for resource names and mode ids. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

/** Resolve the DSH home directory (env override, else `~/.dsh`). */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** Absolute path of the state document. */
export function statePath() {
  return join(dshHome(), STATE_FILE_NAME)
}

/** Generate a short, collision-resistant id. */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Whether a value is a plain object (not an array, not null). */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Trim a candidate name, returning '' when unusable. */
function cleanName(value) {
  if (typeof value !== 'string') return ''
  const name = value.trim()
  return NAME_RE.test(name) ? name : ''
}

/**
 * Normalize a resource/mode name.
 * @param {unknown} value - candidate name.
 * @returns {string} the name when it satisfies the identifier grammar, else ''.
 */
export function normalizeItemName(value) {
  return cleanName(value)
}

/** Trim an optional string, returning '' when absent. */
function optionalString(value, limit = 4096) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, limit)
}

/** Maximum length of the user-written purpose summary of an MCP member. */
const DESCRIPTION_LIMIT = 300

/**
 * Normalize the user-written purpose summary of one MCP member.
 *
 * This text is model-facing metadata, kept next to (never inside) the connection
 * definition: it must not be able to smuggle connection fields, and an empty
 * value means "no summary" so a document never grows an empty key.
 *
 * @param {unknown} value - candidate description.
 * @returns {string} trimmed, length-capped description ('' when absent).
 */
function cleanDescription(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, DESCRIPTION_LIMIT)
}

/** Timestamp helper: keep a stored value, else use now. */
function timestamp(value) {
  const text = optionalString(value, 64)
  return text.length > 0 ? text : new Date().toISOString()
}

/** Deduplicate strings, preserving order. */
function unique(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Normalize one filesystem path for workspace matching (lexical, no realpath).
 * @param {unknown} value - candidate path.
 * @returns {string} absolute path with forward slashes and no trailing slash.
 */
export function normalizePath(value) {
  if (typeof value !== 'string') return ''
  let path = value.trim().replace(/\\/g, '/')
  if (path.length === 0) return ''
  const windowsDrive = /^[A-Za-z]:\//.test(path)
  if (!path.startsWith('/') && !windowsDrive) return ''
  path = path.replace(/\/{2,}/g, '/')
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/** Normalize a list of resource/mode names. */
function cleanNameList(value) {
  if (!Array.isArray(value)) return []
  const names = []
  for (const item of value) {
    const name = cleanName(item)
    if (name.length > 0) names.push(name)
  }
  return unique(names)
}

/** Normalize a list of workspace paths. */
function cleanPathList(value) {
  if (!Array.isArray(value)) return []
  const paths = []
  for (const item of value) {
    const path = normalizePath(item)
    if (path.length > 0) paths.push(path)
  }
  return unique(paths)
}

/** Normalize a source's repository subdirectory. */
function cleanSubdir(value) {
  const text = optionalString(value, 512).replace(/\\/g, '/')
  return text.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
}

/** Default settings of a fresh document (§2.1). */
export function defaultSettings() {
  return { enabled: true, mcpGate: true, injectSummary: true, gateDefaultSkills: false }
}

/** A fresh, empty document. */
export function defaultState() {
  return { version: STATE_VERSION, settings: defaultSettings(), skills: {}, mcp: {}, sources: {}, groups: {} }
}

/**
 * Normalize one activation scope.
 * @param {unknown} raw - candidate scope.
 * @returns {{enabled: boolean, modes: string[], workspaces: string[]}|null} scope, or null when unusable.
 */
export function normalizeScope(raw) {
  if (!isObject(raw)) return null
  return {
    enabled: raw.enabled !== false,
    modes: cleanNameList(raw.modes),
    workspaces: cleanPathList(raw.workspaces),
  }
}

/**
 * Normalize the provenance fields of one member (`sourceId`/`digest`/`installedAt`).
 * Empty optional values are omitted; `installedAt` is always present.
 *
 * @param {'skill'|'mcp'} kind - member namespace.
 * @param {unknown} extra - values supplied by an install/update.
 * @param {unknown} base - the member's previous entry, if any.
 * @returns {object} provenance fields to merge over the scope.
 */
function itemExtras(kind, extra, base) {
  const provided = isObject(extra) ? extra : {}
  const previous = isObject(base) ? base : {}
  const pick = (key) => {
    if (typeof provided[key] === 'string') return provided[key].trim()
    if (typeof previous[key] === 'string') return previous[key]
    return ''
  }
  const out = {}
  if (kind === 'skill') {
    const sourceId = pick('sourceId')
    if (sourceId.length > 0) out.sourceId = sourceId
    const digest = pick('digest')
    if (digest.length > 0) out.digest = digest
    // Inheritance is a member choice, not provenance: carry whichever side of
    // the write supplies it, so a scope edit never resets it to a default.
    for (const key of ['modesFrom', 'workspacesFrom']) {
      const value = provided[key]
      if (value === 'self' || value === 'group') out[key] = value
      else if (previous[key] === 'self' || previous[key] === 'group') out[key] = previous[key]
    }
  }
  if (kind === 'mcp') {
    // A scope-only edit (enable/disable, mode or workspace change) must not drop
    // the connection definition that makes the member survive a Host restart.
    const defined = cleanMcpDefinition(provided.definition) ?? cleanMcpDefinition(previous.definition)
    if (defined !== undefined) out.definition = defined
    // The user's purpose summary is metadata, stored apart from the definition:
    // an omitted description keeps the stored one, an empty string clears it.
    out.description =
      typeof provided.description === 'string' ? cleanDescription(provided.description) : cleanDescription(previous.description)
  }
  out.installedAt = pick('installedAt') || new Date().toISOString()
  return out
}

/** Transports a stored MCP definition may name. */
const MCP_TRANSPORTS = ['stdio', 'streamable-http']

/**
 * Normalize the stored connection definition of one MCP member.
 *
 * The definition is what lets a Host restart rebuild the `mcp-client` Loader
 * row: without it the member survived a restart while its connection did not,
 * leaving a pool entry that lists zero tools. Only the fields the mcp-client
 * plugin understands are kept, every value is length-capped, and an empty
 * result is dropped so the document never grows junk.
 *
 * @param {unknown} raw - candidate definition (`{url|command, ...}`).
 * @returns {object|undefined} cleaned definition, or undefined when unusable.
 */
export function cleanMcpDefinition(raw) {
  if (!isObject(raw)) return undefined
  const out = {}
  const serverName = optionalString(raw.serverName, 64)
  if (serverName.length > 0) out.serverName = serverName
  if (MCP_TRANSPORTS.includes(raw.transport)) out.transport = raw.transport
  const url = optionalString(raw.url, 2048)
  if (url.length > 0) out.url = url
  const command = optionalString(raw.command, 2048)
  if (command.length > 0) out.command = command
  if (Array.isArray(raw.args)) {
    const args = raw.args.filter((arg) => typeof arg === 'string').slice(0, 64).map((arg) => arg.slice(0, 2048))
    if (args.length > 0) out.args = args
  }
  for (const key of ['headers', 'env']) {
    if (!isObject(raw[key])) continue
    const table = {}
    for (const [name, value] of Object.entries(raw[key])) {
      if (typeof value !== 'string') continue
      if (name.length === 0 || name.length > 256) continue
      table[name] = value.slice(0, 4096)
    }
    if (Object.keys(table).length > 0) out[key] = table
  }
  const cwd = optionalString(raw.cwd, 2048)
  if (cwd.length > 0) out.cwd = cwd
  return Object.keys(out).length > 0 ? out : undefined
}

/** Normalize one pool member entry (deterministic: never invents a timestamp). */
function normalizeMember(kind, raw) {
  const scope = normalizeScope(raw)
  if (scope === null) return null
  const member = { ...scope }
  if (kind === 'skill') {
    const sourceId = optionalString(raw.sourceId, 128)
    if (sourceId.length > 0) member.sourceId = sourceId
    const digest = optionalString(raw.digest, 128)
    if (digest.length > 0) member.digest = digest
    // A member with its own non-empty list is "custom" unless it says otherwise:
    // that keeps documents written before v4 gating exactly the same.
    member.modesFrom = raw.modesFrom === 'self' ? 'self' : raw.modesFrom === 'group' ? 'group' : member.modes.length > 0 ? 'self' : 'group'
    member.workspacesFrom =
      raw.workspacesFrom === 'self' ? 'self' : raw.workspacesFrom === 'group' ? 'group' : member.workspaces.length > 0 ? 'self' : 'group'
  }
  if (kind === 'mcp') {
    // The user-written summary is metadata, never part of the connection
    // definition, so normalization keeps the two fields independent.
    const description = cleanDescription(raw.description)
    if (description.length > 0) member.description = description
    const definition = cleanMcpDefinition(raw.definition)
    if (definition !== undefined) member.definition = definition
  }
  const installedAt = optionalString(raw.installedAt, 64)
  member.installedAt = installedAt
  return member
}

/** Normalize one member map (`skills` or `mcp`). */
function normalizeMembers(raw, kind) {
  if (!isObject(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const name = cleanName(key)
    if (name.length === 0) continue
    const member = normalizeMember(kind, value)
    if (member === null) continue
    out[name] = member
  }
  return out
}

/** Normalize one `lastCheck` record (§2.1). */
function normalizeLastCheck(raw) {
  if (!isObject(raw)) return undefined
  const status = CHECK_STATUSES.includes(raw.status) ? raw.status : 'error'
  return {
    at: timestamp(raw.at),
    status,
    remote: optionalString(raw.remote, 128),
    error: optionalString(raw.error, 1024),
  }
}

/**
 * Derive the Git identity of a source from either the explicit fields or its
 * URL. The library re-parses `source.url` on check/update, so the URL is always
 * stored for Git sources.
 *
 * @param {object} raw - candidate source record.
 * @returns {{url: string, provider: string, project: string}|null} identity, or null.
 */
function deriveGit(raw) {
  const url = optionalString(raw.url, 2048)
  let provider = GIT_PROVIDERS.includes(raw.provider) ? raw.provider : ''
  let project = optionalString(raw.project, 512).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  let parsedUrl = url

  if (provider.length === 0 || project.split('/').length < 2) {
    if (url.length === 0) return null
    let text = url
    const ssh = /^git@([^:]+):(.+)$/.exec(text)
    if (ssh !== null) text = `https://${ssh[1]}/${ssh[2]}`
    let parsed
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    const host = parsed.hostname.toLowerCase()
    const derivedProvider = host.endsWith('github.com') ? 'github' : host.endsWith('gitlab.com') ? 'gitlab' : ''
    const derivedProject = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    if (derivedProvider.length === 0 || derivedProject.split('/').length < 2) return null
    provider = derivedProvider
    project = derivedProject
    parsedUrl = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`.replace(/\.git$/i, '')
  }
  if (parsedUrl.length === 0) {
    const host = provider === 'gitlab' ? 'gitlab.com' : 'github.com'
    parsedUrl = `https://${host}/${project}`
  }
  return { url: parsedUrl, provider, project }
}

/** Normalize one skill source record. */
function normalizeSource(raw) {
  if (!isObject(raw)) return null
  const kind = SOURCE_KINDS.includes(raw.kind) ? raw.kind : ''
  if (kind.length === 0) return null
  const id = cleanName(raw.id) || newId('src')
  const label = optionalString(raw.label, 160) || defaultLabel(kind)
  const source = {
    id,
    kind,
    label,
    skills: cleanNameList(raw.skills),
    // Names the user deleted from this source: an update must not reinstall
    // them. Kept apart from `skills` so "installed" stays the truth.
    excluded: cleanNameList(raw.excluded),
    createdAt: timestamp(raw.createdAt ?? raw.installedAt ?? raw.updatedAt),
  }
  const digest = optionalString(raw.digest, 128)
  if (digest.length > 0) source.digest = digest
  if (kind === 'git') {
    const git = deriveGit(raw)
    if (git === null) return null
    source.url = git.url
    source.provider = git.provider
    source.project = git.project
    source.branch = optionalString(raw.branch, 256) || 'main'
    source.subdir = cleanSubdir(raw.subdir)
    const sha = optionalString(raw.sha, 128)
    if (sha.length > 0) source.sha = sha
    const tokenCredential = optionalString(raw.tokenCredential, 128)
    if (tokenCredential.length > 0) source.tokenCredential = tokenCredential
    const lastCheck = normalizeLastCheck(raw.lastCheck)
    if (lastCheck !== undefined) source.lastCheck = lastCheck
  }
  return source
}

/** Fallback display label for one source kind. */
function defaultLabel(kind) {
  if (kind === 'git') return 'Git source'
  if (kind === 'zip') return 'ZIP import'
  return 'File upload'
}

/** Normalize one group record (`repo:<project>` / `import:<sourceId>`). */
function normalizeGroup(raw, fallbackKey) {
  if (!isObject(raw)) return null
  const key = optionalString(raw.key, 512) || optionalString(fallbackKey, 512)
  if (key.length === 0) return null
  const kind = GROUP_KINDS.includes(raw.kind) ? raw.kind : key.startsWith('import:') ? 'import' : 'repo'
  return {
    key,
    kind,
    // One switch for the whole repository: off means every member is off,
    // without rewriting the per-member flags (they keep their own state).
    enabled: raw.enabled !== false,
    modes: cleanNameList(raw.modes),
    workspaces: cleanPathList(raw.workspaces),
  }
}

/** Normalize the `groups` map. */
function normalizeGroups(raw) {
  if (!isObject(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    const group = normalizeGroup(value, key)
    if (group === null) continue
    out[group.key] = group
  }
  return out
}

/** Whether two name lists hold the same values in the same order. */
function sameNames(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

/**
 * Derive v4 groups from a v3 document: one group per repository (or per
 * non-git import), seeded with the value its members already share. A mixed
 * group starts empty, so the members that differ keep their own list.
 */
function deriveGroups(sources, skills) {
  const membersByKey = new Map()
  for (const member of Object.values(skills)) {
    const source = member.sourceId === undefined ? undefined : sources[member.sourceId]
    const key = groupKeyOfSource(source)
    if (key.length === 0) continue
    if (!membersByKey.has(key)) membersByKey.set(key, [])
    membersByKey.get(key).push(member)
  }
  const groups = {}
  for (const [key, members] of membersByKey) {
    const first = members[0]
    const uniformModes = members.every((member) => sameNames(member.modes, first.modes))
    const uniformWorkspaces = members.every((member) => sameNames(member.workspaces, first.workspaces))
    groups[key] = {
      key,
      kind: key.startsWith('import:') ? 'import' : 'repo',
      modes: uniformModes ? [...first.modes] : [],
      workspaces: uniformWorkspaces ? [...first.workspaces] : [],
    }
  }
  return groups
}

/**
 * Upgrade a v3 document to v4.
 *
 * Groups are inferred so that every member keeps the exact scope it had: a
 * repository whose members all agree gives that shared value to the group and
 * the members inherit it; a mixed repository starts empty and only the members
 * that already said something stay `self`. Nothing becomes more or less
 * visible.
 *
 * @param {object} source - raw v3 document.
 * @returns {object} v4 document.
 */
function migrateV3(source) {
  const rawSettings = isObject(source.settings) ? source.settings : {}
  const settings = {
    enabled: rawSettings.enabled !== false,
    mcpGate: rawSettings.mcpGate !== false,
    injectSummary: rawSettings.injectSummary !== false,
    gateDefaultSkills: rawSettings.gateDefaultSkills === true,
  }
  const sources = {}
  if (isObject(source.sources)) {
    for (const value of Object.values(source.sources)) {
      const normalized = normalizeSource(value)
      if (normalized === null) continue
      sources[normalized.id] = normalized
    }
  }
  const skills = normalizeMembers(source.skills, 'skill')
  const groups = deriveGroups(sources, skills)
  for (const member of Object.values(skills)) {
    const key = groupKeyOfSource(member.sourceId === undefined ? undefined : sources[member.sourceId])
    const group = groups[key]
    if (group === undefined) {
      member.modesFrom = 'self'
      member.workspacesFrom = 'self'
      continue
    }
    member.modesFrom = sameNames(member.modes, group.modes) ? 'group' : 'self'
    member.workspacesFrom = sameNames(member.workspaces, group.workspaces) ? 'group' : 'self'
  }
  return {
    version: STATE_VERSION,
    settings,
    skills,
    mcp: normalizeMembers(source.mcp, 'mcp'),
    sources,
    groups,
  }
}

/**
 * Normalize one group patch over the stored record (create when absent).
 *
 * @param {object} state - normalized document.
 * @param {unknown} patch - `{key, modes?, workspaces?}`.
 * @returns {object} normalized document (unchanged when the key is unusable).
 */
export function upsertGroup(state, patch) {
  const provided = isObject(patch) ? patch : {}
  const key = optionalString(provided.key, 512)
  if (key.length === 0) return state
  const existing = isObject(state.groups) ? state.groups[key] : undefined
  const group = normalizeGroup({ ...existing, ...provided, key }, key)
  if (group === null) return state
  return normalizeState({ ...state, groups: { ...state.groups, [key]: group } })
}

/**
 * Normalize a complete document.
 * @param {unknown} raw - candidate document.
 * @returns {object} normalized v4 document.
 */
export function normalizeState(raw) {
  const source = isObject(raw) ? raw : {}
  if (source.version === LEGACY_VERSION) return normalizeState(migrateV3(source))
  if (source.version !== STATE_VERSION) return defaultState()

  const rawSettings = isObject(source.settings) ? source.settings : {}
  const settings = {
    enabled: rawSettings.enabled !== false,
    mcpGate: rawSettings.mcpGate !== false,
    injectSummary: rawSettings.injectSummary !== false,
    gateDefaultSkills: rawSettings.gateDefaultSkills === true,
  }

  const sources = {}
  if (isObject(source.sources)) {
    for (const value of Object.values(source.sources)) {
      const normalized = normalizeSource(value)
      if (normalized === null) continue
      sources[normalized.id] = normalized
    }
  }

  return {
    version: STATE_VERSION,
    settings,
    skills: normalizeMembers(source.skills, 'skill'),
    mcp: normalizeMembers(source.mcp, 'mcp'),
    sources,
    groups: normalizeGroups(source.groups),
  }
}

/**
 * Merge a settings patch over a normalized document.
 * Unknown keys (including the retired `enforcePool`) are ignored.
 *
 * @param {object} state - normalized document.
 * @param {unknown} patch - partial settings object.
 * @returns {object} normalized document.
 */
export function applySettingsPatch(state, patch) {
  const provided = isObject(patch) ? patch : {}
  const merged = { ...state.settings }
  for (const key of SETTING_KEYS) {
    if (typeof provided[key] === 'boolean') merged[key] = provided[key]
  }
  return normalizeState({ ...state, settings: merged })
}

/**
 * Add or update one pool member. Passing a null scope removes it, so the same
 * helper serves both edits and deletions.
 *
 * @param {object} state - normalized document.
 * @param {'skill'|'mcp'} kind - member namespace.
 * @param {unknown} name - resource name.
 * @param {unknown} scope - `{enabled,modes,workspaces}`, or null to remove from the pool.
 * @param {unknown} [extra] - provenance (`sourceId`, `digest`, `installedAt`); omitted values keep the stored ones.
 * @returns {object} normalized document.
 */
export function upsertItem(state, kind, name, scope, extra) {
  if (!KINDS.includes(kind)) return state
  const key = cleanName(name)
  if (key.length === 0) return state
  const bucket = kind === 'skill' ? 'skills' : 'mcp'
  const currentBucket = isObject(state[bucket]) ? state[bucket] : {}
  const next = { ...currentBucket }
  if (scope === null || scope === undefined) {
    delete next[key]
  } else {
    const normalized = normalizeScope(scope)
    if (normalized === null) return state
    next[key] = { ...normalized, ...itemExtras(kind, extra, currentBucket[key]) }
  }
  return normalizeState({ ...state, [bucket]: next })
}

/**
 * Remove one pool member (membership only; callers remove files/loader rows).
 * @param {object} state - normalized document.
 * @param {'skill'|'mcp'} kind - member namespace.
 * @param {unknown} name - resource name.
 * @returns {object} normalized document.
 */
export function removeItem(state, kind, name) {
  if (!KINDS.includes(kind)) return state
  const key = cleanName(name)
  if (key.length === 0) return state
  const bucket = kind === 'skill' ? 'skills' : 'mcp'
  const currentBucket = isObject(state[bucket]) ? state[bucket] : {}
  if (!Object.hasOwn(currentBucket, key)) return state
  const next = { ...currentBucket }
  delete next[key]
  return normalizeState({ ...state, [bucket]: next })
}

/** Upsert one skill source. */
export function upsertSource(state, source) {
  const normalized = normalizeSource(source)
  if (normalized === null) return state
  return normalizeState({ ...state, sources: { ...state.sources, [normalized.id]: normalized } })
}

/**
 * Remove one skill source, and its group when it was the repository's last
 * source: an empty repository has no members left to scope.
 *
 * @param {object} state - normalized document.
 * @param {unknown} id - source id.
 * @returns {object} normalized document.
 */
export function removeSource(state, id) {
  const key = cleanName(id)
  if (key.length === 0) return state
  const removed = isObject(state.sources) ? state.sources[key] : undefined
  const next = { ...state.sources }
  delete next[key]
  const groups = isObject(state.groups) ? { ...state.groups } : {}
  const groupKey = groupKeyOfSource(removed)
  if (groupKey.length > 0 && !Object.values(next).some((source) => groupKeyOfSource(source) === groupKey)) {
    delete groups[groupKey]
  }
  return normalizeState({ ...state, sources: next, groups })
}

/**
 * Record that one skill was deleted by the user: drop it from every source that
 * installed it and remember it as excluded, so a later update skips it.
 *
 * @param {object} state - normalized document.
 * @param {unknown} name - skill name.
 * @returns {object} normalized document.
 */
export function excludeSourceSkill(state, name) {
  const key = cleanName(name)
  if (key.length === 0) return state
  let next = state
  for (const source of Object.values(isObject(state.sources) ? state.sources : {})) {
    if (!Array.isArray(source.skills) || !source.skills.includes(key)) continue
    next = upsertSource(next, {
      ...source,
      skills: source.skills.filter((skill) => skill !== key),
      excluded: [...(Array.isArray(source.excluded) ? source.excluded : []), key],
    })
  }
  return next
}

/**
 * Names one source may install again: its excluded list removed.
 *
 * @param {Array<string>} names - candidate names.
 * @param {Array<string>} excluded - excluded names.
 * @returns {Array<string>} names that are not excluded.
 */
export function withoutExcluded(names, excluded) {
  const blocked = new Set(Array.isArray(excluded) ? excluded : [])
  return (Array.isArray(names) ? names : []).filter((name) => !blocked.has(name))
}

/**
 * Durable JSON document with atomic, serialized writes.
 */
export class StateStore {
  constructor({ file, logger, version = '0.3.0' } = {}) {
    this.file = typeof file === 'string' && file.length > 0 ? file : statePath()
    this.logger = logger
    this.version = version
    this.cached = undefined
    this.writeChain = Promise.resolve()
  }

  /** Read the document, caching the normalized result. */
  async read({ fresh = false } = {}) {
    if (!fresh && this.cached !== undefined) return this.cached
    let raw = null
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.('[skill-pool] state unreadable; starting from defaults')
      raw = null
    }
    this.cached = normalizeState(raw)
    return this.cached
  }

  /**
   * Queue one operation behind every write/update already scheduled.
   *
   * A rejection settles only the operation's own promise: the queue itself is
   * reset to a fulfilled promise, so one failed save never wedges later ones.
   *
   * @param {() => Promise<object>} task - operation to run once its turn comes.
   * @returns {Promise<object>} the operation's result.
   */
  #enqueue(task) {
    const run = this.writeChain.then(task)
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Persist one normalized document atomically, then update the cache.
   *
   * Only the queue may call this: `write`/`update` enqueue, so calling them from
   * inside a queued task would wait on itself and deadlock.
   *
   * @param {object} normalized - normalized document.
   * @returns {Promise<object>} the persisted document.
   */
  async #persist(normalized) {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`
    // 0600: an MCP member may carry an `Authorization` header, so the pool
    // document holds the same secrets a profile patch would.
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.file)
    this.cached = normalized
    return normalized
  }

  /** Persist a normalized document, queued behind earlier writes/updates. */
  async write(state) {
    const normalized = normalizeState(state)
    return this.#enqueue(() => this.#persist(normalized))
  }

  /**
   * Apply one mutation to a fresh read and persist the result as one queued
   * read-modify-write.
   *
   * The fresh read happens inside the queue, after every earlier write/update
   * has settled. Two concurrent updates therefore see each other's result
   * instead of overwriting it, and direct `write` calls keep their call order.
   * The body uses `#persist` directly (not `write`) to avoid enqueueing behind
   * itself, which would deadlock the queue.
   *
   * @param {(state: object) => object|Promise<object>} mutate - pure mutation.
   * @returns {Promise<object>} the persisted document.
   */
  async update(mutate) {
    return this.#enqueue(async () => {
      const current = await this.read({ fresh: true })
      const next = await mutate(current)
      return this.#persist(normalizeState(next))
    })
  }
}
