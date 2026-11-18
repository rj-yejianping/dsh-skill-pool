/**
 * Mount primitives shared by the panel API and boot-time re-mounting.
 *
 * One MCP mount is: create or update the managed `mcp-client` Loader row, then
 * wait until that server's public `mcp__<server>__*` tools are registered. The
 * wait is what makes "ready" mean "usable" — a row alone proves nothing, an
 * unreachable server creates a row and never connects.
 *
 * @module dsh-skill-pool/mount
 */

import { isAmbiguousMcpToolName, mcpServerOf } from './rules.js'
import { upsertMcpServer } from './uploads.js'

/** Default readiness window for one MCP mount (§6: 20s). */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000

/** Default readiness polling interval. */
export const DEFAULT_PROBE_INTERVAL_MS = 500

/**
 * Whether at least one of the server's public tools is registered right now.
 * @param {object} ctx - plugin context.
 * @param {string} serverName - pool server name.
 * @returns {boolean} true when the server exposed at least one tool.
 */
export function hasServerTools(ctx, serverName) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.schemas !== 'function') return false
  try {
    return tools.schemas().some((schema) => {
      const name = schema?.name
      if (typeof name !== 'string' || !name.startsWith('mcp__')) return false
      // A name that cannot be attributed to exactly one server must not make
      // another server look ready (e.g. `mcp__a___b` from server `a_`).
      return !isAmbiguousMcpToolName(name) && mcpServerOf(name) === serverName
    })
  } catch {
    return false
  }
}

/**
 * Mount one server in the background, tracking progress for the panel.
 *
 * The row is created/updated synchronously-ish (awaited inside the tracked
 * run); readiness is polled until the window expires. Failure is reported, not
 * thrown, so one dead server never blocks another.
 *
 * @param {object} options - mount options.
 * @param {object} options.ctx - plugin context.
 * @param {string} options.serverName - pool server name.
 * @param {object} options.definition - stored connection definition.
 * @param {{start: Function}} options.mounts - mount tracker.
 * @param {number} [options.timeoutMs] - readiness window.
 * @param {number} [options.intervalMs] - polling interval.
 * @param {{info?: Function, warn?: Function}} [options.logger] - logger.
 * @param {string} [options.origin] - `import` | `boot`, for the log line.
 * @returns {void}
 */
export function mountServer({ ctx, serverName, definition, mounts, timeoutMs, intervalMs, logger, origin = 'import' }) {
  const waitMs = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const everyMs = Number.isFinite(intervalMs) ? intervalMs : DEFAULT_PROBE_INTERVAL_MS
  mounts.start(serverName, async () => {
    await upsertMcpServer(ctx, serverName, definition)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (hasServerTools(ctx, serverName)) {
        logger?.info?.(`[skill-pool] MCP server ready (${origin}): ${serverName}`)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, everyMs))
    }
    throw new Error(
      `已创建连接，但 ${Math.round(waitMs / 1000)}s 内没有观察到该 Server 的工具：请检查 URL/命令、鉴权与服务是否可达`,
    )
  })
}
