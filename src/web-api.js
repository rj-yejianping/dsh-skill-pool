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
  cleanDescription,
  clearMcpToolConfig,
  DESCRIPTION_LIMIT,
  DISCLOSURE_MODES,
  excludeSourceSkill,
  MCP_TOOL_KEY_LIMIT,
  newId,
  normalizeItemName,
  normalizePath,
  removeItem,
  removeSource,
  setMcpConfig,
  setMcpToolConfig,
  StateReadError,
  upsertGroup,
  upsertItem,
  upsertSource,
} from './store.js'
import { buildInventory } from './inventory.js'
import {
  effectiveEnabled,
  effectiveScope,
  groupKeyOfSource,
  groupOfMember,
  isAmbiguousMcpToolName,
  mcpServerOf,
  resolvePool,
} from './rules.js'
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

/** Maximum characters of one tool description copied into a panel summary. */
const SUMMARY_LIMIT = 200

/** Character budget for the tool list of one description-generation request. */
const DESCRIBE_TOOL_BUDGET = 8 * 1024

/** Output cap for a generated description (1–2 sentences). */
const DESCRIBE_MAX_TOKENS = 200

/** Default deadline for one description-generation request. */
const DESCRIBE_TIMEOUT_MS = 30_000

/**
 * System prompts for description generation, selected by the panel language.
 * Both ask for the same shape: 1–2 sentences about which tasks the service
 * suits and when a model should call it, with no surrounding commentary.
 */
const DESCRIBE_SYSTEM = {
  zh: '你是 MCP 服务的用途说明撰写助手。根据给出的工具清单，用中文输出 1–2 句话，说明这个服务适合什么任务、什么时候应该调用它。只输出描述本身；不要标题、编号、引号或任何解释。',
  en: 'You write short MCP server summaries. From the given tool list, write 1–2 sentences in English describing which tasks the service suits and when to call it. Output only the description: no heading, numbering, quotes, or explanation.',
}

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
 * Condense one registered tool description into a panel summary.
 * @param {unknown} description - registered tool description.
 * @returns {string} single-line summary of at most {@link SUMMARY_LIMIT} characters.
 */
function summaryOf(description) {
  if (typeof description !== 'string') return ''
  return description.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LIMIT)
}

/**
 * Build the two prompt halves for one description-generation request.
 *
 * Pure, so the budget and the language switch are testable without a model.
 * The user half carries only the server's public name plus each tool's public
 * name and description summary: the stored connection definition (URL, command,
 * headers, environment, credentials) is deliberately absent, so nothing secret
 * can be sent to the model by accident. At most {@link DESCRIBE_TOOL_BUDGET}
 * characters of tool lines are kept; tools that do not fit are dropped whole.
 *
 * @param {{server?: string, tools?: Array<{name?: string, description?: string}>, language?: string}} input - prompt input.
 * @returns {{system: string, user: string}} system prompt and user content.
 */
export function buildDescribePrompt({ server, tools, language } = {}) {
  const lang = language === 'en' ? 'en' : 'zh'
  const name = typeof server === 'string' ? server : ''
  const header = lang === 'en' ? `Server: ${name}\nTools:\n` : `服务：${name}\n工具清单：\n`
  const lines = []
  let used = header.length
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!isObject(tool) || typeof tool.name !== 'string' || tool.name.length === 0) continue
    const description = summaryOf(tool.description)
    const line = description.length > 0 ? `- ${tool.name}: ${description}\n` : `- ${tool.name}\n`
    if (used + line.length > DESCRIBE_TOOL_BUDGET) break
    lines.push(line)
    used += line.length
  }
  return { system: DESCRIBE_SYSTEM[lang], user: header + lines.join('') }
}

/**
 * Project one stored per-tool configuration, copying its string lists.
 * @param {unknown} raw - stored tool config.
 * @returns {{enabled: boolean, modes: string[], workspaces: string[]}} browser-safe config.
 */
function publicToolConfig(raw) {
  const source = isObject(raw) ? raw : {}
  return {
    enabled: source.enabled !== false,
    modes: Array.isArray(source.modes) ? [...source.modes] : [],
    workspaces: Array.isArray(source.workspaces) ? [...source.workspaces] : [],
  }
}

/**
 * Project one member's per-tool configuration map (deep copy).
 * @param {unknown} raw - stored `tools` map.
 * @returns {Record<string, {enabled: boolean, modes: string[], workspaces: string[]}>} browser-safe map.
 */
