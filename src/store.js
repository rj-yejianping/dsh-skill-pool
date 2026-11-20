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
 *   what a Host restart re-mounts the `mcp-client` row from — see remount.js —
 *   plus its panel `description`, its `disclosure` mode (`full` injects every
 *   tool; `progressive` hides them behind a discover tool) and the per-tool
 *   `tools` configuration (`enabled`/`modes`/`workspaces`).
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

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import { groupKeyOfSource } from './rules.js'

/** Current document version. */
export const STATE_VERSION = 4

/**
 * Absolute state-file paths this Node process has observed.
 *
 * A new `StateStore` (for example after an in-process plugin reload) must not
 * forget that a file existed and mistake its disappearance for a first run.
 * This is an in-memory set: it creates no file, survives module reloads in the
 * same process through `globalThis`, and intentionally cannot survive a Host
 * restart (a deleted file and a genuine first run are then indistinguishable).
 */
const OBSERVED_STATE_FILES_KEY = Symbol.for('dsh-skill-pool.observed-state-files')
const observedStateFiles =
  globalThis[OBSERVED_STATE_FILES_KEY] instanceof Set
    ? globalThis[OBSERVED_STATE_FILES_KEY]
    : (globalThis[OBSERVED_STATE_FILES_KEY] = new Set())

/** Group keys that would mutate the normalized map's prototype. */
const FORBIDDEN_GROUP_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

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
export const SETTING_KEYS = ['enabled', 'mcpGate', 'gateDefaultSkills']

/**
 * How one MCP member injects its tools into an Agent: `full` keeps the historic
 * behaviour (every tool is registered up front), `progressive` hides them behind
 * the member's discover tool until the Agent expands the service.
 */
export const DISCLOSURE_MODES = ['full', 'progressive']

/** Maximum stored length of one MCP service description. */
const DESCRIPTION_LIMIT = 500

/** Maximum length of one public MCP tool name (a per-tool config key). */
const MCP_TOOL_KEY_LIMIT = 128

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

/**
 * Normalize one free-text MCP service description.
 *
 * The description is display text for the panel and for a discover tool, never
 * a credential or a path: it may hold any character except control characters,
 * is trimmed, and is capped at {@link DESCRIPTION_LIMIT} characters. A
 * non-string is discarded instead of being coerced (`String(object)` would store
 * `[object Object]`).
 *
 * @param {unknown} raw - candidate description.
 * @returns {string} plain, trimmed description, or '' when unusable.
 */
export function cleanDescription(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DESCRIPTION_LIMIT)
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
  return { enabled: true, mcpGate: true, gateDefaultSkills: false }
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
 * Normalize the per-tool configuration of one MCP member.
 *
 * A key is the public tool name (`mcp__<server>__<raw>`): only keys that could
 * name an MCP tool are kept, and each value is the same `{enabled, modes,
 * workspaces}` scope a member uses, so one predicate serves both. An unusable
 * entry is dropped rather than guessed at.
 *
 * @param {unknown} raw - candidate `tools` map.
 * @returns {Record<string, {enabled: boolean, modes: string[], workspaces: string[]}>} cleaned map.
 */
export function normalizeMcpTools(raw) {
  if (!isObject(raw)) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.startsWith('mcp__') || key.length > MCP_TOOL_KEY_LIMIT) continue
    const scope = normalizeScope(value)
    if (scope === null) continue
    out[key] = scope
  }
  return out
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
    // Description, disclosure and per-tool switches are user configuration, not
    // provenance: carry them across a scope-only write exactly like `definition`.
    const description =
      typeof provided.description === 'string'
        ? cleanDescription(provided.description)
        : cleanDescription(previous.description)
    if (description.length > 0) out.description = description
    out.disclosure = DISCLOSURE_MODES.includes(provided.disclosure)
      ? provided.disclosure
      : DISCLOSURE_MODES.includes(previous.disclosure)
        ? previous.disclosure
        : 'full'
    const providedTools = normalizeMcpTools(provided.tools)
    const tools = isObject(provided.tools) ? providedTools : normalizeMcpTools(previous.tools)
    if (isObject(provided.tools) || isObject(previous.tools)) out.tools = tools
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
    const definition = cleanMcpDefinition(raw.definition)
    if (definition !== undefined) member.definition = definition
    const description = cleanDescription(raw.description)
    if (description.length > 0) member.description = description
    // Complete injection is the default: only an explicit, supported mode turns
    // progressive disclosure on. An unknown stored value never wins.
    member.disclosure = DISCLOSURE_MODES.includes(raw.disclosure) ? raw.disclosure : 'full'
    // A present `tools` map is kept even when empty: clearing the last per-tool
    // entry must leave the default empty map, not a member whose `tools` field
    // disappeared (the panel and POST /mcp/tool read it directly).
    if (isObject(raw.tools)) member.tools = normalizeMcpTools(raw.tools)
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

