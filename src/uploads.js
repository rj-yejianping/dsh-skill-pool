/**
 * MCP imports: turn a `mcpServers` JSON payload into managed Loader rows.
 *
 * In v3 an import *is* pool membership: the route adds the entry to `state.mcp`
 * and mounts the row in the same request, so there is no "resource library"
 * step in between.
 *
 * Each server becomes one `rp-<serverName>` row of
 * `@deepseek-ai/dsh-mcp-client`. The `rp-` prefix keeps these rows distinct
 * from the ones `dsh-mcp-connector` manages (`mcp-<key>`), so the two plugins
 * never fight over an entry id.
 *
 * Mounting can block for a long time when a server is unreachable, so the API
 * never awaits it: `mountAsync` records progress in memory and the panel polls.
 *
 * @module dsh-skill-pool/uploads
 */

/** Loader entry id prefix for servers imported here. */
export const MCP_ENTRY_PREFIX = 'rp'

/** Loader plugin that owns one MCP connection. */
export const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

/**
 * Loader entry id of one managed server.
 * @param {unknown} serverName - server name.
 * @returns {string} entry id such as `rp-qcc`.
 */
export function mcpEntryId(serverName) {
  const name = slugify(serverName)
  return name.length > 0 ? `${MCP_ENTRY_PREFIX}-${name}` : ''
}

/**
 * Public tool-name prefix of one managed server (`mcp__<server>__`).
 * @param {unknown} serverName - server name.
 * @returns {string} prefix used to observe the server's registered tools.
 */
export function serverToolPrefix(serverName) {
  const name = slugify(serverName)
  return name.length > 0 ? `mcp__${name}__` : ''
}

/**
 * Normalize an arbitrary label into a kebab-case server name.
 * @param {unknown} value - candidate label.
 * @returns {string} kebab-case name, or ''.
 */
export function slugify(value) {
  if (typeof value !== 'string') return ''
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * Normalize an import payload into `[serverName, definition]` pairs.
 * Accepts `{ servers }`, `{ mcpServers }`, a bare `{ <name>: {...} }` map, or
 * the same JSON as a string.
 *
 * @param {unknown} payload - request body or JSON text.
 * @returns {Array<[string, object]>} entries.
 */
export function normalizeMcpImport(payload) {
  let source = payload
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      throw new Error('JSON 解析失败')
    }
  }
  if (source === null || typeof source !== 'object' || Array.isArray(source)) throw new Error('导入内容必须是一个对象')
  const container = source.servers ?? source.mcpServers ?? source
  if (container === null || typeof container !== 'object' || Array.isArray(container)) {
    throw new Error('导入内容里没有 mcpServers 对象')
  }
  const entries = []
  for (const [rawName, definition] of Object.entries(container)) {
    const serverName = slugify(definition?.serverName ?? rawName)
    if (serverName.length === 0) throw new Error(`服务器名 "${rawName}" 无效`)
    entries.push([serverName, definition])
  }
  if (entries.length === 0) throw new Error('没有可导入的 MCP 服务器')
  return entries
}

/**
 * Build one mcp-client Loader config from an import definition.
 * @param {string} serverName - stable server name (tool prefix `mcp__<serverName>__`).
 * @param {object} definition - `{ url | command, ... }`.
 * @returns {object} mcp-client config.
 */
export function buildMcpConfig(serverName, definition) {
  const source = definition !== null && typeof definition === 'object' ? definition : {}
  if (typeof source.url === 'string' && source.url.trim().length > 0) {
    let parsed
    try {
      parsed = new URL(source.url.trim())
    } catch {
      throw new Error(`MCP "${serverName}" 的 URL 无效`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`MCP "${serverName}" 只支持 http/https URL`)
    }
    return {
      transport: 'streamable-http',
      serverName,
      url: source.url.trim(),
      ...(source.headers !== null && typeof source.headers === 'object' ? { headers: source.headers } : {}),
    }
  }
  if (typeof source.command === 'string' && source.command.trim().length > 0) {
    return {
      transport: 'stdio',
      serverName,
      command: source.command.trim(),
      args: Array.isArray(source.args) ? source.args.map((arg) => String(arg)) : [],
      ...(source.env !== null && typeof source.env === 'object' ? { env: source.env } : {}),
      ...(typeof source.cwd === 'string' && source.cwd.length > 0 ? { cwd: source.cwd } : {}),
    }
  }
  throw new Error(`MCP "${serverName}" 需要 url（HTTP）或 command（stdio）`)
}

/**
 * Create or update one managed mcp-client Loader row.
 * @param {object} ctx - plugin context.
 * @param {string} serverName - server name.
 * @param {object} definition - import definition.
 * @returns {Promise<{serverName: string, entryId: string, created: boolean}>} row outcome.
 */
export async function upsertMcpServer(ctx, serverName, definition) {
  const loader = ctx.get('loader')
  if (loader === undefined || typeof loader.create !== 'function') {
    throw new Error('当前部署没有 Loader，无法挂载 MCP 服务器')
  }
  const entryId = mcpEntryId(serverName)
  if (entryId.length === 0) throw new Error('服务器名无效')
  const config = buildMcpConfig(serverName, definition)
  let existing
  try {
    existing = loader.resolve(entryId)
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    await loader.update(entryId, { config })
    return { serverName, entryId, created: false }
  }
  await loader.create({ id: entryId, name: MCP_CLIENT_PLUGIN, config })
  return { serverName, entryId, created: true }
}

/**
 * Remove one managed mcp-client row. Rows owned by other plugins are refused.
 * @param {object} ctx - plugin context.
 * @param {string} serverName - server name.
 * @returns {Promise<{serverName: string, removed: boolean}>} removal outcome.
 */
export async function removeMcpServer(ctx, serverName) {
  const loader = ctx.get('loader')
  if (loader === undefined || typeof loader.remove !== 'function') {
    throw new Error('当前部署没有 Loader，无法移除 MCP 服务器')
  }
  const name = slugify(serverName)
  if (name.length === 0) throw new Error('服务器名无效')
  const entryId = mcpEntryId(name)
  try {
    loader.resolve(entryId)
  } catch {
    throw new Error(`MCP 服务器 ${name} 不是由技能池导入的，无法在这里移除`)
  }
  loader.remove(entryId)
  return { serverName: name, removed: true }
}

/**
 * In-memory mount tracker.
 *
 * A mount can wait seconds to minutes on an unreachable server; the API returns
 * right away and the panel polls this map, so the UI never freezes.
 *
 * @returns {{start: Function, status: Function, forget: Function}} tracker.
 */
export function createMountTracker() {
  /** @type {Map<string, {state: string, error?: string, startedAt: number}>} */
  const mounts = new Map()
  return {
    /** Start one background mount. */
    start(serverName, run) {
      mounts.set(serverName, { state: 'mounting', startedAt: Date.now() })
      void run()
        .then(() => {
          mounts.set(serverName, { state: 'ready', startedAt: mounts.get(serverName)?.startedAt ?? Date.now() })
        })
        .catch((error) => {
          mounts.set(serverName, {
            state: 'failed',
            error: error instanceof Error ? error.message : String(error),
            startedAt: mounts.get(serverName)?.startedAt ?? Date.now(),
          })
        })
    },
    /** Read the whole mount map. */
    status() {
      const out = {}
      for (const [name, entry] of mounts) {
        out[name] = { state: entry.state, ...(entry.error === undefined ? {} : { error: entry.error }) }
      }
      return out
    },
    /** Drop one record (after removal). */
    forget(serverName) {
      mounts.delete(serverName)
    },
  }
}
