/**
 * Skill provider for the resource-pool library.
 *
 * The resource pool owns its own directory (`<dshHome>/resource-pool/library/skills`)
 * instead of sharing `$DSH_HOME/skills`, so imported resources never mix with
 * hand-written or packaged skills. Owning the directory means owning the supply:
 * this provider is what makes those skills visible.
 *
 * It is registered **per Agent** (`agent.ctx.skills.registerProvider`), which is
 * what implements the pool's conditions. `SkillRegistry.registerProvider` files
 * a provider into the layer of the calling context's scope, and an Agent's scope
 * key is the Agent object itself, so an Agent sees exactly the skills its own
 * registration lists. Strict hiding therefore needs no tool replacement: a skill
 * excluded by the pool simply does not exist in that Agent's catalog and cannot
 * be loaded.
 *
 * @module dsh-skill-pool/provider
 */

import { watch } from 'node:fs'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { parseSkillDocument } from './library.js'

/** Provider name inside the skill registry. */
export const PROVIDER_NAME = 'resource-pool'

/** Precedence inside one layer; irrelevant across layers (the nearest scope wins). */
const PROVIDER_RANK = 350

/** Skill-name grammar shared with the registry. */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Coalesce a burst of filesystem events into one invalidation. */
const WATCH_DEBOUNCE_MS = 120

/** Fallback poll period when the platform cannot watch the library directory. */
const POLL_INTERVAL_MS = 1_000

/**
 * Parse a frontmatter boolean with the documented strict grammar.
 *
 * An unrecognized spelling returns `undefined`, which drops the skill rather
 * than silently permitting a surface the author tried to restrict.
 *
 * @param {unknown} value - raw frontmatter value.
 * @returns {boolean|undefined} parsed boolean, or `undefined` when invalid.
 */
function parseBoolean(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(text)) return true
  if (['false', 'no', 'off', '0'].includes(text)) return false
  return undefined
}

/**
 * Build one candidate from a parsed document.
 *
 * @param {object} parsed - `parseSkillDocument` output.
 * @param {string} dirName - directory name, used when frontmatter omits `name`.
 * @param {string} dir - absolute skill directory.
 * @param {string} file - absolute `SKILL.md` path.
 * @returns {object|undefined} candidate, or `undefined` when the skill is invalid.
 */
function candidateOf(parsed, dirName, dir, file) {
  const declared = typeof parsed.meta.name === 'string' ? parsed.meta.name.trim() : ''
  const name = NAME_PATTERN.test(declared) ? declared : NAME_PATTERN.test(dirName) ? dirName : ''
  if (name.length === 0) return undefined
  const description = typeof parsed.meta.description === 'string' ? parsed.meta.description.trim() : ''
  if (description.length === 0) return undefined
  const noModel = parseBoolean(parsed.meta['disable-model-invocation'])
  const userInvocable = parseBoolean(parsed.meta['user-invocable'])
  if (noModel === undefined && parsed.meta['disable-model-invocation'] !== undefined) return undefined
  if (userInvocable === undefined && parsed.meta['user-invocable'] !== undefined) return undefined
  const whenToUse = typeof parsed.meta.whenToUse === 'string' ? parsed.meta.whenToUse.trim() : ''
  return {
    name,
    description,
    ...(whenToUse.length > 0 ? { whenToUse } : {}),
    invocation: {
      modelInvocable: parsed.meta['disable-model-invocation'] === undefined ? true : noModel !== true,
      userInvocable: parsed.meta['user-invocable'] === undefined ? true : userInvocable !== false,
    },
    source: 'custom',
    provider: PROVIDER_NAME,
    rank: PROVIDER_RANK,
    path: file,
    resourceBase: { kind: 'directory', path: dir },
    locator: { dir, file, name },
  }
}

/**
 * Create the library-backed skill provider.
 *
 * @param {object} options - provider options.
 * @param {string} options.root - absolute library skills root.
 * @param {Iterable<string>} options.allowed - skill names this Agent may see.
 * @param {{ warn?: Function, debug?: Function }} [options.logger] - logger.
 * @param {{ invalidate?: Function }} [options.control] - registration control from
 *   `skills.registerProvider`, used to invalidate the registry's catalog cache
 *   when the library changes on disk.
 * @returns {{name: string, list: Function, get: Function}} provider.
 */