/** Top-level sections every complete v4 document must carry as plain objects. */
const STATE_SECTIONS = ['settings', 'skills', 'mcp', 'sources', 'groups']

/**
 * A state document that cannot be used safely.
 *
 * The code is intentionally stable for the HTTP/status surfaces; the message is
 * a fixed explanation and never contains file bytes, member definitions or
 * credentials. Callers either keep their previous gate (an already-live Agent)
 * or fail closed (a new Agent).
 */
export class StateReadError extends Error {
  /**
   * @param {string} code - stable error code such as `resource-pool/state-invalid-json`.
   * @param {string} message - safe explanation, never document content.
   */
  constructor(code, message) {
    // Keep diagnostics fixed, single-line and bounded: map keys and version
    // values come from the file and may contain secrets or newlines.
    super(String(message).replace(/[\r\n]+/g, ' ').slice(0, 240))
    this.name = 'StateReadError'
    this.code = code
    this.status = 500
  }
}

/** Throw the one "this document cannot be trusted" error. */
function invalidDocument(detail) {
  throw new StateReadError(
    'resource-pool/state-invalid-document',
    `state file is not a valid resource-pool document (${detail}); refusing to overwrite or use it`,
  )
}

/** Require a plain object. */
function requireObject(value, what) {
  if (!isObject(value)) invalidDocument(`${what} must be an object`)
}

/** Require a boolean when the property is present. */
function optionalBoolean(value, what) {
  if (value !== undefined && typeof value !== 'boolean') invalidDocument(`${what} must be a boolean`)
}

/** Require a string when the property is present. */
function optionalStringField(value, what, limit = 4096) {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length > limit) invalidDocument(`${what} must be a string of at most ${limit} characters`)
}

/** Require an array of conservative names. */
function requireNameList(value, what) {
  if (!Array.isArray(value)) invalidDocument(`${what} must be an array of names`)
  for (const item of value) {
    if (typeof item !== 'string' || cleanName(item) !== item) invalidDocument(`${what} contains an invalid name`)
  }
}

/** Require an array of absolute workspace paths. */
function requirePathList(value, what) {
  if (!Array.isArray(value)) invalidDocument(`${what} must be an array of workspace paths`)
  for (const item of value) {
    if (typeof item !== 'string' || normalizePath(item).length === 0) invalidDocument(`${what} contains an invalid workspace path`)
  }
}

/** Validate the settings switches. v3 allowed some switches to be absent. */
function validateSettings(raw, { requireAll }) {
  requireObject(raw, 'settings')
  for (const key of SETTING_KEYS) {
    if (requireAll && !Object.hasOwn(raw, key)) invalidDocument(`settings.${key} is missing`)
    optionalBoolean(raw[key], `settings.${key}`)
  }
  if (typeof raw.enabled !== 'boolean') invalidDocument('settings.enabled must be a boolean')
}

/** Validate the optional inheritance markers of a v4 skill member. */
function validateInheritance(raw, what) {
  for (const key of ['modesFrom', 'workspacesFrom']) {
    if (raw[key] !== undefined && raw[key] !== 'group' && raw[key] !== 'self') {
      invalidDocument(`${what}.${key} must be 'group' or 'self'`)
    }
  }
}

