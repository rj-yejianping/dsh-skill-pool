/**
 * The global MCP tool guard's decision, as one pure function.
 *
 * `ctx.tools.guard` runs for every tool execution, including calls that never
 * reach an MCP server. This module answers only one question — "should this MCP
 * call be refused, and with which stable reason?" — so the decision is testable
 * without a live Agent, and the caller (the activation layer) stays about
 * lifecycle rather than policy.
 *
 * The decision order is deliberate:
 *
 * 1. Non-MCP names and agent-less calls are never touched. A call without an
 *    Agent cannot carry an activation record, so denying it would break tools
 *    the pool does not own.
 * 2. An Agent with no activated record is denied everything — fail closed.
 * 3. A per-tool configured tool (`toolDenied`) is refused in every gate mode.
 * 4. Only then does the MCP gate apply: out-of-pool servers are refused, and a
 *    progressive service stays closed until it is expanded for this Agent.
 *
 * Ambiguous public names (`isAmbiguousMcpToolName`) are treated as out of pool:
 * their server boundary cannot be trusted, so they must never be allowed by
 * prefix.
 *
 * Record contract: every collection field (`allowedServers`,
 * `progressiveServers`, `expandedServers`, `toolDenied`) is a `Set`; an absent
 * field reads as empty. A field that is present but not a `Set` is a malformed
 * record and is denied with `'guard-error'` — a shape error must never open the
 * gate, and no shape error may escape as a throw.
 *
 * Pure and total: no I/O, no globals, and never throws — an unexpected shape is
 * reported as `'guard-error'` so a malformed record cannot open the gate.
 *
 * @module dsh-skill-pool/mcp-guard
 */

import { isAmbiguousMcpToolName, mcpServerOf, MCP_TOOL_PREFIX } from './rules.js'

/** Refusal because the Agent never received a live pool activation. */
export const GUARD_POOL_NOT_ACTIVATED = 'pool-not-activated'
/** Refusal because the tool itself is switched off or out of scope. */
export const GUARD_TOOL_DISABLED = 'tool-disabled'
/** Refusal because the tool's server is not in the Agent's activated pool. */
export const GUARD_SERVER_NOT_IN_POOL = 'server-not-in-pool'
/** Refusal because a progressive service has not been expanded yet. */
export const GUARD_SERVER_NOT_EXPANDED = 'server-not-expanded'
/** Refusal because the decision itself failed; treat as denied. */
export const GUARD_ERROR = 'guard-error'

/**
 * Whether one record collection is absent or a real `Set`.
 *
 * Absent is fine (it reads as empty); the contract says every collection is a
 * `Set`, so a present value of any other type is a malformed record that the
 * caller must refuse instead of treating it as empty.
 *
 * @param {unknown} collection - candidate collection from an activation record.
 * @returns {boolean} whether the collection may be read as a set.
 */
function usableCollection(collection) {
  return collection === undefined || collection === null || collection instanceof Set
}

/**
 * Membership test for one already-validated record collection.
 * @param {unknown} collection - absent or `Set` collection.
 * @param {unknown} value - candidate member.
 * @returns {boolean} whether the collection contains the value.
 */
function hasIn(collection, value) {
  return collection instanceof Set && collection.has(value)
}

/**
 * Decide whether one tool execution must be refused by the MCP guard.
 *
 * @param {{
 *   name?: string,
 *   hasAgent?: boolean,
 *   record?: {
 *     activated?: boolean,
 *     gateMcp?: boolean,
 *     allowedServers?: Set<string>,
 *     progressiveServers?: Set<string>,
 *     expandedServers?: Set<string>,
 *     toolDenied?: Set<string>,
 *   },
 * } | null | undefined} input - execution facts and the Agent's activation record.
 * @returns {string|undefined} a stable reason string, or undefined to allow.
 */
export function mcpGuardReason(input) {
  try {
    // Destructure inside the try so even a null argument cannot escape as a throw.
    const { name, hasAgent, record } = input ?? {}
    // The guard sees every tool; leave everything that is not an MCP call alone.
    if (typeof name !== 'string' || !name.startsWith(MCP_TOOL_PREFIX)) return undefined
    // No Agent means no activation record: the pool cannot own this call.
    if (hasAgent === false) return undefined
    if (record === null || typeof record !== 'object' || record.activated !== true) {
      return GUARD_POOL_NOT_ACTIVATED
    }
    // Refuse a malformed record before reading any collection: treating a
    // present-but-wrong collection as empty would open the gate.
    if (
      !usableCollection(record.toolDenied) ||
      !usableCollection(record.allowedServers) ||
      !usableCollection(record.progressiveServers) ||
      !usableCollection(record.expandedServers)
    ) {
      return GUARD_ERROR
    }
    // A per-tool refusal is a user decision, not a gate mode, so it applies first.
    if (hasIn(record.toolDenied, name)) return GUARD_TOOL_DISABLED
    // MCP gate off: the user opted out of pool-level MCP gating entirely.
    if (record.gateMcp !== true) return undefined

    // From here on the public name must be attributable to exactly one server.
    if (isAmbiguousMcpToolName(name)) return GUARD_SERVER_NOT_IN_POOL
    const server = mcpServerOf(name)
    if (!hasIn(record.allowedServers, server)) return GUARD_SERVER_NOT_IN_POOL
    if (hasIn(record.progressiveServers, server) && !hasIn(record.expandedServers, server)) {
      return GUARD_SERVER_NOT_EXPANDED
    }
    return undefined
  } catch {
    return GUARD_ERROR
  }
}
