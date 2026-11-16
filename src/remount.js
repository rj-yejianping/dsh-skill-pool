/**
 * Boot-time re-mount of persisted MCP servers.
 *
 * Membership alone is not a connection: `state.json` used to keep only
 * `{enabled, modes, workspaces}`, so every Host restart came back with members
 * that listed zero tools — the pool looked configured but had no MCP interface
 * at all, and nothing short of re-importing repaired it.
 *
 * Since the member now stores its `definition`, the pool can rebuild its own
 * `mcp-client` rows when the plugin activates. This module does exactly that,
 * after the Loader service exists, without blocking boot: each server mounts in
 * the background through the same tracker the panel polls.
 *
 * @module dsh-skill-pool/remount
 */

import { mountServer } from './mount.js'

/**
 * Re-mount every stored MCP member that carries a definition.
 *
 * A member is skipped when it is explicitly disabled, has no definition (an
 * older document, or a membership created before this version), or is already
 * ready/mounting in the tracker. Failures stay in the tracker as `failed` and
 * are logged; they never reject the caller.
 *
 * @param {object} options - remount options.
 * @param {object} options.ctx - plugin context.
 * @param {() => Promise<object>} options.getState - effective document reader.
 * @param {{start: Function, status: Function}} options.mounts - mount tracker.
 * @param {{info?: Function, warn?: Function}} [options.logger] - logger.
 * @param {{timeoutMs?: number, intervalMs?: number}} [options.mountProbe] - readiness window.
 * @returns {Promise<{mounted: string[], skipped: string[]}>} what was started.
 */
export async function remountPoolServers({ ctx, getState, mounts, logger, mountProbe } = {}) {
  const mounted = []
  const skipped = []
  let state
  try {
    state = await getState()
  } catch (error) {
    logger?.warn?.(`[skill-pool] remount skipped: ${error instanceof Error ? error.message : String(error)}`)
    return { mounted, skipped }
  }

  const members = state?.mcp !== null && typeof state?.mcp === 'object' ? state.mcp : {}
  const status = typeof mounts?.status === 'function' ? mounts.status() : {}
  for (const [serverName, member] of Object.entries(members)) {
    const definition = member?.definition
    if (definition === undefined || definition === null || typeof definition !== 'object') {
      skipped.push(serverName)
      continue
    }
    if (member.enabled === false) {
      skipped.push(serverName)
      continue
    }
    const current = status[serverName]?.state
    if (current === 'ready' || current === 'mounting') {
      skipped.push(serverName)
      continue
    }
    mounted.push(serverName)
    mountServer({
      ctx,
      serverName,
      definition,
      mounts,
      timeoutMs: mountProbe?.timeoutMs,
      intervalMs: mountProbe?.intervalMs,
      logger,
      origin: 'boot',
    })
  }

  if (mounted.length > 0) logger?.info?.(`[skill-pool] re-mounting stored MCP servers: ${mounted.join(', ')}`)
  return { mounted, skipped }
}