/** Validate one stored MCP connection definition without echoing it. */
function validateDefinition(raw, what) {
  requireObject(raw, what)
  if (raw.transport !== undefined && !MCP_TRANSPORTS.includes(raw.transport)) invalidDocument(`${what}.transport is unsupported`)
  for (const key of ['serverName', 'url', 'command', 'cwd']) optionalStringField(raw[key], `${what}.${key}`, 4096)
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== 'string')) {
      invalidDocument(`${what}.args must be an array of strings`)
    }
  }
  for (const key of ['headers', 'env']) {
    if (raw[key] === undefined) continue
    requireObject(raw[key], `${what}.${key}`)
    for (const [name, value] of Object.entries(raw[key])) {
      if (typeof name !== 'string' || name.length === 0 || name.length > 256 || typeof value !== 'string') {
        invalidDocument(`${what}.${key} contains an invalid entry`)
      }
    }
  }
}

/**
 * Validate one optional MCP service description.
 *
 * A readable document is the output of `normalizeState`, which already stripped
 * control characters; finding one here (or an over-long value) means the file
 * was edited by hand and cannot be trusted for display or discover prompts.
 *
 * @param {unknown} raw - stored description.
 * @param {string} what - field label for the error.
 */
function validateDescription(raw, what) {
  if (raw === undefined) return
  if (typeof raw !== 'string' || raw.length > DESCRIPTION_LIMIT || /[\u0000-\u001f\u007f]/.test(raw)) {
    invalidDocument(`${what} must be plain text of at most ${DESCRIPTION_LIMIT} characters`)
  }
}

/** Validate the per-tool configuration map of one MCP member. */
function validateMcpTools(raw, what) {
  requireObject(raw, what)
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.startsWith('mcp__') || key.length > MCP_TOOL_KEY_LIMIT) {
      invalidDocument(`${what} contains an invalid tool key`)
    }
    requireObject(value, `${what} entry`)
    if (typeof value.enabled !== 'boolean') invalidDocument(`${what} entry.enabled must be a boolean`)
    requireNameList(value.modes, `${what} entry.modes`)
    requirePathList(value.workspaces, `${what} entry.workspaces`)
  }
}

/** Validate one pool member (`skills` / `mcp`). */
function validateMember(raw, what, { version, kind, sources }) {
  requireObject(raw, what)
  if (typeof raw.enabled !== 'boolean') invalidDocument(`${what}.enabled must be a boolean`)
  requireNameList(raw.modes, `${what}.modes`)
  requirePathList(raw.workspaces, `${what}.workspaces`)
  optionalStringField(raw.installedAt, `${what}.installedAt`, 64)
  if (version === STATE_VERSION) validateInheritance(raw, what)
  if (kind === 'skill') {
    optionalStringField(raw.sourceId, `${what}.sourceId`, 128)
    optionalStringField(raw.digest, `${what}.digest`, 128)
    if (
      version === STATE_VERSION &&
      typeof raw.sourceId === 'string' &&
      raw.sourceId.length > 0 &&
      isObject(sources) &&
      !Object.hasOwn(sources, raw.sourceId) &&
      (raw.modesFrom !== 'self' || raw.workspacesFrom !== 'self')
    ) {
      invalidDocument(`${what}.sourceId references a missing source while its scope inherits; refusing to resolve the inheritance`)
    }
  }
  if (kind === 'mcp') {
    if (raw.definition !== undefined) validateDefinition(raw.definition, `${what}.definition`)
    validateDescription(raw.description, `${what}.description`)
    if (raw.disclosure !== undefined && !DISCLOSURE_MODES.includes(raw.disclosure)) {
      invalidDocument(`${what}.disclosure must be 'full' or 'progressive'`)
    }
    if (raw.tools !== undefined) validateMcpTools(raw.tools, `${what}.tools`)
  }
}

/** Validate one member map. */
function validateMembers(raw, what, options) {
  requireObject(raw, what)
  for (const [key, value] of Object.entries(raw)) {
    if (cleanName(key) !== key) invalidDocument(`${what} contains an invalid member key`)
    validateMember(value, `${what} member`, options)
  }
}

/** Validate the optional `lastCheck` record of a Git source. */
function validateLastCheck(raw, what) {
  requireObject(raw, what)
  if (!CHECK_STATUSES.includes(raw.status)) invalidDocument(`${what}.status is unsupported`)
  for (const key of ['at', 'remote', 'error']) optionalStringField(raw[key], `${what}.${key}`, 1024)
}

