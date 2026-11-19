/**
 * Browser-facing API for the resource-pool settings page (§6).
 *
 * The routes live on their own `webServer` prefix (`/dsh-skill-pool`) and
 * admit every request through `connection.admit`, which inherits the
 * deployment's trusted-origin checks and browser credential. The prefix effect
 * is owned by the plugin context (not the inject-derived scope): a service
 * restart re-runs an inject callback and would otherwise dispose the route.
 *
 * v3 has no "resource library -> pool" step: importing a skill or an MCP server
 * writes its pool membership in the same request. Every write is atomic
 * (state file first), then re-applies the document to live Agents, then returns
 * the new document. MCP imports return before the mount because an unreachable
 * server can block for a long time; readiness is observed as `mcp__<server>__*`
 * tools appearing within the probe window.
 *
 * @module dsh-skill-pool/web-api
 */

import {
  applySettingsPatch,
  excludeSourceSkill,
  newId,
  normalizeItemName,
  normalizePath,
  removeItem,
  removeSource,
  StateReadError,
  upsertGroup,
  upsertItem,
  upsertSource,
} from './store.js'
import { buildInventory } from './inventory.js'
import { effectiveEnabled, effectiveScope, groupKeyOfSource, groupOfMember, resolvePool } from './rules.js'
import { DEFAULT_PROBE_INTERVAL_MS, DEFAULT_PROBE_TIMEOUT_MS, mountServer } from './mount.js'
import {
  buildMcpConfig,
  createMountTracker,
  normalizeMcpImport,
  removeMcpServer,
} from './uploads.js'
import {
  checkGitSource,
  installFromFiles,
  installFromGit,
  installFromZip,
  librarySkillsRoot,
  removeSkillDir,
  removeSourceSkills,
  updateGitSource,
} from './library.js'

/** Route prefix below the origin root. */
export const ROUTE_PREFIX = '/dsh-skill-pool'

/** Credential-name prefix for Git tokens (only the name is stored in `state`). */
const GIT_TOKEN_PREFIX = 'RESOURCE_POOL_GIT_'

/** Body cap for panel writes. */
// 64MB archive cap in base64 plus JSON overhead; see library.MAX_ARCHIVE_BYTES.
const MAX_BODY_BYTES = 96 * 1024 * 1024

/** JSON response helper. */
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

/** Failure response helper. */
function failure(code, message, status = 400) {
  return json({ ok: false, error: { code, message } }, status)
}

/**
 * Map one route failure, preserving the explicit state-read code when the
 * document could not be trusted. A corrupt file must not be reported as a
 * generic import/update failure: the panel's error should tell the user to
 * repair the state file.
 */
function stateFailure(error, fallbackCode, fallbackStatus = 500) {
  if (error instanceof StateReadError) return failure(error.code, error.message, 500)
  return failure(fallbackCode, error instanceof Error ? error.message : String(error), fallbackStatus)
}