export function createLibraryProvider({ root, allowed, logger, control } = {}) {
  const wanted = new Set([...allowed].map((name) => String(name)).filter((name) => NAME_PATTERN.test(name)))
  /** @type {Map<string, {mtimeMs: number, size: number, candidate: object|undefined}>} */
  const cache = new Map()
  const warned = new Set()

  /**
   * Invalidate the registry's catalog cache when the library changes on disk.
   *
   * This cannot be done from `list()`: once the registry has a cached catalog it
   * stops calling `list()` altogether, so a provider that only notices changes
   * while listing would never notice them at all. The trigger therefore has to
   * come from outside the collection, which is what the watcher below is for.
   */
  let invalidationTimer
  let watcher
  let watcherErrors = 0
  let pollTimer

  const scheduleInvalidate = () => {
    if (invalidationTimer !== undefined) return
    invalidationTimer = setTimeout(() => {
      invalidationTimer = undefined
      try {
        control?.invalidate?.()
      } catch {
        /* the registration was disposed in the meantime */
      }
    }, WATCH_DEBOUNCE_MS)
    invalidationTimer.unref?.()
  }

  /** Stop every watcher; also the registration's teardown path. */
  const stopWatching = () => {
    if (invalidationTimer !== undefined) {
      clearTimeout(invalidationTimer)
      invalidationTimer = undefined
    }
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
    if (watcher !== undefined) {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
      watcher = undefined
    }
  }

  /** Compare a cheap stat signature of the library; used when watching is unavailable. */
  let polledSignature
  const poll = async () => {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return
    }
    const parts = []
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        const info = await stat(join(root, entry.name, 'SKILL.md'))
        parts.push(`${entry.name}:${info.mtimeMs}:${info.size}`)
      } catch {
        parts.push(`${entry.name}:-`)
      }
    }
    parts.sort()
    const signature = parts.join('|')
    if (polledSignature !== undefined && polledSignature !== signature) scheduleInvalidate()
    polledSignature = signature
  }

  const startPolling = () => {
    if (pollTimer !== undefined) return
    void poll()
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    pollTimer.unref?.()
  }

  // Watch the library so an edit made by anyone but this plugin still reaches the
  // catalog. `recursive` covers each skill's own files; the poll is the fallback
  // for platforms or mounts where watching the directory is not supported.
  try {
    watcher = watch(root, { recursive: true, persistent: false }, () => scheduleInvalidate())
    watcher.on('error', () => {
      watcherErrors += 1
      stopWatching()
      if (watcherErrors > 0) startPolling()
    })
  } catch {
    startPolling()
  }
  if (control?.signal !== undefined) {
    if (control.signal.aborted) stopWatching()
    else control.signal.addEventListener('abort', stopWatching, { once: true })
  }

  /** Read one directory's candidate, reusing the parse while the file is unchanged. */
  const entryOf = async (dirName) => {
    const dir = join(root, dirName)
    const file = join(dir, 'SKILL.md')
    let info
    try {
      info = await stat(file)
    } catch {
      cache.delete(dirName)
      return undefined
    }
    const cached = cache.get(dirName)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.candidate
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      cache.delete(dirName)
      return undefined
    }
    const candidate = candidateOf(parseSkillDocument(text), dirName, dir, file)
    if (candidate === undefined && !warned.has(dirName)) {
      warned.add(dirName)
      logger?.warn?.(`[skill-pool] 跳过技能目录 ${dirName}：name/description 缺失或 invocation 取值非法`)
    }
    cache.set(dirName, { mtimeMs: info.mtimeMs, size: info.size, candidate })
    return candidate
  }

  return {
    name: PROVIDER_NAME,

    /**
     * List the allowed library skills for this Agent.
     *
     * Change notification lives in the watcher above, not here: a provider that
     * only reacted while listing would never react, because the registry serves
     * a cached catalog without calling `list()` at all.
     *
     * @returns {Promise<Array<object>>} candidates, sorted by name.
     */
    async list() {
      if (wanted.size === 0) return []
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch {
        return []
      }
      const candidates = []
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const candidate = await entryOf(entry.name)
        // Filter on the effective name, never the directory name: a bundle may
        // declare a frontmatter name that the pool did not admit.
        if (candidate === undefined || !wanted.has(candidate.name)) continue
        candidates.push(candidate)
      }
      candidates.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      return candidates
    },

    /**
     * Load one skill body. The body is re-read on every call so an update needs
     * no cache invalidation protocol.
     *
     * The candidate is re-validated against the file: a bundle may declare a
     * frontmatter name different from the one it was listed under, and a forged
     * candidate must never load a name the pool did not admit.
     *
     * @param {object} candidate - candidate returned by {@link list}.
     * @returns {Promise<object|undefined>} full definition, or `undefined` when gone.
     */
    async get(candidate) {
      const file = candidate?.locator?.file
      if (typeof file !== 'string' || !wanted.has(candidate.name)) return undefined
      let text
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return undefined
      }
      const parsed = parseSkillDocument(text)
      const dirName = String(candidate?.locator?.dir ?? '').split('/').pop() ?? ''
      const effective = candidateOf(parsed, dirName, String(candidate?.locator?.dir ?? ''), file)
      if (effective === undefined || effective.name !== candidate.name) return undefined
      return {
        name: effective.name,
        description: effective.description,
        ...(typeof effective.whenToUse === 'string' ? { whenToUse: effective.whenToUse } : {}),
        invocation: effective.invocation,
        source: effective.source,
        provider: PROVIDER_NAME,
        path: file,
        resourceBase: effective.resourceBase,
        content: parsed.body,
        ...(parsed.frontmatter.length > 0 ? { metadata: parsed.meta } : {}),
      }
    },
  }
}