/** Validate one source record. */
function validateSource(raw, key, what) {
  requireObject(raw, what)
  if (typeof raw.id !== 'string' || cleanName(raw.id) !== raw.id || raw.id !== key) {
    invalidDocument(`${what}.id must be a valid name matching its map key`)
  }
  if (!SOURCE_KINDS.includes(raw.kind)) invalidDocument(`${what}.kind is unsupported`)
  optionalStringField(raw.label, `${what}.label`, 160)
  if (raw.skills !== undefined) requireNameList(raw.skills, `${what}.skills`)
  if (raw.excluded !== undefined) requireNameList(raw.excluded, `${what}.excluded`)
  optionalStringField(raw.digest, `${what}.digest`, 128)
  optionalStringField(raw.createdAt, `${what}.createdAt`, 64)
  if (raw.kind !== 'git') return
  if (deriveGit(raw) === null) invalidDocument(`${what} does not name a usable Git repository`)
  if (raw.provider !== undefined && !GIT_PROVIDERS.includes(raw.provider)) invalidDocument(`${what}.provider is unsupported`)
  for (const sub of ['url', 'project', 'branch', 'subdir', 'sha', 'tokenCredential']) {
    optionalStringField(raw[sub], `${what}.${sub}`, 2048)
  }
  if (raw.lastCheck !== undefined) validateLastCheck(raw.lastCheck, `${what}.lastCheck`)
}

/** Validate the `sources` map. */
function validateSources(raw) {
  requireObject(raw, 'sources')
  for (const [key, value] of Object.entries(raw)) validateSource(value, key, 'sources entry')
}

/** Validate one group record (`repo:<project>` / `import:<sourceId>`). */
function validateGroup(raw, key, what) {
  requireObject(raw, what)
  if (raw.key !== undefined && raw.key !== key) invalidDocument(`${what}.key must match its map key`)
  if (raw.kind !== undefined && !GROUP_KINDS.includes(raw.kind)) invalidDocument(`${what}.kind is unsupported`)
  if (typeof raw.enabled !== 'boolean') invalidDocument(`${what}.enabled must be a boolean`)
  requireNameList(raw.modes, `${what}.modes`)
  requirePathList(raw.workspaces, `${what}.workspaces`)
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    FORBIDDEN_GROUP_KEYS.has(key) ||
    key in Object.prototype
  ) {
    invalidDocument(`${what} has an invalid group key`)
  }
  const repoKey = key.startsWith('repo:')
  const importKey = key.startsWith('import:')
  if (repoKey && key.length <= 'repo:'.length) invalidDocument(`${what} has an invalid group key`)
  if (importKey && key.length <= 'import:'.length) invalidDocument(`${what} has an invalid group key`)
  if (raw.kind !== undefined && repoKey && raw.kind !== 'repo') invalidDocument(`${what}.kind does not match its key`)
  if (raw.kind !== undefined && importKey && raw.kind !== 'import') invalidDocument(`${what}.kind does not match its key`)
}

/** Validate the `groups` map. */
function validateGroups(raw) {
  requireObject(raw, 'groups')
  for (const [key, value] of Object.entries(raw)) validateGroup(value, key, 'groups entry')
}

/**
 * Validate a stored document before it is trusted for gating.
 *
 * `normalizeState` is deliberately lenient for pure migration/write helpers;
 * reading a file is different: silently repairing a damaged document can widen
 * what an Agent may reach. This function accepts exactly the complete v4 shape
 * (and the v3 shape the explicit migration understands) and rejects anything it
 * would otherwise have to invent, drop, or reinterpret.
 *
 * @param {unknown} raw - parsed JSON document.
 * @returns {object} normalized v4 document.
 * @throws {StateReadError} when the document is invalid or unsupported.
 */