/** Whether a value is a plain object (not an array, not null). */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Trim one optional string, returning '' when absent. */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Parse a JSON body without throwing on empty or malformed input. */
async function readBody(request) {
  try {
    const value = await request.json()
    return isObject(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Project one MCP member onto the fields the Settings page may see.
 *
 * `definition` carries URLs, commands, headers and environment variables —
 * including `Authorization` tokens — and never belongs in a browser response.
 * An explicit allow-list (activation scope only) also keeps any future
 * connection field from leaking by accident.
 *
 * @param {unknown} member - stored MCP member.
 * @returns {object} browser-safe member.
 */
function publicMcpMember(member) {
  const source = isObject(member) ? member : {}
  const out = {
    enabled: source.enabled !== false,
    modes: Array.isArray(source.modes) ? [...source.modes] : [],
    workspaces: Array.isArray(source.workspaces) ? [...source.workspaces] : [],
  }
  if (typeof source.installedAt === 'string' && source.installedAt.length > 0) out.installedAt = source.installedAt
  return out
}

/**
 * Project a state document for the browser, dropping every MCP connection
 * definition while keeping scopes and the other sections intact.
 *
 * Every response that carries `state` — the overview and every mutation — goes
 * through this one function, so a new route cannot accidentally expose
 * credentials just by returning the document it just persisted.
 *
 * @param {unknown} state - normalized document.
 * @returns {object} browser-safe document.
 */
export function publicState(state) {
  const source = isObject(state) ? state : {}
  const mcp = {}
  const members = isObject(source.mcp) ? source.mcp : {}
  for (const [name, member] of Object.entries(members)) mcp[name] = publicMcpMember(member)
  return { ...source, mcp }
}

/**
 * Register the panel's HTTP routes.
 *
 * @param {object} options - registration options.
 * @param {object} options.ctx - plugin context.
 * @param {object} options.store - state store.
 * @param {object} options.meta - static metadata returned to the panel.
 * @param {() => Promise<void>} [options.onChanged] - called after a committed mutation.
 * @param {{ debug?: Function, warn?: Function, info?: Function }} [options.logger] - logger.
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options.mountProbe] - MCP readiness window.
 * @param {object} [options.mounts] - shared mount tracker (boot re-mounts land here too).
 */
export function registerWebApi({ ctx, store, meta, onChanged, logger, mountProbe, mounts = createMountTracker() } = {}) {
  const debug = logger?.debug ?? (() => {})
  // "ready" means the server's tools are actually registered, not merely that a
  // Loader row exists: an unreachable server creates the row and never connects.
  const probeTimeoutMs = Number.isFinite(mountProbe?.timeoutMs) ? mountProbe.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const probeIntervalMs = Number.isFinite(mountProbe?.intervalMs) ? mountProbe.intervalMs : DEFAULT_PROBE_INTERVAL_MS

  // Always read the file for the panel: a cached document would hide an
  // external edit (including corruption) until the process restarted.
  const readState = () => store.read({ fresh: true })
  const skillsRoot = () => librarySkillsRoot()

  /** Committed mutation response: file is already on disk, re-apply, then answer. */
  const committed = async (state, extra = {}) => {
    let warning
    try {
      const result = await onChanged?.()
      const count = (key) => (Number.isFinite(result?.[key]) ? result[key] : 0)
      const failed = count('failed')
      const under = count('under')
      const over = count('over')
      const conservative = count('conservative')
      const noVisible = count('noVisible')
      const retainedOldGate = count('retainedOldGate')
      const fallbackFailed = count('fallbackFailed')
      if (failed > 0 || under + over + conservative + noVisible + retainedOldGate + fallbackFailed > 0) {
        // Classify from structured counts; never parse untrusted warning text.
        const parts = []
        if (under > 0) parts.push(`${under} 个会话未完整应用 MCP 限制，部分工具可能仍可调用，直到下一次重放`)
        if (conservative > 0) parts.push(`${conservative} 个会话使用保守 MCP deny（已对可见工具生效）`)
        if (over > 0) parts.push(`${over} 个会话保留了暂不可见工具的旧限制，可能暂时过度限制`)
        if (noVisible > 0) parts.push(`${noVisible} 个会话当前无可见 MCP 工具，未安装新的拒绝层`)
        if (retainedOldGate > 0) parts.push(`${retainedOldGate} 个会话激活失败，保留旧限制`)
        if (fallbackFailed > 0) parts.push(`${fallbackFailed} 个会话的保守拒绝层安装失败`)
        if (parts.length === 0) parts.push('部分活动会话未能重新应用')
        warning = {
          code: under > 0
            ? 'resource-pool/activation-incomplete'
            : conservative > 0
              ? 'resource-pool/activation-conservative'
              : 'resource-pool/activation-degraded',
          message: `状态已保存；${parts.join('；')}。`,
          ...(failed > 0 ? { failed } : {}),
          ...(under > 0 ? { under } : {}),
          ...(over > 0 ? { over, degraded: over } : {}),
          ...(conservative > 0 ? { conservative } : {}),
          ...(noVisible > 0 ? { noVisible } : {}),
          ...(retainedOldGate > 0 ? { retainedOldGate } : {}),
          ...(fallbackFailed > 0 ? { fallbackFailed } : {}),
        }
      }
    } catch (error) {
      logger?.warn?.(`[resource-pool] re-application failed: ${error instanceof Error ? error.message : String(error)}`)
      warning = {
        code: 'resource-pool/activation-failed',
        message: '状态已保存，但重新应用结果未知；活动会话可能保留旧限制。',
      }
    }
    return json({ ok: true, state: publicState(state), ...extra, ...(warning === undefined ? {} : { warning }) })
  }

  /** Resolve one stored Git token from the credential store. */
  const gitToken = async (credentialName) => {
    if (typeof credentialName !== 'string' || credentialName.length === 0) return ''
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.resolve !== 'function') return ''
    try {
      const resolved = await credentials.resolve(credentialName)
      return typeof resolved?.value === 'string' ? resolved.value : ''
    } catch {
      return ''
    }
  }

  /** Store one provided token under a source-scoped credential name. */
  const storeGitToken = async (sourceId, token) => {
    if (typeof token !== 'string' || token.trim().length === 0) return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined || typeof credentials.set !== 'function') return undefined
    const name = `${GIT_TOKEN_PREFIX}${sourceId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`
    try {
      await credentials.set(name, token.trim())
      return name
    } catch (error) {
      logger?.warn?.(`[resource-pool] token not stored: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  // ------------------------------------------------------------- validation

  /**
   * Validate a mode list at the API boundary.
   *
   * The store's lenient normalizer drops unusable entries, which would turn
   * `[123]` into `[]` ("all modes") and silently widen access. Reject instead;
   * an absent field still means "leave unchanged", and `[]` is a real "all".
   */
  const strictModes = (value, field) => {
    if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`)
    const modes = []
    for (const item of value) {
      if (typeof item !== 'string' || item.length === 0 || normalizeItemName(item) !== item) {
        throw new Error(`${field} 包含非法的模式名`)
      }
      modes.push(item)
    }
    return modes
  }

  /** Validate absolute workspace paths at the API boundary. */
  const strictWorkspaces = (value, field) => {
    if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`)
    const workspaces = []
    for (const item of value) {
      const path = typeof item === 'string' ? normalizePath(item) : ''
      if (path.length === 0) throw new Error(`${field} 包含非法的工作区路径`)
      workspaces.push(path)
    }
    return workspaces
  }

  /** Whether two string lists contain the same values (order/duplicates ignored). */
  const sameStringList = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right)) return false
    const a = [...new Set(left)].sort()
    const b = [...new Set(right)].sort()
    return a.length === b.length && a.every((value, index) => value === b[index])
  }

  /**
   * Refuse scope edits whose inheritance marker would silently discard them.
   *
   * The panel always switches the edited dimension to `self`, but API callers
   * may send only `modes`/`workspaces`. When the member inherits a resolvable
   * group, that edit would be ignored; when there is no resolvable group, the
   * marker is ambiguous and can become wider if a group appears later. Existing
   * unchanged legacy markers (enabled-only panel saves) still pass.
   */
  const assertScopePatch = (state, existing, patch) => {
    const group = groupOfMember(state, existing)
    const hasGroup = group !== undefined
    const modesChanged = patch.modes !== undefined && !sameStringList(patch.modes, existing.modes)
    const workspacesChanged =
      patch.workspaces !== undefined && !sameStringList(patch.workspaces, existing.workspaces)
    const desiredModesFrom = patch.modesFrom !== undefined
      ? patch.modesFrom
      : existing.modesFrom === 'self' ? 'self' : 'group'
    const desiredWorkspacesFrom = patch.workspacesFrom !== undefined
      ? patch.workspacesFrom
      : existing.workspacesFrom === 'self' ? 'self' : 'group'

    if (
      desiredModesFrom === 'group' &&
      ((hasGroup && modesChanged) || (!hasGroup && (modesChanged || (patch.modesFrom === 'group' && existing.modesFrom !== 'group'))))
    ) {
      throw Object.assign(
        new Error(
          hasGroup
            ? "该成员的模式条件由组继承；修改 modes 时请同时提交 modesFrom: 'self'，否则修改不会生效。"
            : "该成员没有可解析的组，不能保存 modesFrom: 'group' 与修改后的 modes；请提交 modesFrom: 'self'。",
        ),
        { code: 'resource-pool/bad-scope', status: 400 },
      )
    }
    if (
      desiredWorkspacesFrom === 'group' &&
      ((hasGroup && workspacesChanged) ||
        (!hasGroup && (workspacesChanged || (patch.workspacesFrom === 'group' && existing.workspacesFrom !== 'group'))))
    ) {
      throw Object.assign(
        new Error(
          hasGroup
            ? "该成员的工作区条件由组继承；修改 workspaces 时请同时提交 workspacesFrom: 'self'，否则修改不会生效。"
            : "该成员没有可解析的组，不能保存 workspacesFrom: 'group' 与修改后的 workspaces；请提交 workspacesFrom: 'self'。",
        ),
        { code: 'resource-pool/bad-scope', status: 400 },
      )
    }
  }

  /** Read one `scope` object (`{modes, workspaces}`); undefined when absent. */
  const readScope = (value) => {
    if (value === undefined || value === null) return undefined
    if (!isObject(value)) throw new Error('scope 必须是 {modes, workspaces} 对象')
    const scope = {}
    if (value.modes !== undefined) scope.modes = strictModes(value.modes, 'scope.modes')
    if (value.workspaces !== undefined) scope.workspaces = strictWorkspaces(value.workspaces, 'scope.workspaces')
    return scope
  }

  /** Read the `/item` patch: activation conditions only. */
  const readItemPatch = (body) => {
    const patch = {}
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
      patch.enabled = body.enabled
    }
    if (body.modes !== undefined) patch.modes = strictModes(body.modes, 'modes')
    if (body.workspaces !== undefined) patch.workspaces = strictWorkspaces(body.workspaces, 'workspaces')
    for (const key of ['modesFrom', 'workspacesFrom']) {
      if (body[key] === undefined) continue
      if (body[key] !== 'group' && body[key] !== 'self') throw new Error(`${key} 必须是 'group' 或 'self'`)
      patch[key] = body[key]
    }
    return patch
  }

  /** Merge a condition patch over the stored member (or defaults for a new one). */
  const itemScope = (state, kind, name, patch = {}) => {
    const bucket = kind === 'skill' ? state.skills : state.mcp
    const existing = isObject(bucket) ? bucket[name] : undefined
    return {
      enabled: patch.enabled !== undefined ? patch.enabled : (existing?.enabled ?? true),
      modes: patch.modes !== undefined ? patch.modes : (existing?.modes ?? []),
      workspaces: patch.workspaces !== undefined ? patch.workspaces : (existing?.workspaces ?? []),
    }
  }

  /** Capture effective scopes before a source change (see `installItems`). */
  const captureEffectiveScopes = (state, names) => {
    const out = {}
    for (const name of names) {
      const member = isObject(state.skills) ? state.skills[name] : undefined
      if (!isObject(member)) continue
      const effective = effectiveScope(state, member)
      out[name] = {
        enabled: effectiveEnabled(state, member),
        modes: [...effective.modes],
        workspaces: [...effective.workspaces],
        groupKey: groupKeyOfSource(isObject(state.sources) ? state.sources[member.sourceId] : undefined),
      }
    }
    return out
  }

  /**
   * Add freshly installed skills to the pool.
   *
   * A re-import can move a member to a different source. Its group may not
   * exist in the new source's repository, so blindly keeping `modesFrom:
   * 'group'` would turn an inherited scope into the member's empty own list
   * ("all modes/workspaces"). Any dimension that would change effective scope
   * is materialized into `self` from the pre-import effective scope; `enabled`
   * is always preserved as the effective value (a disabled group stays
   * disabled). An explicit import `scope` wins for that dimension and is
   * stored as `self`, so a group can never silently override it.
   *
   * `previous` must be captured before the new source is written; it is
   * supplied by every import/update route.
   */
  const installItems = (state, names, { scope, sourceId, digests, installedAt, previous }) => {
    let next = state
    const provided = isObject(scope) ? scope : {}
    for (const name of names) {
      const extra = { installedAt }
      if (typeof sourceId === 'string' && sourceId.length > 0) extra.sourceId = sourceId
      const digest = isObject(digests) ? digests[name] : undefined
      if (typeof digest === 'string' && digest.length > 0) extra.digest = digest
      const existing = isObject(next.skills) ? next.skills[name] : undefined
      const own = itemScope(next, 'skill', name, provided)

      if (isObject(existing)) {
        const prior = isObject(previous) && isObject(previous[name])
          ? previous[name]
          : {
              enabled: effectiveEnabled(next, existing),
              modes: [...effectiveScope(next, existing).modes],
              workspaces: [...effectiveScope(next, existing).workspaces],
              groupKey: groupKeyOfSource(isObject(next.sources) ? next.sources[existing.sourceId] : undefined),
            }
        let modesFrom = existing.modesFrom === 'self' ? 'self' : 'group'
        let workspacesFrom = existing.workspacesFrom === 'self' ? 'self' : 'group'
        if (provided.modes !== undefined) modesFrom = 'self'
        if (provided.workspaces !== undefined) workspacesFrom = 'self'

        const newGroup = groupOfMember(next, { sourceId })
        if (modesFrom === 'group' && (newGroup === undefined || !sameStringList(newGroup.modes, prior.modes))) {
          modesFrom = 'self'
          own.modes = [...prior.modes]
        }
        if (
          workspacesFrom === 'group' &&
          (newGroup === undefined || !sameStringList(newGroup.workspaces, prior.workspaces))
        ) {
          workspacesFrom = 'self'
          own.workspaces = [...prior.workspaces]
        }
        // A still-identical group keeps the member's own enabled flag, so
        // disabling and re-enabling that group restores the member. Only a
        // changed/lost group materializes the old effective enabled state.
        const newGroupKey = groupKeyOfSource(isObject(next.sources) ? next.sources[sourceId] : undefined)
        const sameGroup = prior.groupKey === newGroupKey && (newGroup !== undefined || newGroupKey.length === 0)
        own.enabled = sameGroup ? existing.enabled : prior.enabled
        extra.modesFrom = modesFrom
        extra.workspacesFrom = workspacesFrom
      } else if (provided.modes !== undefined || provided.workspaces !== undefined) {
        if (provided.modes !== undefined) extra.modesFrom = 'self'
        if (provided.workspaces !== undefined) extra.workspacesFrom = 'self'
      }

      next = upsertItem(next, 'skill', name, own, extra)
    }
    return next
  }

  /** Assert an install result has the §7 shape; a mismatch is an integration bug. */
  const installResult = (result) => {
    if (!isObject(result) || !Array.isArray(result.installed)) {
      throw new Error('library.js 返回值缺少 installed[]（请确认其实现符合契约 §7）')
    }
    return {
      installed: result.installed.filter((name) => typeof name === 'string' && name.length > 0),
      failures: Array.isArray(result.failures) ? result.failures : [],
      digests: isObject(result.digests) ? result.digests : {},
      source: isObject(result.source) ? result.source : undefined,
    }
  }

  /** Label for one import-created source record. */
  const importLabel = (kind, names, providedLabel) => {
    const label = textOf(providedLabel)
    if (label.length > 0) return label
    if (names.length === 1) return names[0]
    if (kind === 'zip') return `ZIP（${names.length} 个技能）`
    return `上传的 ${names.length} 个技能`
  }

  /** Decode panel upload files to the library's `{path, content}` shape. */
  const uploadFiles = (raw) => {
    const list = Array.isArray(raw) ? raw : []
    const out = []
    for (const file of list) {
      if (!isObject(file)) continue
      const path = typeof file.path === 'string' ? file.path : ''
      if (typeof file.contentBase64 === 'string' && file.contentBase64.length > 0) {
        const data = Buffer.from(file.contentBase64, 'base64')
        // `installFromFiles` currently filters on `content`; carry both so the
        // decoded bytes are also available to the library.
        out.push({ path, content: data.toString('utf8'), data })
        continue
      }
      if (typeof file.content === 'string') {
        out.push({ path, content: file.content, data: Buffer.from(file.content, 'utf8') })
      }
    }
    return out
  }

  /** Normalize one check outcome status (§2.1). */
  const checkStatus = (status, current, remote) => {
    if (status === 'up-to-date' || status === 'update-available' || status === 'error') return status
    if (current.length > 0 && remote.length > 0) return current === remote ? 'up-to-date' : 'update-available'
    return 'error'
  }

  /** Names other sources still list (used to avoid deleting a shared skill). */
  const sharedNames = (state, exceptId) => {
    const shared = new Set()
    for (const [id, source] of Object.entries(state.sources)) {
      if (id === exceptId) continue
      for (const name of Array.isArray(source.skills) ? source.skills : []) shared.add(name)
    }
    return shared
  }

  // ---------------------------------------------------------------- handlers

  /** GET /dsh-skill-pool */
  const overview = async () => {
    try {
      const state = await readState()
      const inventory = await buildInventory(ctx, { state, libraryRoot: skillsRoot() })
      return json({ ok: true, meta, state: publicState(state), inventory, mounts: mounts.status() })
    } catch (error) {
      if (error instanceof StateReadError) {
        logger?.warn?.(`[resource-pool] overview refused: ${error.message}`)
        return failure(error.code, error.message, 500)
      }
      logger?.warn?.(`[resource-pool] overview failed: ${error instanceof Error ? error.message : String(error)}`)
      return failure('resource-pool/read-failed', '无法读取技能池状态', 500)
    }
  }

  /** GET /dsh-skill-pool/mounts */
  const mountsRoute = async () => json({ ok: true, mounts: mounts.status() })

  /** POST /dsh-skill-pool/item — edit one member's conditions / enabled flag. */
  const itemRoute = async (request) => {
    const body = await readBody(request)
    const kind = body.kind === 'skill' ? 'skill' : body.kind === 'mcp' ? 'mcp' : ''
    if (kind === '') return failure('resource-pool/bad-kind', "kind 必须是 'skill' 或 'mcp'")
    const name = normalizeItemName(body.name)
    if (name.length === 0) return failure('resource-pool/bad-name', '缺少合法的 name')
    let patch
    try {
      patch = readItemPatch(body)
    } catch (error) {
      return failure('resource-pool/bad-scope', error instanceof Error ? error.message : String(error))
    }
    try {
      const state = await store.update((current) => {
        const existing = kind === 'skill' ? current.skills[name] : current.mcp[name]
        // `/item` only edits an existing member: a save that was queued before a
        // delete (or a focused row for a member that is already gone) must fail
        // instead of recreating the member after the removal.
        if (!isObject(existing)) {
          throw Object.assign(
            new Error(`成员 ${name} 不存在；/item 只能编辑已有成员`),
            { code: 'resource-pool/unknown-item', status: 400 },
          )
        }
        if (kind === 'skill') {
          assertScopePatch(current, existing, patch)
          // Marker-only group -> self must retain the inherited values. The
          // panel normally sends them, but an API caller may switch only the marker.
          const group = groupOfMember(current, existing)
          if (group !== undefined) {
            const effective = effectiveScope(current, existing)
            // The panel's inherit-off action sends the member's existing own
            // values with `self`. If those values did not actually change, the
            // action is marker-only: materialize the inherited scope rather
            // than turning the empty own list into "all".
            const modesUnchanged =
              patch.modes === undefined || sameStringList(patch.modes, existing.modes)
            const workspacesUnchanged =
              patch.workspaces === undefined || sameStringList(patch.workspaces, existing.workspaces)
            if (patch.modesFrom === 'self' && existing.modesFrom !== 'self' && modesUnchanged) {
              patch.modes = [...effective.modes]
            }
            if (patch.workspacesFrom === 'self' && existing.workspacesFrom !== 'self' && workspacesUnchanged) {
              patch.workspaces = [...effective.workspaces]
            }
          }
        }
        const extra = {
          sourceId: existing?.sourceId,
          digest: existing?.digest,
          installedAt: existing?.installedAt,
          modesFrom: patch.modesFrom !== undefined ? patch.modesFrom : existing?.modesFrom,
          workspacesFrom: patch.workspacesFrom !== undefined ? patch.workspacesFrom : existing?.workspacesFrom,
        }
        return upsertItem(current, kind, name, itemScope(current, kind, name, patch), extra)
      })
      return committed(state)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'resource-pool/save-failed'
      return failure(code, error instanceof Error ? error.message : String(error), error?.status === 400 ? 400 : 500)
    }
  }

  /**
   * POST /dsh-skill-pool/item/remove — remove one pool member.
   * Skills lose their library directory; MCP servers lose their Loader row.
   */
  const itemRemoveRoute = async (request) => {
    const body = await readBody(request)
    const kind = body.kind === 'skill' ? 'skill' : body.kind === 'mcp' ? 'mcp' : ''
    if (kind === '') return failure('resource-pool/bad-kind', "kind 必须是 'skill' 或 'mcp'")
    const name = normalizeItemName(body.name)
    if (name.length === 0) return failure('resource-pool/bad-name', '缺少合法的 name')
    // Refuse before deleting skill files or a Loader row: a corrupt state file
    // must not turn a failed remove into partial data loss.
    await readState()

    const removed = { kind, name }
    if (kind === 'skill') {
      try {
        removed.dir = (await removeSkillDir({ root: skillsRoot(), name })) === true
      } catch (error) {
        removed.dir = false
        removed.warning = error instanceof Error ? error.message : String(error)
      }
      try {
        const state = await store.update((current) => {
          // Deleting is also an exclusion: the source remembers the name so an
          // update never installs it again.
          let next = excludeSourceSkill(removeItem(current, 'skill', name), name)
          // A source with nothing left to install has nothing to update: drop it,
          // and its group when it was the repository's last source.
          for (const source of Object.values(next.sources)) {
            if (Array.isArray(source.skills) && source.skills.length > 0) continue
            const referenced = Object.values(next.skills).some((item) => item.sourceId === source.id)
            if (!referenced) next = removeSource(next, source.id)
          }
          return next
        })
        return committed(state, { removed })
      } catch (error) {
        return stateFailure(error, 'resource-pool/save-failed', 500)
      }
    }

    // MCP: drop the Loader row; a member whose row is already gone can still be
    // removed from the pool (the panel shows the warning).
    try {
      const result = await removeMcpServer(ctx, name)
      mounts.forget(result.serverName)
      removed.mount = true
    } catch (error) {
      removed.mount = false
      removed.warning = error instanceof Error ? error.message : String(error)
    }
    try {
      const state = await store.update((current) => removeItem(current, 'mcp', name))
      return committed(state, { removed })
    } catch (error) {
      return stateFailure(error, 'resource-pool/save-failed', 500)
    }
  }

  /** POST /dsh-skill-pool/settings */
  const settingsRoute = async (request) => {
    const body = await readBody(request)
    const patch = isObject(body.patch) ? body.patch : isObject(body.settings) ? body.settings : null
    if (patch === null) return failure('resource-pool/bad-settings', '缺少 patch 对象')
    for (const key of ['enabled', 'mcpGate', 'gateDefaultSkills']) {
      if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
        return failure('resource-pool/bad-settings', `${key} 必须是布尔值`)
      }
    }
    try {
      const state = await store.update((current) => applySettingsPatch(current, patch))
      return committed(state)
    } catch (error) {
      return stateFailure(error, 'resource-pool/save-failed', 500)
    }
  }

  /** POST /dsh-skill-pool/group — set the scope of one repository/import group. */
  const groupRoute = async (request) => {
    const body = await readBody(request)
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (key.length === 0) return failure('resource-pool/bad-group', '缺少 group.key')
    // Only repo:/import: groups can ever be referenced by a source. Older API
    // versions could write other keys; they remain readable as inert legacy
    // entries, but new writes must not create more of them.
    const groupPrefix = key.startsWith('repo:') ? 'repo:' : key.startsWith('import:') ? 'import:' : ''
    if (
      groupPrefix.length === 0 ||
      key.length <= groupPrefix.length ||
      key.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(key)
    ) {
      return failure('resource-pool/bad-group', 'group.key 必须是 repo:<project> 或 import:<sourceId>')
    }
    const patch = { key }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return failure('resource-pool/bad-group', 'enabled 必须是布尔值')
      patch.enabled = body.enabled
    }
    try {
      if (body.modes !== undefined) patch.modes = strictModes(body.modes, 'modes')
      if (body.workspaces !== undefined) patch.workspaces = strictWorkspaces(body.workspaces, 'workspaces')
    } catch (error) {
      return failure('resource-pool/bad-group', error instanceof Error ? error.message : String(error))
    }
    try {
      const state = await store.update((current) => upsertGroup(current, patch))
      return committed(state)
    } catch (error) {
      return stateFailure(error, 'resource-pool/save-failed', 500)
    }
  }

  /** GET /dsh-skill-pool/resolve?mode=&cwd=&allModes=&allWorkspaces= */
  const resolveRoute = async (request) => {
    const state = await readState()
    const url = new URL(request.url)
    const cwd = url.searchParams.get('cwd') ?? ''
    const mode = url.searchParams.get('mode') ?? ''
    const allModes = url.searchParams.get('allModes') === '1'
    const allWorkspaces = url.searchParams.get('allWorkspaces') === '1'
    return json({ ok: true, pool: resolvePool(state, { mode, cwd, allModes, allWorkspaces }) })
  }

  /**
   * POST /dsh-skill-pool/mcp/import — returns immediately, mounts in background.
   * Body: `{payload, scope?}` where `payload` is the parsed `mcpServers` object
   * (a JSON string is tolerated).
   */
  const mcpImportRoute = async (request) => {
    const body = await readBody(request)
    let entries
    try {
      entries = normalizeMcpImport(body.payload !== undefined ? body.payload : body)
    } catch (error) {
      return failure('resource-pool/mcp-import-failed', error instanceof Error ? error.message : String(error), 400)
    }
    // Validate the shape up front so an unusable definition fails as a 400
    // instead of mounting and then reporting "failed".
    const configs = new Map()
    try {
      for (const [serverName, definition] of entries) configs.set(serverName, buildMcpConfig(serverName, definition))
    } catch (error) {
      return failure('resource-pool/mcp-import-failed', error instanceof Error ? error.message : String(error), 400)
    }
    let scope
    try {
      scope = readScope(body.scope)
    } catch (error) {
      return failure('resource-pool/bad-scope', error instanceof Error ? error.message : String(error))
    }

    // Membership plus its connection definition land first: the definition is
    // what a later Host start re-mounts from, so persisting it before the row
    // exists means a crash mid-mount still leaves a recoverable member.
    let state
    try {
      state = await store.update((current) => {
        let next = current
        for (const [serverName, definition] of entries) {
          next = upsertItem(
            next,
            'mcp',
            serverName,
            itemScope(next, 'mcp', serverName, scope ?? {}),
            { definition: configs.get(serverName) ?? definition },
          )
        }
        return next
      })
    } catch (error) {
      return stateFailure(error, 'resource-pool/save-failed', 500)
    }

    const servers = []
    for (const [serverName, definition] of entries) {
      servers.push({ server: serverName, state: 'mounting' })
      mountServer({
        ctx,
        serverName,
        definition: configs.get(serverName) ?? definition,
        mounts,
        timeoutMs: probeTimeoutMs,
        intervalMs: probeIntervalMs,
        logger,
        origin: 'import',
      })
    }
    return committed(state, { servers, mounts: mounts.status() })
  }

  /** POST /dsh-skill-pool/mcp/remove — `{server}`. */
  const mcpRemoveRoute = async (request) => {
    const body = await readBody(request)
    const serverName = textOf(body.server)
    if (serverName.length === 0) return failure('resource-pool/bad-server', '缺少 server')
    // Validate state before removing the Loader row.
    await readState()
    let result
    try {
      result = await removeMcpServer(ctx, serverName)
    } catch (error) {
      return failure('resource-pool/mcp-remove-failed', error instanceof Error ? error.message : String(error), 400)
    }
    mounts.forget(result.serverName)
    try {
      const state = await store.update((current) => removeItem(current, 'mcp', result.serverName))
      return committed(state)
    } catch (error) {
      return stateFailure(error, 'resource-pool/save-failed', 500)
    }
  }

  /** POST /dsh-skill-pool/skill/upload — install skill bundles from plain files. */
  const skillUploadRoute = async (request) => {
    const body = await readBody(request)
    const files = uploadFiles(body.files)
    if (files.length === 0) return failure('resource-pool/bad-files', '缺少 files（[{path, contentBase64}]）')
    // Do not install files if the membership update cannot be read back later.
    await readState()
    let scope
    try {
      scope = readScope(body.scope)
    } catch (error) {
      return failure('resource-pool/bad-scope', error instanceof Error ? error.message : String(error))
    }
    try {
      const result = installResult(await installFromFiles({
        files,
        root: skillsRoot(),
        overwrite: body.overwrite === true,
        name: textOf(body.name),
        description: textOf(body.description),
      }))
      const source = {
        id: newId('src'),
        kind: 'files',
        label: importLabel('files', result.installed, ''),
        skills: result.installed,
        createdAt: new Date().toISOString(),
      }
      const state = await store.update((current) => {
        const previous = captureEffectiveScopes(current, result.installed)
        let next = upsertSource(current, source)
        next = installItems(next, result.installed, {
          scope,
          sourceId: source.id,
          digests: result.digests,
          installedAt: new Date().toISOString(),
          previous,
        })
        return next
      })
      return committed(state, {
        source: state.sources[source.id],
        installed: result.installed,
        failures: result.failures,
      })
    } catch (error) {
      return stateFailure(error, 'resource-pool/upload-failed', 400)
    }
  }

  /** POST /dsh-skill-pool/skill/zip — install skill bundles from a ZIP archive. */
  const skillZipRoute = async (request) => {
    const body = await readBody(request)
    if (typeof body.archiveBase64 !== 'string' || body.archiveBase64.length === 0) {
      return failure('resource-pool/bad-archive', '缺少 archiveBase64')
    }
    // Validate before unpacking anything to disk.
    await readState()
    let scope
    try {
      scope = readScope(body.scope)
    } catch (error) {
      return failure('resource-pool/bad-scope', error instanceof Error ? error.message : String(error))
    }
    try {
      const result = installResult(await installFromZip({
        archiveBase64: body.archiveBase64,
        root: skillsRoot(),
        overwrite: body.overwrite === true,
        label: textOf(body.label),
      }))
      const source = {
        id: newId('src'),
        kind: 'zip',
        label: importLabel('zip', result.installed, body.label),
        skills: result.installed,
        createdAt: new Date().toISOString(),
      }
      const state = await store.update((current) => {
        const previous = captureEffectiveScopes(current, result.installed)
        let next = upsertSource(current, source)
        next = installItems(next, result.installed, {
          scope,
          sourceId: source.id,
          digests: result.digests,
          installedAt: new Date().toISOString(),
          previous,
        })
        return next
      })
      return committed(state, {
        source: state.sources[source.id],
        installed: result.installed,
        failures: result.failures,
      })
    } catch (error) {
      return stateFailure(error, 'resource-pool/zip-failed', 400)
    }
  }

  /** POST /dsh-skill-pool/source/git — install skills from GitHub/GitLab. */
  const sourceGitRoute = async (request) => {
    const body = await readBody(request)
    const url = textOf(body.url)
    if (url.length === 0) return failure('resource-pool/bad-url', '缺少仓库 URL')
    // Validate before downloading/installing anything to disk.
    await readState()
    // Empty branch/subdir lets the library fall back to what the pasted URL encodes
    // (GitLab's '/-/tree/<branch>/<subdir>'), then to 'main'.
    const branch = textOf(body.branch)
    const subdir = textOf(body.subdir)
    const token = typeof body.token === 'string' ? body.token : ''
    const provider = body.provider === 'github' || body.provider === 'gitlab' ? body.provider : 'auto'
    let scope
    try {
      scope = readScope(body.scope)
    } catch (error) {
      return failure('resource-pool/bad-scope', error instanceof Error ? error.message : String(error))
    }
    try {
      const result = installResult(await installFromGit({
        url,
        branch,
        subdir,
        token,
        provider,
        label: textOf(body.label),
        root: skillsRoot(),
        overwrite: body.overwrite === true,
      }))
      const returned = isObject(result.source) ? result.source : {}
      const source = {
        ...returned,
        id: typeof returned.id === 'string' && returned.id.length > 0 ? returned.id : newId('src'),
        kind: 'git',
        url,
        host: typeof returned.host === 'string' ? returned.host : '',
        branch: typeof returned.branch === 'string' && returned.branch.length > 0 ? returned.branch : branch || 'main',
        subdir: typeof returned.subdir === 'string' ? returned.subdir : subdir,
        skills: result.installed,
        createdAt: typeof returned.createdAt === 'string' ? returned.createdAt : new Date().toISOString(),
      }
      const tokenCredential = await storeGitToken(source.id, token)
      if (tokenCredential !== undefined) source.tokenCredential = tokenCredential
      const state = await store.update((current) => {
        const previous = captureEffectiveScopes(current, result.installed)
        let next = upsertSource(current, source)
        next = installItems(next, result.installed, {
          scope,
          sourceId: source.id,
          digests: result.digests,
          installedAt: new Date().toISOString(),
          previous,
        })
        return next
      })
      return committed(state, {
        source: state.sources[source.id],
        installed: result.installed,
        failures: result.failures,
      })
    } catch (error) {
      return stateFailure(error, 'resource-pool/git-failed', 400)
    }
  }

  /**
   * POST /dsh-skill-pool/source/check — compare each Git source's stored
   * commit with the remote one *without downloading the archive*. One failing
   * source is reported as `status: 'error'` in `results`; the route never 500s.
   */
  const sourceCheckRoute = async (request) => {
    const body = await readBody(request)
    let ids
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids)) return failure('resource-pool/bad-ids', 'ids 必须是字符串数组')
      ids = body.ids.map((id) => textOf(id)).filter((id) => id.length > 0)
    }
    const current = await readState()
    const targets = []
    if (ids !== undefined) {
      for (const id of ids) targets.push({ id, source: current.sources[id] })
    } else {
      for (const source of Object.values(current.sources)) {
        if (source.kind === 'git') targets.push({ id: source.id, source })
      }
    }

    const results = []
    const checks = {}
    const checkedAt = new Date().toISOString()
    for (const { id, source } of targets) {
      if (source === undefined) {
        results.push({ id, label: '', status: 'error', current: '', remote: '', error: `来源 ${id} 不存在` })
        continue
      }
      if (source.kind !== 'git') {
        results.push({
          id,
          label: source.label,
          status: 'error',
          current: '',
          remote: '',
          error: '只有 Git 来源可以检查更新',
        })
        continue
      }
      try {
        const token = await gitToken(source.tokenCredential)
        const raw = await checkGitSource({ source, token })
        const check = isObject(raw) ? raw : {}
        const remote = textOf(check.remote)
        const status = checkStatus(check.status, textOf(check.current), remote)
        const result = {
          id,
          label: textOf(check.label) || source.label,
          status,
          current: textOf(check.current),
          remote,
        }
        if (status === 'error') result.error = '无法确认远端提交'
        results.push(result)
        checks[id] = { at: checkedAt, status, remote, error: status === 'error' ? '无法确认远端提交' : '' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({
          id,
          label: source.label,
          status: 'error',
          current: typeof source.sha === 'string' ? source.sha : '',
          remote: '',
          error: message,
        })
        checks[id] = { at: checkedAt, status: 'error', remote: '', error: message }
      }
    }

    if (Object.keys(checks).length === 0) {
      // Nothing to record (no Git sources): the document is unchanged, so the
      // pool does not need re-applying.
      return json({ ok: true, state: publicState(current), results })
    }
    try {
      const state = await store.update((doc) => {
        let next = doc
        for (const [id, lastCheck] of Object.entries(checks)) {
          const source = next.sources[id]
          if (source === undefined) continue
          // Only the check outcome is stored: `sha` keeps naming the commit that
          // is actually installed, so update detection stays correct.
          next = upsertSource(next, { ...source, lastCheck })
        }
        return next
      })
      return committed(state, { results })
    } catch (error) {
      return stateFailure(error, 'resource-pool/check-failed', 500)
    }
  }

  /** POST /dsh-skill-pool/source/update — re-fetch one Git source. */
  const sourceUpdateRoute = async (request) => {
    const body = await readBody(request)
    const id = textOf(body.id)
    if (id.length === 0) return failure('resource-pool/bad-id', '缺少 id')
    const current = await readState()
    const source = current.sources[id]
    if (source === undefined) return failure('resource-pool/unknown-source', `来源 ${id} 不存在`, 404)
    if (source.kind !== 'git') return failure('resource-pool/bad-kind', '只有 Git 来源可以更新', 400)
    try {
      const token = await gitToken(source.tokenCredential)
      // `restore` clears the exclusion list and forces a reinstall; `force` alone
      // reinstall the current commit without clearing anything.
      const restore = body.restore === true
      const force = body.force === true || restore
      const updated = await updateGitSource({
        source: restore ? { ...source, excluded: [] } : source,
        token,
        root: skillsRoot(),
        exclude: restore ? [] : source.excluded,
        force,
      })
      const result = installResult(updated)
      const changed = updated?.changed === true
      const removed = Array.isArray(updated?.removed)
        ? updated.removed.filter((name) => typeof name === 'string' && name.length > 0)
        : []
      const returned = isObject(updated?.source) ? updated.source : {}
      const nextSource = {
        ...source,
        ...returned,
        id,
        kind: 'git',
        skills: Array.isArray(returned.skills) ? returned.skills : source.skills,
        excluded: restore
          ? []
          : Array.isArray(returned.excluded)
            ? returned.excluded
            : Array.isArray(source.excluded)
              ? source.excluded
              : [],
        lastCheck: {
          at: new Date().toISOString(),
          status: 'up-to-date',
          remote: typeof returned.sha === 'string' ? returned.sha : '',
          error: '',
        },
      }
      const state = await store.update((doc) => {
        const previous = captureEffectiveScopes(doc, result.installed)
        let next = upsertSource(doc, nextSource)
        next = installItems(next, result.installed, {
          scope: undefined,
          sourceId: id,
          digests: result.digests,
          installedAt: new Date().toISOString(),
          previous,
        })
        // Skills that disappeared upstream are gone from disk already.
        const shared = sharedNames(next, id)
        for (const name of removed) {
          if (shared.has(name)) continue
          next = removeItem(next, 'skill', name)
        }
        // An update that leaves the source with nothing installed turns it into
        // a dead tree row: drop it (and its group) like a delete would.
        const after = next.sources[id]
        if (after !== undefined && (!Array.isArray(after.skills) || after.skills.length === 0)) {
          const referenced = Object.values(next.skills).some((item) => item.sourceId === id)
          if (!referenced) next = removeSource(next, id)
        }
        return next
      })
      return committed(state, {
        source: state.sources[id],
        installed: result.installed,
        failures: result.failures,
        changed,
      })
    } catch (error) {
      return stateFailure(error, 'resource-pool/update-failed', 400)
    }
  }

  /** POST /dsh-skill-pool/source/delete — remove a source and its skills. */
  const sourceDeleteRoute = async (request) => {
    const body = await readBody(request)
    const id = textOf(body.id)
    if (id.length === 0) return failure('resource-pool/bad-id', '缺少 id')
    const current = await readState()
    const source = current.sources[id]
    if (source === undefined) return failure('resource-pool/unknown-source', `来源 ${id} 不存在`, 404)
    try {
      // A skill may be claimed by more than one source (same name from a ZIP and
      // a repo); only delete the ones no other source still lists.
      const shared = sharedNames(current, id)
      const skipSkills = (Array.isArray(source.skills) ? source.skills : []).filter((name) => shared.has(name))
      const result = await removeSourceSkills({ source, root: skillsRoot(), skipSkills })
      const removed = Array.isArray(result?.removed) ? result.removed : []
      const skipped = Array.isArray(result?.skipped) ? result.skipped : skipSkills
      const state = await store.update((doc) => {
        // Shared skills stay installed, but they may currently inherit their
        // group scope. Materialize the *effective* scope/enabled before the
        // source (and possibly its group) disappears, otherwise a group-owned
        // empty scope would become an unrestricted self scope.
        let next = doc
        const removedSet = new Set(removed)
        for (const [name, member] of Object.entries(next.skills)) {
          if (member.sourceId !== id) continue
          if (removedSet.has(name)) continue
          const scope = effectiveScope(next, member)
          next = upsertItem(next, 'skill', name, {
            enabled: effectiveEnabled(next, member),
            modes: [...scope.modes],
            workspaces: [...scope.workspaces],
          }, { sourceId: '', modesFrom: 'self', workspacesFrom: 'self' })
        }
        next = removeSource(next, id)
        for (const name of removed) next = removeItem(next, 'skill', name)
        return next
      })
      return committed(state, { removed, skipped })
    } catch (error) {
      return stateFailure(error, 'resource-pool/delete-failed', 400)
    }
  }

  /**
   * Turn a fail-closed state read into an explicit 500 for the panel instead of
   * letting it fall through as a generic internal error. Reads never write.
   */
  const guarded = (handler) => async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      if (error instanceof StateReadError) {
        logger?.warn?.(`[resource-pool] request refused: ${error.message}`)
        return failure(error.code, error.message, 500)
      }
      throw error
    }
  }

  const routes = [
    ['', ['GET'], guarded(overview)],
    ['/item', ['POST'], guarded(itemRoute)],
    ['/item/remove', ['POST'], guarded(itemRemoveRoute)],
    ['/settings', ['POST'], guarded(settingsRoute)],
    ['/group', ['POST'], guarded(groupRoute)],
    ['/resolve', ['GET'], guarded(resolveRoute)],
    ['/skill/upload', ['POST'], guarded(skillUploadRoute)],
    ['/skill/zip', ['POST'], guarded(skillZipRoute)],
    ['/source/git', ['POST'], guarded(sourceGitRoute)],
    ['/source/check', ['POST'], guarded(sourceCheckRoute)],
    ['/source/update', ['POST'], guarded(sourceUpdateRoute)],
    ['/source/delete', ['POST'], guarded(sourceDeleteRoute)],
    ['/mcp/import', ['POST'], guarded(mcpImportRoute)],
    ['/mcp/remove', ['POST'], guarded(mcpRemoveRoute)],
    ['/mounts', ['GET'], guarded(mountsRoute)],
  ]

  // ------------------------------------------------------------- transport

  const readNodeBody = (request) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })

  const writeNodeResponse = async (response, res) => {
    const headers = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
  }

  const refuse = (res, status) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(status === 401 ? 'unauthorized' : 'forbidden')
  }

  const handleNodeRequest = async (connection, req, res) => {
    const admission = typeof connection?.admit === 'function' ? connection.admit(req) : undefined
    if (admission === undefined || admission === null) {
      refuse(res, 401)
      return
    }
    if ('rejection' in admission) {
      refuse(res, admission.rejection === 403 ? 403 : 401)
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const method = req.method ?? 'GET'
    const route = routes.find(([suffix, methods]) => `${ROUTE_PREFIX}${suffix}` === url.pathname && methods.includes(method))
    if (route === undefined) {
      await writeNodeResponse(json({ ok: false, error: { code: 'resource-pool/not-found', message: 'unknown resource-pool route' } }, 404), res)
      return
    }
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      headers[key] = Array.isArray(value) ? value.join(', ') : value
    }
    let body
    try {
      body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(req)
    } catch (error) {
      await writeNodeResponse(failure('resource-pool/too-large', error instanceof Error ? error.message : String(error), 413), res)
      return
    }
    let request
    try {
      request = new Request(url.toString(), {
        method,
        headers,
        ...(body === undefined || body.length === 0 ? {} : { body }),
      })
    } catch (error) {
      await writeNodeResponse(failure('resource-pool/bad-request', error instanceof Error ? error.message : String(error), 400), res)
      return
    }
    await writeNodeResponse(await route[2](request), res)
  }

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    const connection = webCtx.get('connection')
    if (webServer === undefined || typeof webServer.register !== 'function' || typeof connection?.admit !== 'function') {
      registerFetchRoutes(webCtx, connection)
      return
    }
    // Owned by the plugin context: a webServer/connection restart re-runs this
    // inject callback and would dispose a scope-owned route.
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            handleNodeRequest(connection, req, res).catch((error) => {
              logger?.warn?.(`[resource-pool] request failed: ${error instanceof Error ? error.message : String(error)}`)
              if (res.headersSent) {
                try {
                  res.destroy()
                } catch {
                  /* already gone */
                }
                return
              }
              try {
                res.writeHead(500, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: { code: 'resource-pool/internal', message: 'request failed' } }))
              } catch {
                /* response already closed */
              }
            })
          },
        }),
      'resource-pool.http',
    )
    debug(`registered ${routes.length} resource pool routes under ${ROUTE_PREFIX} (webServer prefix)`)
  })

  /** Fallback for compositions without a webServer: exact-Fetch routes. */
  function registerFetchRoutes(targetCtx, connection) {
    const register = connection?.fetch?.register
    if (typeof register !== 'function') {
      debug('neither webServer nor connection.fetch is available; resource pool API disabled')
      return
    }
    for (const [suffix, methods, handler] of routes) {
      targetCtx.effect(
        () =>
          register({
            path: `${ROUTE_PREFIX}${suffix}`,
            methods,
            requestBody: 'buffered',
            fetch: handler,
          }),
        `resource-pool.route.${suffix.length > 0 ? suffix.slice(1).replaceAll('/', '.') : 'overview'}`,
      )
    }
    debug(`registered ${routes.length} resource pool routes under ${ROUTE_PREFIX} (exact fetch)`)
  }

  // Host-independent seam for scope-preservation tests; production ignores it.
  return { testHooks: { captureEffectiveScopes, installItems } }
}