function publicMcpTools(raw) {
  const source = isObject(raw) ? raw : {}
  const out = {}
  for (const [name, config] of Object.entries(source)) out[name] = publicToolConfig(config)
  return out
}

/**
 * Project one MCP member onto the fields the Settings page may see.
 *
 * `definition` carries URLs, commands, headers and environment variables —
 * including `Authorization` tokens — and never belongs in a browser response.
 * An explicit allow-list (display configuration, activation scope and per-tool
 * switches) also keeps any future connection field from leaking by accident.
 *
 * @param {unknown} member - stored MCP member.
 * @returns {object} browser-safe member.
 */
export function publicMcpMember(member) {
  const source = isObject(member) ? member : {}
  const out = {
    enabled: source.enabled !== false,
    modes: Array.isArray(source.modes) ? [...source.modes] : [],
    workspaces: Array.isArray(source.workspaces) ? [...source.workspaces] : [],
    description: typeof source.description === 'string' ? source.description : '',
    disclosure: DISCLOSURE_MODES.includes(source.disclosure) ? source.disclosure : 'full',
    tools: publicMcpTools(source.tools),
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
 * @param {number} [options.describeTimeoutMs] - override the description-generation deadline (tests).
 */
export function registerWebApi({ ctx, store, meta, onChanged, logger, mountProbe, mounts = createMountTracker(), describeTimeoutMs } = {}) {
  const debug = logger?.debug ?? (() => {})
  // "ready" means the server's tools are actually registered, not merely that a
  // Loader row exists: an unreachable server creates the row and never connects.
  const probeTimeoutMs = Number.isFinite(mountProbe?.timeoutMs) ? mountProbe.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const probeIntervalMs = Number.isFinite(mountProbe?.intervalMs) ? mountProbe.intervalMs : DEFAULT_PROBE_INTERVAL_MS
  // The panel button gets a bounded deadline; tests shrink it to prove the abort.
  const describeTimeout = Number.isFinite(describeTimeoutMs) && describeTimeoutMs > 0 ? describeTimeoutMs : DESCRIBE_TIMEOUT_MS

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

  /** Read the global tool schemas, or `null` when the service is unavailable. */
  const toolSchemas = () => {
    const tools = ctx.get('tools')
    if (tools === undefined || tools === null || typeof tools.schemas !== 'function') return null
    try {
      const schemas = tools.schemas()
      return Array.isArray(schemas) ? schemas : null
    } catch {
      return null
    }
  }

  /** Report one unknown MCP member as a 404 instead of silently saving nothing. */
  const unknownServer = (server) =>
    Object.assign(new Error(`服务 ${server} 不存在`), { code: 'resource-pool/unknown-server', status: 404 })

  /**
   * Translate a route-thrown error into the panel's failure response: the
   * explicit code/status win, everything else is an unclassified save failure.
   */
  const saveFailure = (error, fallbackCode = 'resource-pool/save-failed') => {
    const code = typeof error?.code === 'string' ? error.code : fallbackCode
    const status = error?.status === 404 ? 404 : error?.status === 400 ? 400 : 500
    return failure(code, error instanceof Error ? error.message : String(error), status)
  }

  /**
   * POST /dsh-skill-pool/mcp/config — save the panel description and/or the
   * disclosure mode of one member.
   *
   * Only those two fields are touched: the connection definition, the member
   * scope and `installedAt` survive the serialized read-modify-write. Invalid
   * input is rejected here rather than sanitized, because the store's lenient
   * normalizer would otherwise drop a bad value and silently keep the old one.
   */
  const mcpConfigRoute = async (request) => {
    const body = await readBody(request)
    const server = textOf(body.server)
    if (server.length === 0) return failure('resource-pool/bad-server', '缺少 server')
    const patch = {}
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') {
        return failure('resource-pool/bad-description', 'description 必须是字符串')
      }
      if (body.description.length > DESCRIPTION_LIMIT || /[\u0000-\u001f\u007f]/.test(body.description)) {
        return failure(
          'resource-pool/bad-description',
          `description 必须是 ${DESCRIPTION_LIMIT} 字符以内的纯文本`,
        )
      }
      patch.description = cleanDescription(body.description)
    }
    if (body.disclosure !== undefined) {
      if (!DISCLOSURE_MODES.includes(body.disclosure)) {
        return failure('resource-pool/bad-disclosure', "disclosure 必须是 'full' 或 'progressive'")
      }
      patch.disclosure = body.disclosure
    }
    try {
      const state = await store.update((current) => {
        if (!isObject(current.mcp?.[server])) throw unknownServer(server)
        return setMcpConfig(current, server, patch)
      })
      return committed(state)
    } catch (error) {
      return saveFailure(error)
    }
  }

  /**
   * POST /dsh-skill-pool/mcp/tool — save or clear one tool's configuration.
   *
   * A new key must be a public name that can be attributed to exactly one
   * service (`mcp__<server>__*`, unambiguous). A key that is already stored is
   * accepted even while its tool is unregistered: a temporarily missing tool
   * must keep its settings so they apply again when it comes back.
   */
  const mcpToolRoute = async (request) => {
    const body = await readBody(request)
    const server = textOf(body.server)
    if (server.length === 0) return failure('resource-pool/bad-server', '缺少 server')
    const tool = textOf(body.tool)
    if (tool.length === 0) return failure('resource-pool/bad-tool', '缺少 tool')
    if (tool.length > MCP_TOOL_KEY_LIMIT) {
      return failure('resource-pool/bad-tool', `tool 长度不能超过 ${MCP_TOOL_KEY_LIMIT}`)
    }
    const clear = body.clear === true
    const patch = {}
    if (!clear) {
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') return failure('resource-pool/bad-scope', 'enabled 必须是布尔值')
        patch.enabled = body.enabled
      }
      try {
        if (body.modes !== undefined) patch.modes = strictModes(body.modes, 'modes')
        if (body.workspaces !== undefined) patch.workspaces = strictWorkspaces(body.workspaces, 'workspaces')
      } catch (error) {
        return failure('resource-pool/bad-scope', error instanceof Error ? error.message : String(error))
      }
    }
    try {
      const state = await store.update((current) => {
        const member = isObject(current.mcp?.[server]) ? current.mcp[server] : undefined
        if (member === undefined) throw unknownServer(server)
        if (clear) return clearMcpToolConfig(current, server, tool)
        const tools = isObject(member.tools) ? member.tools : {}
        const known = Object.hasOwn(tools, tool)
        if (!known && !(mcpServerOf(tool) === server && !isAmbiguousMcpToolName(tool))) {
          throw Object.assign(new Error(`工具 ${tool} 无法唯一归属到服务 ${server}`), {
            code: 'resource-pool/bad-tool',
            status: 400,
          })
        }
        return setMcpToolConfig(current, server, tool, patch)
      })
      return committed(state)
    } catch (error) {
      return saveFailure(error)
    }
  }

  /**
   * GET /dsh-skill-pool/mcp/tools?server= — the registered tools of one service
   * plus the configuration preserved for tools that are currently absent.
   *
   * Only public names and description summaries are returned; the connection
   * definition never appears here.
   */
  const mcpToolsRoute = async (request) => {
    const server = textOf(new URL(request.url).searchParams.get('server'))
    if (server.length === 0) return failure('resource-pool/bad-server', '缺少 server')
    const state = await readState()
    const member = isObject(state.mcp?.[server]) ? state.mcp[server] : undefined
    if (member === undefined) return failure('resource-pool/unknown-server', `服务 ${server} 不存在`, 404)
    const schemas = toolSchemas()
    if (schemas === null) return failure('resource-pool/tools-unavailable', '无法读取 MCP 工具列表', 500)

    // Register order wins: the first schema seen for a name is the one shown.
    const registered = new Map()
    for (const schema of schemas) {
      if (!isObject(schema) || typeof schema.name !== 'string') continue
      if (mcpServerOf(schema.name) !== server) continue
      if (!registered.has(schema.name)) registered.set(schema.name, schema.description)
    }
    const configs = publicMcpTools(member.tools)
    const names = new Set(registered.keys())
    for (const name of Object.keys(configs)) {
      // History is only listed for tools that belong (or belonged) to this
      // service; a foreign key is never shown as this service's tool.
      if (mcpServerOf(name) === server) names.add(name)
    }

    const tools = [...names].sort().map((name) => ({
      name,
      summary: registered.has(name) ? summaryOf(registered.get(name)) : '',
      registered: registered.has(name),
      config: Object.hasOwn(configs, name) ? configs[name] : null,
      ambiguous: isAmbiguousMcpToolName(name),
    }))
    return json({
      ok: true,
      server,
      description: typeof member.description === 'string' ? member.description : '',
      disclosure: DISCLOSURE_MODES.includes(member.disclosure) ? member.disclosure : 'full',
      tools,
    })
  }

  /**
   * Failure answer for the describe route: a stable machine code plus a short
   * panel-facing message.
   *
   * This route is the one panel call whose failure the UI renders directly, so
   * it answers `{ok:false, error, message}` with `error` as the code string (the
   * spec's shape) instead of the nested `{code, message}` other routes use.
   * Provider and state details never reach the browser or the log.
   */
  const describeFailure = (code, message, status) => json({ ok: false, error: code, message }, status)

  /**
   * POST /dsh-skill-pool/mcp/describe — draft a purpose description for one
   * MCP server with the default model.
   *
   * Only the service's current public tool names and description summaries are
   * sent to the model (ambiguous and foreign names are dropped). The stored
   * connection definition — URL, command, headers, environment, credentials —
   * is never part of the request. The generated text is returned to the panel
   * as a draft and is deliberately not saved: the user confirms through
   * `/mcp/config`.
   */
  const mcpDescribeRoute = async (request) => {
    const body = await readBody(request)
    const server = textOf(body.server)
    if (server.length === 0) return describeFailure('bad-server', '缺少 server', 400)

    let state
    try {
      state = await readState()
    } catch (error) {
      // Fail closed: an untrusted document yields no generation attempt at all.
      if (error instanceof StateReadError) return describeFailure(error.code, '状态不可读，无法生成描述', 500)
      throw error
    }
    if (!isObject(state.mcp?.[server])) return describeFailure('unknown-server', `服务 ${server} 不存在`, 404)

    const schemas = toolSchemas()
    if (schemas === null) return describeFailure('tools-unavailable', '无法读取 MCP 工具列表', 500)
    const tools = []
    for (const schema of schemas) {
      if (!isObject(schema) || typeof schema.name !== 'string') continue
      if (mcpServerOf(schema.name) !== server) continue
      // A name that cannot be attributed to exactly one service is not offered
      // as this service's tool, in the prompt or anywhere else.
      if (isAmbiguousMcpToolName(schema.name)) continue
      tools.push({ name: schema.name, description: schema.description })
    }
    if (tools.length === 0) return describeFailure('no-tools', '该服务当前没有可用工具', 400)

    // Both host services are optional and read without an inject requirement.
    // The default model is resolved first: without it there is nothing to call.
    const defaults = ctx.get('agentDefaultModel')
    let selection
    try {
      selection = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : undefined
    } catch {
      selection = undefined
    }
    if (!isObject(selection) || textOf(selection.provider).length === 0 || textOf(selection.model).length === 0) {
      return describeFailure('no-default-model', '没有可用的默认模型', 503)
    }
    const llm = ctx.get('llm')
    if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
      return describeFailure('no-llm', '缺少 llm 服务，无法生成描述', 503)
    }

    const prompt = buildDescribePrompt({ server, tools, language: body.language })
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, describeTimeout)
    let text = ''
    try {
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
        // One-shot user input in the host's model-facing text-block shape.
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt.user }] }],
        system: prompt.system,
        maxTokens: DESCRIBE_MAX_TOKENS,
        signal: controller.signal,
      })) {
        if (timedOut) break
        if (isObject(chunk) && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
    } catch {
      // Never log provider text or model output: either may echo the request.
      debug(`[resource-pool] describe ${server}: generation failed`)
      return timedOut
        ? describeFailure('timeout', '生成超时，请重试', 504)
        : describeFailure('generate-failed', '模型生成失败，请重试', 502)
    } finally {
      clearTimeout(timer)
    }
    if (timedOut) {
      debug(`[resource-pool] describe ${server}: timed out`)
      return describeFailure('timeout', '生成超时，请重试', 504)
    }

    // The draft must be a value the panel can save unchanged: plain text within
    // the stored description limit, never a half sentence padded with markup.
    const description = cleanDescription(text)
    if (description.length === 0) {
      debug(`[resource-pool] describe ${server}: empty output`)
      return describeFailure('generate-failed', '模型未返回可用描述', 502)
    }
    return json({ ok: true, description })
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
    ['/mcp/config', ['POST'], guarded(mcpConfigRoute)],
    ['/mcp/tool', ['POST'], guarded(mcpToolRoute)],
    ['/mcp/tools', ['GET'], guarded(mcpToolsRoute)],
    ['/mcp/describe', ['POST'], guarded(mcpDescribeRoute)],
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

  // Host-independent seams for tests; production ignores them.
  //
  // `routes` is the same array the transport registers, so a Node test can call
  // one handler directly without a web server. `testHooks` keeps the previous
  // scope-preservation seam working; existing callers ignore the whole object.
  return { routes, testHooks: { captureEffectiveScopes, installItems } }
}