export function normalizeReadableState(raw) {
  if (!isObject(raw)) {
    throw new StateReadError('resource-pool/state-not-object', 'state file is not a JSON object; refusing to overwrite or use it')
  }
  if (raw.version === LEGACY_VERSION) {
    validateSettings(raw.settings, { requireAll: false })
    if (raw.groups !== undefined) {
      if (!isObject(raw.groups)) invalidDocument('v3 document has a non-object "groups" section')
      if (Object.keys(raw.groups).length > 0) {
        invalidDocument('v3 document contains v4-only groups; refusing to migrate away their scope')
      }
    }
    for (const section of ['skills', 'mcp']) {
      if (!isObject(raw[section])) continue
      for (const member of Object.values(raw[section])) {
        if (!isObject(member)) continue
        if (member.modesFrom !== undefined || member.workspacesFrom !== undefined) {
          invalidDocument('v3 document contains v4-only inheritance markers; refusing to reinterpret its scope')
        }
      }
    }
    validateSources(raw.sources)
    validateMembers(raw.skills, 'skills', { version: LEGACY_VERSION, kind: 'skill', sources: raw.sources })
    validateMembers(raw.mcp, 'mcp', { version: LEGACY_VERSION, kind: 'mcp', sources: raw.sources })
    return normalizeState(migrateV3(raw))
  }
  if (raw.version !== STATE_VERSION) {
    throw new StateReadError(
      'resource-pool/state-unsupported-version',
      'state file uses an unsupported version; refusing to overwrite or use it',
    )
  }
  for (const section of STATE_SECTIONS) {
    if (!isObject(raw[section])) invalidDocument(`missing or invalid "${section}" section`)
  }
  validateSettings(raw.settings, { requireAll: true })
  validateSources(raw.sources)
  validateGroups(raw.groups)
  validateMembers(raw.skills, 'skills', { version: STATE_VERSION, kind: 'skill', sources: raw.sources })
  validateMembers(raw.mcp, 'mcp', { version: STATE_VERSION, kind: 'mcp', sources: raw.sources })
  return normalizeState(raw)
}

/**
 * Validate the document an update mutator returned.
 *
 * `normalizeState` treats anything that is not a complete v4 document as an
 * empty default, so persisting an accidental `undefined` result (a mutation
 * that forgot to return, or an async mutator that resolved to nothing) — or a
 * fragment such as `{version: 4}` — would silently erase every stored member
 * and credential. Refuse anything incomplete before it can reach the file.
 *
 * @param {unknown} next - mutation result.
 * @returns {object} the same document when it is acceptable.
 * @throws {TypeError} when the result is not a complete v4 document.
 */
function assertStateDocument(next) {
  if (!isObject(next) || next.version !== STATE_VERSION) {
    throw new TypeError('StateStore.update(mutate) must return a complete v4 state document')
  }
  for (const section of STATE_SECTIONS) {
    if (!isObject(next[section])) {
      throw new TypeError(
        `StateStore.update(mutate) must return a complete v4 state document: "${section}" must be an object`,
      )
    }
  }
  return next
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

/**
 * Locate one stored MCP member by server name.
 *
 * @param {object} state - normalized document.
 * @param {unknown} server - resource name.
 * @returns {{key: string, bucket: object, member: object}|null} located member, or null.
 */
function findMcpMember(state, server) {
  const key = cleanName(server)
  if (key.length === 0) return null
  const bucket = isObject(state) && isObject(state.mcp) ? state.mcp : {}
  const member = Object.hasOwn(bucket, key) ? bucket[key] : undefined
  if (!isObject(member)) return null
  return { key, bucket, member }
}

/**
 * Save the panel description and/or disclosure mode of one MCP member.
 *
 * Only those two fields are patched: the connection `definition`, the member
 * scope and `installedAt` are preserved, so saving a description can never
 * disconnect a server or widen what an Agent may reach. An unknown server is
 * returned untouched.
 *
 * @param {object} state - normalized document.
 * @param {unknown} server - existing MCP member name.
 * @param {unknown} patch - `{description?, disclosure?}`.
 * @returns {object} normalized document.
 */
export function setMcpConfig(state, server, patch) {
  const found = findMcpMember(state, server)
  if (found === null) return state
  const provided = isObject(patch) ? patch : {}
  const member = { ...found.member }
  if (typeof provided.description === 'string') {
    const description = cleanDescription(provided.description)
    if (description.length > 0) member.description = description
    else delete member.description
  }
  if (DISCLOSURE_MODES.includes(provided.disclosure)) member.disclosure = provided.disclosure
  return normalizeState({ ...state, mcp: { ...found.bucket, [found.key]: member } })
}

/**
 * Save one tool's `enabled`/`modes`/`workspaces` over the stored configuration.
 *
 * The patch only names the fields it changes; omitted fields keep their stored
 * value (a new entry starts enabled and unrestricted). Empty `modes`/
 * `workspaces` mean "no restriction". The public name is stored verbatim so a
 * temporarily disconnected tool keeps its settings until it is registered again.
 *
 * @param {object} state - normalized document.
 * @param {unknown} server - existing MCP member name.
 * @param {unknown} tool - public tool name (`mcp__<server>__<raw>`).
 * @param {unknown} patch - `{enabled?, modes?, workspaces?}`.
 * @returns {object} normalized document (unchanged when the server is unknown or the key is unusable).
 */
export function setMcpToolConfig(state, server, tool, patch) {
  const found = findMcpMember(state, server)
  if (found === null) return state
  const toolName = typeof tool === 'string' ? tool.trim() : ''
  if (!toolName.startsWith('mcp__') || toolName.length > MCP_TOOL_KEY_LIMIT) return state
  const tools = normalizeMcpTools(found.member.tools)
  const base = Object.hasOwn(tools, toolName) ? tools[toolName] : { enabled: true, modes: [], workspaces: [] }
  const provided = isObject(patch) ? patch : {}
  const merged = {
    enabled: typeof provided.enabled === 'boolean' ? provided.enabled : base.enabled,
    modes: Array.isArray(provided.modes) ? provided.modes : base.modes,
    workspaces: Array.isArray(provided.workspaces) ? provided.workspaces : base.workspaces,
  }
  const nextTools = normalizeMcpTools({ ...tools, [toolName]: merged })
  return normalizeState({ ...state, mcp: { ...found.bucket, [found.key]: { ...found.member, tools: nextTools } } })
}

/**
 * Forget one tool's configuration, restoring the default (enabled, unrestricted).
 *
 * @param {object} state - normalized document.
 * @param {unknown} server - existing MCP member name.
 * @param {unknown} tool - public tool name.
 * @returns {object} normalized document (unchanged when the server or entry is unknown).
 */
export function clearMcpToolConfig(state, server, tool) {
  const found = findMcpMember(state, server)
  if (found === null) return state
  const toolName = typeof tool === 'string' ? tool.trim() : ''
  if (toolName.length === 0) return state
  const tools = normalizeMcpTools(found.member.tools)
  if (!Object.hasOwn(tools, toolName)) return state
  delete tools[toolName]
  return normalizeState({ ...state, mcp: { ...found.bucket, [found.key]: { ...found.member, tools } } })
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
    this.key = resolvePath(this.file)
    this.logger = logger
    this.version = version
    this.cached = undefined
    this.writeChain = Promise.resolve()
    // Marks the async context of a task currently running on `writeChain`, so a
    // nested write/update can be rejected instead of waiting on itself forever.
    this.taskContext = new AsyncLocalStorage()
    // Whether this Store instance has ever successfully read or written the
    // document. A later ENOENT is then a failure, not a fresh first run. A new
    // process cannot distinguish a deleted file from a genuine first run; that
    // boundary is documented in README/CONTRACTS.
    this.everLoaded = false
    // Whether the path was ever observed to exist (even if its bytes failed to
    // parse). Deleting it afterwards is still abnormal.
    this.everObserved = false
  }

  /**
   * Decode and validate one state text.
   *
   * @param {string} text - raw file contents.
   * @returns {object} normalized v4 document.
   * @throws {StateReadError} when the bytes are not a readable state document.
   */
  #decode(text) {
    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      throw new StateReadError('resource-pool/state-invalid-json', 'state file is not valid JSON; refusing to overwrite or use it')
    }
    const state = normalizeReadableState(raw)
    this.everLoaded = true
    return state
  }

  /**
   * Read the document, caching the normalized result.
   *
   * A missing file is a valid first run only until this Store has seen the
   * document. Every other failure throws a {@link StateReadError}; returning
   * defaults here would silently widen the pool (an empty pool does not gate).
   *
   * @param {{fresh?: boolean}} [options] - force a disk read.
   * @returns {Promise<object>} normalized v4 document.
   * @throws {StateReadError} when the file is missing after a successful read,
   *   unreadable, corrupt, unsupported or semantically invalid.
   */
  async read({ fresh = false } = {}) {
    if (!fresh && this.cached !== undefined) return this.cached
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.everObserved = true
        observedStateFiles.add(this.key)
        throw new StateReadError('resource-pool/state-unreadable', 'state file could not be read; refusing to overwrite or use it')
      }
      if (this.everLoaded || this.everObserved || observedStateFiles.has(this.key)) {
        throw new StateReadError(
          'resource-pool/state-missing',
          'state file disappeared after it was known to exist; refusing to treat it as a first run',
        )
      }
      this.cached = defaultState()
      return this.cached
    }
    this.everObserved = true
    observedStateFiles.add(this.key)
    this.cached = this.#decode(text)
    return this.cached
  }

  /**
   * Queue one operation behind every write/update already scheduled.
   *
   * A rejection settles only the operation's own promise: the queue itself is
   * reset to a fulfilled promise, so one failed save never wedges later ones.
   *
   * A call made from inside a queued task's async context (typically `await
   * store.write(...)` inside an `update` mutator) is rejected immediately: it
   * would queue behind the very task awaiting it and deadlock the store.
   * AsyncLocalStorage distinguishes those descendants from independent callers
   * that merely arrive while the queue is busy — a process-wide "busy" flag
   * would wrongly reject those external calls too.
   *
   * @param {() => Promise<object>} task - operation to run once its turn comes.
   * @returns {Promise<object>} the operation's result.
   */
  #enqueue(task) {
    if (this.taskContext.getStore() === true) {
      return Promise.reject(
        new Error(
          'StateStore.write/update cannot be called from inside an update mutator: it would wait on the same queue',
        ),
      )
    }
    const run = this.writeChain.then(() => this.taskContext.run(true, task))
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Read the document for a queued read-modify-write, failing instead of
   * guessing.
   *
   * An update is about to overwrite the file, so it uses the same fail-closed
   * validation as `read()`: a JSON parse error, unsupported version, semantic
   * invalidity or I/O error must abort the save instead of replacing
   * credential-bearing state with defaults. Only a missing file (ENOENT)
   * legitimately starts from defaults, and only before this store has observed
   * the document.
   *
   * @returns {Promise<object>} normalized on-disk document.
   */
  async #readStrict() {
    let text
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (this.everLoaded || this.everObserved || observedStateFiles.has(this.key)) {
          throw new StateReadError(
            'resource-pool/state-missing',
            'state file disappeared after it was known to exist; refusing to overwrite it',
          )
        }
        this.cached = defaultState()
        return this.cached
      }
      this.everObserved = true
      observedStateFiles.add(this.key)
      throw new StateReadError('resource-pool/state-unreadable', 'state file could not be read; refusing to overwrite it')
    }
    this.everObserved = true
    observedStateFiles.add(this.key)
    this.cached = this.#decode(text)
    return this.cached
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
    this.everLoaded = true
    this.everObserved = true
    observedStateFiles.add(this.key)
    return normalized
  }

  /** Persist a complete, readable document, queued behind earlier writes/updates. */
  async write(state) {
    // Validate before queueing: a direct write must not be able to replace a
    // credential-bearing document with a fragment or a semantically broken one.
    const normalized = normalizeReadableState(state)
    return this.#enqueue(() => this.#persist(normalized))
  }

  /**
   * Apply one mutation to a fresh read and persist the result as one queued
   * read-modify-write.
   *
   * The strict fresh read happens inside the queue, after every earlier
   * write/update has settled. Two concurrent updates therefore see each other's
   * result instead of overwriting it, and direct `write` calls keep their call
   * order. `mutate` may be async, but must resolve to a complete v4 document;
   * an invalid result is rejected before anything is written. A nested
   * `store.write`/`store.update` inside `mutate` is rejected instead of
   * enqueueing behind itself, which would deadlock the queue.
   *
   * @param {(state: object) => object|Promise<object>} mutate - pure mutation.
   * @returns {Promise<object>} the persisted document.
   */
  async update(mutate) {
    return this.#enqueue(async () => {
      const current = await this.#readStrict()
      const next = assertStateDocument(await mutate(current))
      // Validate the mutation's result with the same fail-closed rules as a
      // disk read: never persist a document we would refuse to read back.
      return this.#persist(normalizeReadableState(next))
    })
  }
}
