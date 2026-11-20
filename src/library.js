/**
 * Skill library: install skills from uploads, ZIP archives, and Git repositories.
 *
 * Design notes:
 * - No external binaries for ZIP: the parser below reads the End Of Central
 *   Directory, walks the central directory, and inflates method-8 entries with
 *   `zlib.inflateRawSync`. Method-0 (stored) entries are copied verbatim.
 * - GitHub sources use a sparse checkout: `git clone --depth 1
 *   --filter=blob:none --sparse` plus `sparse-checkout set <subdir>` pulls only
 *   the blobs the source installs, instead of the whole tarball every source of
 *   the same repository would otherwise re-download. The commit id comes from
 *   the clone, so the commits API stays out of the update path.
 * - No mandatory `git` binary: when git is absent, refuses a partial clone, or
 *   the endpoint is blocked, GitHub/GitLab tarball endpoints are fetched with
 *   `fetch` and unpacked with the system `tar` (present on this platform).
 *   Self-hosted GitLab and GitHub Enterprise installs are supported through the
 *   same paths, derived from the pasted URL instead of a hard-coded host.
 * - Everything lands in `$DSH_HOME/resource-pool/library/skills/<name>/`, which
 *   is deliberately NOT `$DSH_HOME/skills`: the resource pool owns its own store
 *   and serves it through its own skill provider (`./provider.js`), so imported
 *   resources never mix with hand-written skills.
 * - Sources record provenance so a source can be checked, updated, or removed.
 *
 * @module dsh-skill-pool/library
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'

import { dshHome, newId } from './store.js'

const execFileAsync = promisify(execFile)

/** Hard cap for one archive (compressed bytes). */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
/** Hard cap for one archive's uncompressed payload. */
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
/** Hard cap for entries in one archive. */
const MAX_ENTRIES = 20_000
/** Timeout for one Git fetch. */
const GIT_TIMEOUT_MS = 45_000
/** Timeout for one sparse-clone process (clone plus lazy blob fetch). */
const GIT_CLONE_TIMEOUT_MS = 180_000
/** `git` binary; overridable for hosts that keep it off PATH. */
const GIT_BINARY = process.env.DSH_SKILL_POOL_GIT || 'git'

/**
 * Directory holding every skill the resource pool owns.
 *
 * It lives beside the state file, never inside `$DSH_HOME/skills`, so the
 * system filesystem provider cannot see (or accidentally gate) these skills.
 *
 * @returns {string} absolute library root.
 */
export function librarySkillsRoot() {
  return join(dshHome(), 'resource-pool', 'library', 'skills')
}

/**
 * Backwards-compatible alias of {@link librarySkillsRoot}.
 * @returns {string} absolute library root.
 */
export function skillsRoot() {
  return librarySkillsRoot()
}

/**
 * Normalize a label into a kebab-case name.
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
 * Reject a path that could escape the target directory (zip-slip).
 * @param {unknown} value - candidate relative path.
 * @returns {string} normalized posix relative path, or '' when unsafe.
 */
export function safeRelativePath(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\\/g, '/')
  if (trimmed.length === 0) return ''
  if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) return ''
  const normalized = posix.normalize(trimmed)
  if (normalized.length === 0 || normalized === '.' || normalized.startsWith('..')) return ''
  if (normalized.split('/').includes('..')) return ''
  return normalized.replace(/^\/+/, '')
}

/** YAML block-scalar header: `>`, `|`, optionally with chomping (`-`/`+`) and indentation. */
const BLOCK_SCALAR = /^([>|])([+-]?)(\d*)$/

/** Whether one line starts a new top-level frontmatter key. */
const TOP_LEVEL_KEY = /^[A-Za-z][A-Za-z0-9_-]*\s*:/

/** Whether one line is indented (part of a multi-line value). */
function isIndented(line) {
  return line.length > 0 && (line[0] === ' ' || line[0] === '\t')
}

/** Strip one pair of matching YAML quotes. */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

/**
 * Parse raw skill Markdown into frontmatter metadata and body.
 *
 * Real-world `SKILL.md` files routinely wrap `description` in a YAML block
 * scalar (`description: >` / `|-`) or continue a plain scalar on the next line.
 * A naive line split would read the indicator itself as the description, so the
 * parser resolves those forms and records each key's line span. The raw block is
 * returned unchanged so an install can keep keys this module does not
 * understand (`metadata`, nested YAML) instead of rewriting them away.
 *
 * @param {string} text - markdown document.
 * @returns {{meta: Record<string, string>, body: string, hadFrontmatter: boolean,
 *   frontmatter: string, spans: Record<string, {start: number, end: number}>}} parsed document.
 */
export function parseSkillDocument(text) {
  const source = typeof text === 'string' ? text : ''
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (match === null) return { meta: {}, body: source, hadFrontmatter: false, frontmatter: '', spans: {} }
  const lines = match[1].split(/\r?\n/)
  const meta = {}
  const spans = {}
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (isIndented(line) || !TOP_LEVEL_KEY.test(line)) {
      index += 1
      continue
    }
    const field = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (field === null) {
      index += 1
      continue
    }
    const key = field[1]
    const raw = field[2].trim()
    const start = index
    index += 1

    // Gather the value's continuation lines: indented lines, plus blank lines
    // that are followed by more indented content (a blank line inside a block).
    const collected = []
    let lastMeaningful = start
    while (index < lines.length) {
      const next = lines[index]
      if (next.trim().length === 0) {
        collected.push('')
        index += 1
        continue
      }
      if (!isIndented(next)) break
      collected.push(next.trim())
      lastMeaningful = index
      index += 1
    }
    // Trailing blanks belong to chomping, not to the value or the span.
    if (collected.length > 0) {
      let end = collected.length
      while (end > 0 && collected[end - 1].length === 0) end -= 1
      collected.length = end
    }
    spans[key] = { start, end: lastMeaningful + 1 }

    const block = BLOCK_SCALAR.exec(raw)
    let value
    if (block !== null) {
      // Folded joins with spaces, literal keeps newlines; blank lines survive as
      // paragraph breaks in both styles.
      if (block[1] === '>') {
        const parts = []
        let blanks = 0
        for (const entry of collected) {
          if (entry.length === 0) {
            blanks += 1
            continue
          }
          if (parts.length > 0) parts.push(blanks > 0 ? '\n'.repeat(blanks) : ' ')
          parts.push(entry)
          blanks = 0
        }
        value = parts.join('')
      } else {
        value = collected.join('\n')
      }
      value = value.replace(/\s+$/, '')
    } else if (collected.length > 0) {
      // A plain scalar continued on indented lines folds into one line.
      value = [raw, ...collected.filter((entry) => entry.length > 0)].join(' ')
    } else {
      value = unquote(raw)
    }
    meta[key] = value
  }
  return { meta, body: source.slice(match[0].length), hadFrontmatter: true, frontmatter: match[1], spans }
}

/** Write one file atomically. */
async function writeAtomic(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

/**
 * Parse one ZIP archive into in-memory entries.
 *
 * Supports stored (0) and deflate (8) entries, which covers every archive
 * produced by `zip`, GitHub's "Download ZIP", and most tooling.
 *
 * @param {Buffer|Uint8Array} buffer - archive bytes.
 * @returns {Array<{path: string, data: Buffer}>} regular-file entries.
 */
export function parseZip(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (data.length === 0 || data.length > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件为空或超过 64MB 上限')

  // Locate the End Of Central Directory record (scan back over the comment).
  let eocd = -1
  const stop = Math.max(0, data.length - 0xffff - 22)
  for (let at = data.length - 22; at >= stop; at -= 1) {
    if (data.readUInt32LE(at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件')

  const entryCount = data.readUInt16LE(eocd + 10)
  const directoryOffset = data.readUInt32LE(eocd + 16)
  if (entryCount > MAX_ENTRIES) throw new Error('ZIP 条目过多')

  const entries = []
  let total = 0
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > data.length || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
    const method = data.readUInt16LE(cursor + 10)
    const compressedSize = data.readUInt32LE(cursor + 20)
    const uncompressedSize = data.readUInt32LE(cursor + 24)
    const nameLength = data.readUInt16LE(cursor + 28)
    const extraLength = data.readUInt16LE(cursor + 30)
    const commentLength = data.readUInt16LE(cursor + 32)
    const localOffset = data.readUInt32LE(cursor + 42)
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    cursor += 46 + nameLength + extraLength + commentLength

    const safe = safeRelativePath(name)
    if (safe.length === 0) continue // directories, macOS junk, unsafe paths
    if (name.endsWith('/')) continue

    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地头损坏')
    const localNameLength = data.readUInt16LE(localOffset + 26)
    const localExtraLength = data.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const raw = data.subarray(start, start + compressedSize)
    let content
    if (method === 0) content = Buffer.from(raw)
    else if (method === 8) content = inflateRawSync(raw, { maxOutputLength: 32 * 1024 * 1024 })
    else throw new Error(`ZIP 使用了不支持的压缩方式 ${method}（仅支持 store/deflate）`)
    if (content.length !== uncompressedSize && uncompressedSize !== 0) {
      throw new Error('ZIP 解压长度不匹配')
    }
    total += content.length
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('ZIP 解压后体积过大')
    entries.push({ path: safe, data: content })
  }
  if (entries.length === 0) throw new Error('ZIP 里没有可用文件')
  return entries
}

/**
 * Group a flat file list into skill bundles.
 *
 * A bundle is either `<name>/SKILL.md` (plus siblings) or a top-level `<name>.md`.
 * A leading common root directory (an archive's single top folder) is stripped.
 *
 * @param {Array<{path: string, data: Buffer|string}>} files - files with relative paths.
 * @returns {Array<{name: string, files: Array<{path: string, data: Buffer|string}>}>} bundles.
 */
export function groupSkillBundles(files) {
  /** @type {Array<{path: string, data: Buffer|string}>} */
  const list = files
    .filter((file) => typeof file?.path === 'string' && safeRelativePath(file.path).length > 0)
    .map((file) => ({ path: safeRelativePath(file.path), data: file.data }))
  if (list.length === 0) return []

  // Strip one shared top-level directory when every path sits below it (an
  // archive's single root folder, e.g. "repo-main/...").
  const roots = new Set(list.map((file) => file.path.split('/')[0]))
  const strip = roots.size === 1
    && list.every((file) => file.path.includes('/'))
    && !list.some((file) => file.path.split('/').pop() === 'SKILL.md' && file.path.split('/').length === 2)
    ? [...roots][0]
    : ''
  const stripped = strip.length > 0
    ? list.map((file) => ({ ...file, path: file.path.split('/').slice(1).join('/') }))
    : list

  // Every directory that directly contains SKILL.md is one bundle root.
  /** @type {string[]} */
  const rootsWithSkill = []
  for (const file of stripped) {
    const parts = file.path.split('/')
    if (parts[parts.length - 1] !== 'SKILL.md') continue
    const dir = parts.slice(0, -1).join('/')
    rootsWithSkill.push(dir)
  }
  // Drop nested roots: a skill inside another skill's directory belongs to the inner one.
  const roots2 = rootsWithSkill.filter((dir) => !rootsWithSkill.some((other) => other !== dir && (other === '' ? true : dir.startsWith(other + '/'))))

  // Flat "<name>.md" files count as skills only when no SKILL.md bundle exists,
  // so a repository README never becomes a skill next to real bundles.
  const flatMarkdown = roots2.length === 0
    ? stripped.filter((file) => file.path.split('/').length === 1 && file.path.toLowerCase().endsWith('.md'))
    : []
  if (roots2.length === 0 && flatMarkdown.length === 0) return []
  const bundles = []
  for (const dir of roots2) {
    if (dir.length > 0) {
      const prefix = dir + '/'
      const members = stripped.filter((file) => file.path.startsWith(prefix))
      if (members.length === 0) continue
      bundles.push({
        name: dir.split('/').pop(),
        files: members.map((file) => ({ path: file.path.slice(prefix.length), data: file.data })),
      })
      continue
    }
    // The upload root itself is the bundle. Its members are every file that does
    // not belong to a nested skill root — subdirectories included. Restricting
    // this to depth 1 silently dropped `scripts/` and `references/` of a
    // root-level skill.
    const nested = rootsWithSkill.filter((other) => other.length > 0)
    const members = stripped.filter((file) => !nested.some((root) => file.path.startsWith(root + '/')))
    if (members.length === 0) continue
    // Never derive the name from the filename `SKILL.md` (that produced "SKILL");
    // prefer the name the document declares.
    const document = members.find((file) => file.path === 'SKILL.md')
    const declared = document === undefined
      ? ''
      : slugify(parseSkillDocument(Buffer.isBuffer(document.data) ? document.data.toString('utf8') : String(document.data)).meta.name ?? '')
    bundles.push({ name: declared.length > 0 ? declared : 'skill', files: members })
  }
  for (const file of flatMarkdown) {
    bundles.push({ name: file.path.replace(/\.md$/i, ''), files: [{ path: 'SKILL.md', data: file.data }] })
  }
  return bundles
}

/**
 * Content digest of one skill bundle (order-independent over file paths).
 * @param {Array<{path: string, data: Buffer|string}>} files - bundle files.
 * @returns {string} `sha256:<hex>` digest.
 */
export function bundleDigest(files) {
  const list = Array.isArray(files) ? files : []
  const hash = createHash('sha256')
  for (const file of [...list].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
    hash.update(file.path)
    hash.update('\u0000')
    hash.update(Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data)))
    hash.update('\u0000')
  }
  return `sha256:${hash.digest('hex').slice(0, 32)}`
}

/**
 * Rebuild a skill document, keeping every frontmatter key the author wrote.
 *
 * Only two keys are rewritten: `name` becomes the canonical kebab-case value and
 * `description` becomes the effective single-line description. Each key's whole
 * line span is dropped first, so a block scalar (`description: >` plus its
 * indented lines) is removed as a unit instead of leaving orphaned lines behind.
 * Every other key — including nested YAML such as `metadata:` — survives verbatim.
 *
 * @param {{meta: Record<string, string>, body: string, hadFrontmatter: boolean,
 *   frontmatter: string, spans?: Record<string, {start: number, end: number}>}} parsed - parsed document.
 * @param {string} name - canonical skill name.
 * @param {string} description - effective description (collapsed to one line).
 * @returns {string} document to write.
 */
function renderSkillDocument(parsed, name, description) {
  // A YAML plain scalar cannot hold a newline; catalogs want one line anyway.
  const line = description.replace(/\s+/g, ' ').trim()
  const lines = parsed.hadFrontmatter ? parsed.frontmatter.split(/\r?\n/) : []
  const dropped = new Set()
  for (const key of ['name', 'description']) {
    const span = parsed.spans?.[key]
    if (span === undefined) continue
    for (let index = span.start; index < span.end; index += 1) dropped.add(index)
  }
  const kept = lines.filter((_line, index) => !dropped.has(index))
  const header = [`name: ${name}`, ...(line.length > 0 ? [`description: ${line}`] : [])]
  const block = [...header, ...kept].join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
  return `---\n${block}\n---\n\n${parsed.body.replace(/^\s+/, '')}`
}

/**
 * Install one skill bundle onto disk.
 * @param {object} options - install options.
 * @param {string} options.name - skill name.
 * @param {Array<{path: string, data: Buffer|string}>} options.files - bundle files (`SKILL.md` required).
 * @param {boolean} [options.overwrite] - replace an existing bundle.
 * @param {string} [options.root] - library root override.
 * @returns {Promise<{name: string, description: string, dir: string, digest: string}>} installed skill.
 */
export async function installSkillBundle({ name, files, overwrite = false, root, defaultName = '', defaultDescription = '' } = {}) {
  const skillName = slugify(name) || slugify(defaultName)
  if (skillName.length === 0) throw new Error(`技能名 "${name}" 无法转为 kebab-case`)
  const primary = files.find((file) => file.path === 'SKILL.md')
  if (primary === undefined) throw new Error(`技能 ${skillName} 缺少 SKILL.md`)
  const text = Buffer.isBuffer(primary.data) ? primary.data.toString('utf8') : String(primary.data)
  const parsed = parseSkillDocument(text)
  // The upload dialog may supply the missing fields; frontmatter always wins.
  const description = (parsed.meta.description ?? defaultDescription ?? '').toString().trim()
  if (description.length === 0) throw new Error(`技能 ${skillName} 的 SKILL.md 缺少 description`)
  const frontmatterName = slugify(parsed.meta.name ?? '') || slugify(defaultName) || skillName
  const finalName = frontmatterName.length > 0 ? frontmatterName : skillName

  const base = typeof root === 'string' && root.length > 0 ? root : librarySkillsRoot()
  const dir = join(base, finalName)
  if (!overwrite) {
    try {
      await stat(join(dir, 'SKILL.md'))
      throw new Error(`技能 ${finalName} 已存在；勾选「覆盖」后再导入`)
    } catch (error) {
      if (error instanceof Error && error.message.includes('已存在')) throw error
    }
  }
  // Replace instead of merging: a re-import must not leave stale bundle files.
  if (overwrite) await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeAtomic(join(dir, 'SKILL.md'), renderSkillDocument(parsed, finalName, description))
  for (const file of files) {
    if (file.path === 'SKILL.md') continue
    const relative = safeRelativePath(file.path)
    if (relative.length === 0) continue
    const target = join(dir, relative)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, file.data)
  }
  const digest = bundleDigest([
    { path: 'SKILL.md', data: renderSkillDocument(parsed, finalName, description) },
    ...files.filter((file) => file.path !== 'SKILL.md'),
  ])
  return { name: finalName, description, dir, digest }
}

/** Turn one install error into the API's `{name, error}` shape. */
function failureOf(bundleName, error) {
  return { name: String(bundleName), error: error instanceof Error ? error.message : String(error) }
}

/**
 * Install every bundle found in a flat file list.
 * @returns {Promise<{installed: string[], failures: Array<{name: string, error: string}>, digests: Record<string, string>}>} result.
 */
async function installAllBundles({ files, overwrite = false, root, defaults = {} }) {
  const bundles = groupSkillBundles(files)
  if (bundles.length === 0) throw new Error('没有找到技能：需要一个包含 SKILL.md 的目录，或顶层 *.md 文件')
  const installed = []
  const failures = []
  const digests = {}
  for (const bundle of bundles) {
    try {
      // A name/description typed in the dialog only makes sense for one bundle.
      const single = bundles.length === 1
      const skill = await installSkillBundle({
        name: bundle.name,
        files: bundle.files,
        overwrite,
        root,
        defaultName: single ? defaults.name ?? '' : '',
        defaultDescription: single ? defaults.description ?? '' : '',
      })
      installed.push(skill.name)
      digests[skill.name] = skill.digest
    } catch (error) {
      failures.push(failureOf(bundle.name, error))
    }
  }
  if (installed.length === 0) throw new Error(`技能安装失败：${failures.map((failure) => `${failure.name}: ${failure.error}`).join('; ')}`)
  return { installed, failures, digests }
}

/**
 * Install skills from a list of uploaded files.
 * @param {{files: Array<{path: string, content: string}>, overwrite?: boolean, root?: string, name?: string, description?: string, scope?: object}} options - install options.
 * @returns {Promise<{installed: string[], failures: Array<{name: string, error: string}>, digests: Record<string, string>}>} installation result.
 */
export async function installFromFiles({ files, overwrite = false, root, name = '', description = '' } = {}) {
  const list = (Array.isArray(files) ? files : []).filter((file) => typeof file?.content === 'string')
  if (list.length === 0) throw new Error('没有可上传的文件内容')
  const normalized = list.map((file) => ({ path: safeRelativePath(file.path) || 'SKILL.md', data: file.content }))
  return installAllBundles({ files: normalized, overwrite, root, defaults: { name, description } })
}

/**
 * Install skills from a ZIP archive (base64).
 * @param {{archiveBase64: string, overwrite?: boolean, root?: string, label?: string, scope?: object}} options - install options.
 * @returns {Promise<{installed: string[], failures: Array<{name: string, error: string}>, digests: Record<string, string>}>} installation result.
 */
export async function installFromZip({ archiveBase64, overwrite = false, root, label } = {}) {
  if (typeof archiveBase64 !== 'string' || archiveBase64.length === 0) throw new Error('缺少 archiveBase64')
  const buffer = Buffer.from(archiveBase64, 'base64')
  const entries = parseZip(buffer)
  return installAllBundles({ files: entries, overwrite, root })
}

/**
 * Parse a GitHub/GitLab repository URL.
 * @param {unknown} value - repository URL.
 * @returns {{provider: 'github'|'gitlab', project: string, host: string}} parsed repository.
 */
/**
 * Parse a repository URL into the endpoints needed to download and check it.
 *
 * Self-hosted installs are first-class: the host comes from the URL, so an
 * internal GitLab (`https://git.example.com/group/repo`) works exactly like
 * gitlab.com. A pasted browser URL is understood too — GitLab's
 * `/-/tree/<branch>/<subdir>` and `/-/blob/...` shapes are stripped back to the
 * project, and the branch/sub-directory they encode are returned as hints.
 *
 * @param {unknown} value - repository URL (https, ssh scp-like, or a web URL).
 * @param {{provider?: 'auto'|'gitlab'|'github'}} [options] - provider override.
 * @returns {{provider: 'github'|'gitlab', project: string, host: string, origin: string,
 *   apiBase: string, branchHint: string, subdirHint: string}} parsed repository.
 */
export function parseRepoUrl(value, { provider: forced = 'auto' } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('缺少仓库 URL')
  let url = value.trim()
  // scp-like SSH form: git@host:group/repo.git
  const ssh = /^git@([^:]+):(.+)$/.exec(url)
  if (ssh !== null) url = `https://${ssh[1]}/${ssh[2]}`
  // Bare host/path without a scheme is a common paste; assume https.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('仓库 URL 无效，需要 https://<host>/<group>/<repo>')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仓库地址只支持 http/https')
  }

  let segments = parsed.pathname.split('/').filter((part) => part.length > 0)

  const host = parsed.hostname.toLowerCase()
  const origin = `${parsed.protocol}//${parsed.host}`
  // `hostLabel` keeps an explicit port, which self-hosted instances often use.
  const hostLabel = parsed.host.toLowerCase()
  const looksGithub = host === 'github.com' || host.endsWith('.github.com')

  // A `/-/tree/...` marker is GitLab's canonical web path, so it decides the
  // provider even on an unknown (self-hosted) host.
  const gitlabMarker = segments.indexOf('-')
  const hasGitlabMarker = gitlabMarker > 0
    && (segments[gitlabMarker + 1] === 'tree' || segments[gitlabMarker + 1] === 'blob' || segments[gitlabMarker + 1] === 'src')
  // GitHub (and GitHub Enterprise) put the same information directly after the
  // two-segment project: `/<owner>/<repo>/tree/<branch>/<path>`.
  const hasGithubMarker = segments.length > 2 && (segments[2] === 'tree' || segments[2] === 'blob' || segments[2] === 'raw')

  // Explicit choice wins, then the URL shape, then the host.
  const provider = forced === 'github' || forced === 'gitlab'
    ? forced
    : hasGitlabMarker
      ? 'gitlab'
      : looksGithub || hasGithubMarker
        ? 'github'
        : 'gitlab'

  // Keep the branch and sub-directory a browser URL already names, so pasting a
  // link to one skill imports exactly that skill.
  let branchHint = ''
  let subdirHint = ''
  if (provider === 'gitlab') {
    if (hasGitlabMarker) {
      const rest = segments.slice(gitlabMarker + 2)
      branchHint = rest[0] ?? ''
      subdirHint = rest.slice(1).join('/')
      segments = segments.slice(0, gitlabMarker)
    }
  } else if (hasGithubMarker) {
    const rest = segments.slice(3)
    branchHint = rest[0] ?? ''
    subdirHint = rest.slice(1).join('/')
    segments = segments.slice(0, 2)
  } else if (looksGithub && segments.length > 2) {
    // A github.com URL with extra path but no recognised marker: treat the
    // trailing segments as junk rather than a longer project name, because a
    // GitHub project is always exactly two segments.
    segments = segments.slice(0, 2)
  }

  if (segments.length > 0 && /\.git$/i.test(segments[segments.length - 1])) {
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, '')
  }
  const project = segments.join('/')
  if (project.split('/').length < 2) throw new Error('仓库 URL 需要包含 owner/repo（GitLab 支持多级 group）')
  // GitHub answers `tree|blob|raw` in the branch position with a Git ref name, so
  // an empty one would build a nonsense archive URL.
  if (branchHint === 'tree' || branchHint === 'blob' || branchHint === 'raw') branchHint = ''
  // A link to a file (`.../blob/main/skills/x/SKILL.md`) points at the file, but
  // the importer needs its directory.
  if (/\.md$/i.test(subdirHint)) subdirHint = subdirHint.split('/').slice(0, -1).join('/')

  const apiBase =
    provider === 'github'
      ? host === 'github.com'
        ? 'https://api.github.com'
        : `${origin}/api/v3`
      : `${origin}/api/v4`
  return { provider, project, host, hostLabel, origin, apiBase, branchHint, subdirHint }
}

/**
 * Where to fetch one branch's tarball.
 * @param {object} repo - `parseRepoUrl` result.
 * @param {string} branch - branch name.
 * @returns {string} archive URL.
 */
function archiveUrlOf(repo, branch) {
  if (repo.provider === 'github') {
    // codeload is the documented fast path on github.com; GHE serves the same
    // archive from the web origin.
    return repo.host === 'github.com'
      ? `https://codeload.github.com/${repo.project}/tar.gz/refs/heads/${encodeURIComponent(branch)}`
      : `${repo.origin}/${repo.project}/archive/refs/heads/${encodeURIComponent(branch)}.tar.gz`
  }
  return `${repo.apiBase}/projects/${encodeURIComponent(repo.project)}/repository/archive.tar.gz?sha=${encodeURIComponent(branch)}`
}

/**
 * Where to ask for one branch's head commit.
 * @param {object} repo - `parseRepoUrl` result.
 * @param {string} branch - branch name.
 * @returns {string} commits API URL.
 */
function commitsUrlOf(repo, branch) {
  if (repo.provider === 'github') return `${repo.apiBase}/repos/${repo.project}/commits/${encodeURIComponent(branch)}`
  return `${repo.apiBase}/projects/${encodeURIComponent(repo.project)}/repository/commits/${encodeURIComponent(branch)}`
}

/** HTTP headers for one provider. */
function providerHeaders(provider, token) {
  if (typeof token !== 'string' || token.length === 0) return { 'user-agent': 'dsh-skill-pool' }
  if (provider === 'github') return { 'user-agent': 'dsh-skill-pool', authorization: `Bearer ${token}` }
  return { 'user-agent': 'dsh-skill-pool', 'PRIVATE-TOKEN': token }
}

/** Download one archive with a timeout. */
async function fetchBuffer(url, headers) {
  const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(GIT_TIMEOUT_MS) })
  if (!response.ok) {
    const hint = response.status === 404 ? '（仓库或分支不存在，或私有仓库缺少 token）' : ''
    const error = new Error(`下载失败：HTTP ${response.status}${hint}`)
    // Callers need the status to tell "this instance forbids archives" apart from
    // a genuine failure.
    error.status = response.status
    error.url = url
    throw error
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('仓库归档超过 64MB 上限')
  return buffer
}

/** Whether an archive download failed because the instance forbids archives. */
function isArchiveBlocked(error) {
  const status = error?.status
  // GitLab answers 406 when repository archives are disabled or filtered by a
  // proxy; 403/415 show up on hardened instances as well.
  return status === 406 || status === 403 || status === 415
}

/** Fetch one GitLab API document as JSON. */
async function gitlabJson(repo, path, token) {
  const response = await fetch(`${repo.apiBase}${path}`, {
    headers: providerHeaders(repo.provider, token),
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
  })
  if (!response.ok) {
    const hint = response.status === 404 ? '（仓库或分支不存在，或私有仓库缺少 token）' : ''
    const error = new Error(`读取仓库失败：HTTP ${response.status}${hint}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

/**
 * Read a whole GitLab repository through the API instead of its archive.
 *
 * Some hardened self-hosted instances answer 406 on
 * `/repository/archive.*` while the rest of the API works fine. The recursive
 * tree plus per-file `raw` endpoints reconstruct the same file list, so a repo
 * that cannot be archived can still be imported.
 *
 * @param {object} repo - `parseRepoUrl` result (gitlab only).
 * @param {string} branch - branch or tag name.
 * @param {string} token - access token.
 * @returns {Promise<Array<{path: string, data: Buffer}>>} files, relative to the repository root.
 */
async function readTreeViaApi(repo, branch, token) {
  const project = encodeURIComponent(repo.project)
  const entries = []
  for (let page = 1; page <= 100; page += 1) {
    const rows = await gitlabJson(
      repo,
      `/projects/${project}/repository/tree?ref=${encodeURIComponent(branch)}&recursive=true&per_page=100&page=${page}`,
      token,
    )
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      if (row.type !== 'blob' || typeof row.path !== 'string' || row.path.length === 0) continue
      entries.push(row.path)
      if (entries.length > MAX_ENTRIES) throw new Error('仓库文件过多')
    }
    if (rows.length < 100) break
  }
  if (entries.length === 0) throw new Error('仓库里没有文件')

  const files = []
  const queue = entries.slice()
  const worker = async () => {
    for (;;) {
      const path = queue.shift()
      if (path === undefined) return
      const response = await fetch(
        `${repo.apiBase}/projects/${project}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`,
        { headers: providerHeaders(repo.provider, token), signal: AbortSignal.timeout(GIT_TIMEOUT_MS) },
      )
      if (!response.ok) {
        const error = new Error(`读取 ${path} 失败：HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      files.push({ path, data: Buffer.from(await response.arrayBuffer()) })
    }
  }
  // A small pool keeps a 40-file repo fast without hammering the instance.
  await Promise.all([worker(), worker(), worker(), worker()])
  return files
}

/**
 * Resolve the remote commit id of one branch without downloading the archive.
 *
 * This is what makes "check for updates" cheap: one API call per source instead
 * of a full tarball download. The endpoint comes from the parsed URL, so this
 * works against gitlab.com, a self-hosted GitLab, or GitHub Enterprise alike.
 *
 * @param {object} options - lookup options.
 * @param {object} options.repo - `parseRepoUrl` result.
 * @param {string} options.branch - branch name.
 * @param {string} [options.token] - access token.
 * @returns {Promise<string>} commit id.
 */
async function resolveRemoteSha({ repo, branch, token }) {
  const url = commitsUrlOf(repo, branch)
  const headers = repo.provider === 'github'
    ? { ...providerHeaders(repo.provider, token), accept: 'application/vnd.github+json' }
    : providerHeaders(repo.provider, token)
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(GIT_TIMEOUT_MS) })
  if (!response.ok) {
    const hint = response.status === 404 ? '（仓库或分支不存在，或私有仓库缺少 token）' : ''
    throw new Error(`查询提交失败：HTTP ${response.status}${hint}`)
  }
  const payload = await response.json()
  const id = repo.provider === 'github' ? payload?.sha : payload?.id
  if (typeof id === 'string' && id.length > 0) return id
  throw new Error(`查询提交失败：响应缺少 ${repo.provider === 'github' ? 'sha' : 'id'}`)
}

/** Cached answer of {@link gitAvailable}; `undefined` until the first probe. */
let gitAvailableCache

/**
 * Whether a usable `git` binary is on PATH. Probed once per process: a missing
 * binary must cost one failed `spawn`, not one per source.
 *
 * @returns {Promise<boolean>} true when `git --version` succeeds.
 */
async function gitAvailable() {
  if (gitAvailableCache === undefined) {
    try {
      await execFileAsync(GIT_BINARY, ['--version'], { timeout: 10_000 })
      gitAvailableCache = true
    } catch {
      gitAvailableCache = false
    }
  }
  return gitAvailableCache
}

/**
 * Human-readable name of the git subcommand an argument list runs. Skips the
 * global options (`-c key=value`, `-C dir`) that precede it.
 * @param {string[]} args - git arguments.
 * @returns {string} subcommand name.
 */
function gitCommandLabel(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-c' || arg === '-C') {
      index += 1
      continue
    }
    if (!arg.startsWith('-')) return arg
  }
  return args[0] ?? 'git'
}

/**
 * Run one git command.
 * @param {string[]} args - git arguments.
 * @param {{cwd?: string, env?: Record<string, string>}} [options] - process options.
 * @returns {Promise<string>} standard output.
 */
async function runGit(args, { cwd, env } = {}) {
  try {
    const { stdout } = await execFileAsync(GIT_BINARY, args, {
      cwd,
      env,
      timeout: GIT_CLONE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
    const detail = stderr.length > 0 ? stderr : error instanceof Error ? error.message : String(error)
    throw new Error(`git ${gitCommandLabel(args)} 失败：${detail.split('\n').slice(-3).join(' ')}`)
  }
}

/**
 * Clone URL for one repository. The token never travels in the URL, so it
 * cannot leak through `ps` or an error message.
 * @param {object} repo - `parseRepoUrl` result.
 * @returns {string} https clone URL.
 */
function cloneUrlOf(repo) {
  return `${repo.origin}/${repo.project}.git`
}

/**
 * Environment for one git command: no interactive credential prompt, and the
 * token handed over through `GIT_CONFIG_*` instead of argv.
 * @param {string} token - access token.
 * @returns {NodeJS.ProcessEnv} child environment.
 */
function gitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (typeof token === 'string' && token.length > 0) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  return env
}

/**
 * Fetch one repository through a shallow, blob-less, sparse checkout.
 *
 * A source installs exactly one directory, so only that directory's blobs are
 * downloaded: kilobytes instead of the multi-megabyte archive codeload serves
 * for every source of the same repo. The commit id comes from the clone itself,
 * which also keeps the commits API (and its rate limit) out of the update path.
 *
 * @param {object} options - clone options.
 * @param {object} options.repo - `parseRepoUrl` result.
 * @param {string} options.branch - branch or tag name.
 * @param {string} [options.subdir] - directory the source installs from.
 * @param {string} [options.token] - access token.
 * @param {string} options.workDir - temporary directory owned by the caller.
 * @returns {Promise<{extractDir: string, sha: string, digest: string, files: number}>} tree location and identity.
 */
export async function sparseCloneRepo({ repo, branch, subdir = '', token = '', workDir } = {}) {
  if (typeof repo !== 'object' || repo === null) throw new Error('缺少仓库信息')
  if (typeof workDir !== 'string' || workDir.length === 0) throw new Error('缺少临时目录')
  if (typeof branch !== 'string' || branch.length === 0) throw new Error('缺少分支名')
  const wanted = typeof subdir === 'string' ? subdir.trim() : ''
  const sparse = wanted.length > 0 && wanted !== '.'
  const cloneDir = join(workDir, 'clone')
  const extractDir = join(workDir, 'tree')
  const env = gitEnv(token)
  // A stalled transfer must fail fast instead of burning the wall-clock timeout:
  // git aborts once throughput stays under 1 KB/s for 20 s.
  const args = [
    '-c', 'http.lowSpeedLimit=1000',
    '-c', 'http.lowSpeedTime=20',
    'clone', '--depth', '1', '--filter=blob:none', '--branch', branch, '--quiet',
  ]
  if (sparse) args.push('--sparse')
  args.push(cloneUrlOf(repo), cloneDir)
  await runGit(args, { cwd: workDir, env })
  if (sparse) {
    const checkout = ['-C', cloneDir, 'sparse-checkout', 'set']
    // Cone mode rejects `*?[]\` in a directory name unless the check is skipped,
    // and a repository may legitimately hold such a name.
    if (/[*?[\]\\]/.test(wanted)) checkout.push('--skip-checks')
    checkout.push('--', wanted)
    await runGit(checkout, { env })
  }
  const sha = (await runGit(['-C', cloneDir, 'rev-parse', 'HEAD'], { env })).trim()
  const target = join(extractDir, repo.project.split('/').pop())
  await mkdir(extractDir, { recursive: true })
  await rename(cloneDir, target)
  await rm(join(target, '.git'), { recursive: true, force: true })
  const files = await readTree(target)
  return { extractDir, sha, digest: bundleDigest(files), files: files.length }
}

/**
 * Download and unpack one repository into a temporary directory.
 *
 * GitHub sources take the sparse checkout first: the pool installs one folder,
 * so pulling the whole archive is both slow and, on a throttled link, a
 * guaranteed timeout. The archive endpoint stays as the fallback (no git
 * binary, older git, a host that refuses partial clones), and when a GitLab
 * instance refuses archives (406) the tree is rebuilt through its API, so the
 * install path downstream does not care which route produced it.
 *
 * @param {object} options - download options.
 * @param {object} options.repo - `parseRepoUrl` result.
 * @param {string} options.branch - branch name.
 * @param {string} [options.subdir] - directory the source installs from.
 * @param {string} [options.token] - access token.
 * @returns {Promise<{workDir: string, extractDir: string, sha: string, digest: string, files: number, sparse: boolean}>} unpacked tree.
 */
export async function downloadRepo({ repo, branch, subdir = '', token = '' } = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'rp-git-'))
  if (repo.provider === 'github' && await gitAvailable()) {
    try {
      const cloned = await sparseCloneRepo({ repo, branch, subdir, token, workDir })
      return { workDir, ...cloned, sparse: true }
    } catch {
      // Fall back to the archive path: no git, a partial-clone refusal, or a
      // proxy that blocks the git endpoint all land here.
      await rm(join(workDir, 'clone'), { recursive: true, force: true })
      await rm(join(workDir, 'tree'), { recursive: true, force: true })
    }
  }
  const extractDir = join(workDir, 'tree')
  await mkdir(extractDir, { recursive: true })
  let files = []
  let archiveDigest = ''
  try {
    const archive = await fetchBuffer(archiveUrlOf(repo, branch), providerHeaders(repo.provider, token))
    const archivePath = join(workDir, 'repo.tar.gz')
    await writeFile(archivePath, archive)
    try {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir], { timeout: GIT_TIMEOUT_MS })
    } catch (error) {
      await rm(workDir, { recursive: true, force: true })
      throw new Error(`解包失败：${error instanceof Error ? error.message : String(error)}`)
    }
    archiveDigest = bundleDigest([{ path: 'archive.tar.gz', data: archive }])
  } catch (error) {
    if (!isArchiveBlocked(error) || repo.provider !== 'gitlab') throw error
    // Archives are disabled on this instance: rebuild the tree file by file.
    files = await readTreeViaApi(repo, branch, token)
    const top = join(extractDir, repo.project.split('/').pop())
    for (const file of files) {
      const relative = safeRelativePath(file.path)
      if (relative.length === 0) continue
      const target = join(top, relative)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, file.data)
    }
    archiveDigest = bundleDigest(files)
  }
  let sha = ''
  try {
    sha = await resolveRemoteSha({ repo, branch, token })
  } catch {
    // A missing commit API must not block an install; fall back to a content hash.
    sha = `archive:${createHash('sha256').update(archiveDigest).digest('hex').slice(0, 16)}`
  }
  return { workDir, extractDir, sha, digest: archiveDigest, files: files.length, sparse: false }
}

/** Read every file under one directory into a flat list. */
async function readTree(dir) {
  const out = []
  const walk = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const full = join(current, entry.name)
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      out.push({ path: relative, data: await readFile(full) })
      if (out.length > MAX_ENTRIES) throw new Error('仓库文件过多')
    }
  }
  await walk(dir, '')
  return out
}

/**
 * Group a repository tree into skill bundles.
 *
 * A skill root is any directory that directly holds `SKILL.md`; every file
 * below it (`reference/`, `scripts/`, …) ships with the skill, relative to that
 * root. Nested roots are skipped: the inner skill owns its files.
 *
 * @param {Array<{path: string, data: Buffer|string}>} files - tree files with relative paths.
 * @returns {Array<{name: string, dir: string, files: Array<{path: string, data: Buffer|string}>}>} bundles.
 */
export function bundlesFromTree(files) {
  const list = Array.isArray(files) ? files.filter((file) => typeof file?.path === 'string') : []
  const skillRoots = []
  for (const file of list) {
    if (file.path.split('/').pop() !== 'SKILL.md') continue
    skillRoots.push(file.path.split('/').slice(0, -1).join('/'))
  }
  const bundles = []
  for (const dir of skillRoots) {
    const prefix = dir.length > 0 ? dir + '/' : ''
    // A nested skill root owns its own subtree; it never ships inside the parent.
    const nestedRoots = skillRoots.filter((other) => other !== dir && other.startsWith(prefix))
    const members = list
      .filter((file) => file.path.startsWith(prefix))
      .filter((file) => !nestedRoots.some((nested) => file.path.startsWith(nested + '/')))
      .map((file) => ({ path: file.path.slice(prefix.length), data: file.data }))
    if (members.length === 0) continue
    bundles.push({ name: dir.split('/').pop(), dir, files: members })
  }
  return bundles
}

/**
 * Install skills discovered in one extracted repository tree.
 * @returns {Promise<{installed: string[], failures: Array<{name: string, error: string}>, digests: Record<string, string>}>} result.
 */
async function installFromTree({ extractDir, subdir, overwrite, root, exclude = [] }) {
  const roots = await readdir(extractDir, { withFileTypes: true })
  const top = roots.find((entry) => entry.isDirectory())
  if (top === undefined) throw new Error('仓库归档为空')
  let base = join(extractDir, top.name)
  if (typeof subdir === 'string' && subdir.length > 0) {
    base = join(base, ...subdir.split('/').filter((part) => part.length > 0 && part !== '.' && part !== '..'))
  }
  const files = await readTree(base)
  const allBundles = bundlesFromTree(files)
  if (allBundles.length === 0) throw new Error('仓库里没有包含 SKILL.md 的技能目录')
  // Names the user deleted are never written back: an update must not resurrect
  // what "删除" removed.
  const blocked = new Set(Array.isArray(exclude) ? exclude : [])
  const bundles = allBundles.filter((bundle) => !blocked.has(bundle.name))
  if (bundles.length === 0) return { installed: [], failures: [], digests: {}, excluded: allBundles.map((bundle) => bundle.name) }
  // When the pasted sub-directory IS the skill bundle, its `SKILL.md` sits at the
  // base and `bundlesFromTree` has no directory segment to name it after.
  const subdirName = base.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? ''
  const installed = []
  const failures = []
  const digests = {}
  for (const bundle of bundles) {
    try {
      const skill = await installSkillBundle({
        name: bundle.name,
        files: bundle.files,
        overwrite,
        root,
        defaultName: bundle.name.length > 0 ? '' : subdirName,
      })
      installed.push(skill.name)
      digests[skill.name] = skill.digest
    } catch (error) {
      // A name clash with an existing skill must never be silent.
      failures.push(failureOf(bundle.name, error))
    }
  }
  if (installed.length === 0) throw new Error(`技能安装失败：${failures.map((failure) => `${failure.name}: ${failure.error}`).join('; ')}`)
  return { installed, failures, digests }
}

/**
 * Install skills from a Git repository.
 * @param {object} options - import options.
 * @param {string} options.url - repository URL.
 * @param {string} [options.branch] - branch name.
 * @param {string} [options.subdir] - subdirectory holding the skills.
 * @param {string} [options.token] - access token (stored by the caller, never here).
 * @param {string} [options.label] - display label.
 * @param {boolean} [options.overwrite] - replace existing skills.
 * @param {string} [options.root] - library root override.
 * @returns {Promise<{source: object, installed: string[], failures: Array<{name: string, error: string}>, digests: Record<string, string>}>} installation result.
 */
export async function installFromGit({ url, branch, subdir, token = '', label, provider = 'auto', overwrite = false, root } = {}) {
  const repo = parseRepoUrl(url, { provider })
  // A pasted browser URL already names its branch and folder; use those when the
  // caller left the fields alone.
  const wantedBranch = typeof branch === 'string' && branch.trim().length > 0 ? branch.trim() : repo.branchHint || 'main'
  const wantedSubdir = typeof subdir === 'string' && subdir.length > 0 ? subdir : repo.subdirHint
  const { workDir, extractDir, sha, digest } = await downloadRepo({ repo, branch: wantedBranch, subdir: wantedSubdir, token })
  try {
    const { installed, failures, digests } = await installFromTree({ extractDir, subdir: wantedSubdir, overwrite, root })
    const now = new Date().toISOString()
    return {
      installed,
      failures,
      digests,
      source: {
        id: newId('src'),
        kind: 'git',
        label: typeof label === 'string' && label.trim().length > 0 ? label.trim() : `${repo.project}@${wantedBranch}`,
        url: String(url).trim(),
        provider: repo.provider,
        host: repo.hostLabel,
        project: repo.project,
        branch: wantedBranch,
        subdir: typeof wantedSubdir === 'string' ? wantedSubdir : '',
        sha,
        digest,
        skills: installed,
        createdAt: now,
        updatedAt: now,
      },
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Re-fetch one Git source and replace the skills it installed.
 * @param {object} options - update options.
 * @param {object} options.source - stored source record.
 * @param {string} [options.token] - access token.
 * @param {string} [options.root] - library root override.
 * @returns {Promise<{source: object, installed: string[], failures: Array<{name: string, error: string}>, digests: Record<string, string>, changed: boolean}>} update result.
 */
export async function updateGitSource({ source, token = '', root, exclude, force = false } = {}) {
  if (source?.kind !== 'git') throw new Error('只有 Git 来源可以更新')
  const repo = parseRepoUrl(source.url)
  const branch = source.branch ?? 'main'
  const blocked = Array.isArray(exclude) ? exclude : Array.isArray(source.excluded) ? source.excluded : []
  const { workDir, extractDir, sha, digest } = await downloadRepo({ repo, branch, subdir: source.subdir ?? '', token })
  try {
    // `force` reinstalls even when the commit is unchanged: that is what
    // "恢复已排除" needs, since nothing upstream moved.
    if (!force && typeof source.sha === 'string' && source.sha.length > 0 && source.sha === sha) {
      return { changed: false, source: { ...source, sha, digest }, installed: [], failures: [], digests: {} }
    }
    const { installed, failures, digests } = await installFromTree({
      extractDir,
      subdir: source.subdir ?? '',
      overwrite: true,
      root,
      exclude: blocked,
    })
    const now = new Date().toISOString()
    // Skills that disappeared upstream must not linger in the pool.
    const previous = Array.isArray(source.skills) ? source.skills : []
    const gone = previous.filter((name) => !installed.includes(name))
    for (const name of gone) {
      const safe = slugify(name)
      if (safe.length > 0) await rm(join(typeof root === 'string' && root.length > 0 ? root : librarySkillsRoot(), safe), { recursive: true, force: true })
    }
    return {
      changed: true,
      installed,
      failures,
      digests,
      removed: gone,
      source: { ...source, sha, digest, skills: installed, updatedAt: now },
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/**
 * Check one Git source for an upstream change without downloading it.
 * @param {{source: object, token?: string}} options - check options.
 * @returns {Promise<{id: string, label: string, status: 'up-to-date'|'update-available', current: string, remote: string}>} check result.
 */
export async function checkGitSource({ source, token = '' } = {}) {
  if (source?.kind !== 'git') throw new Error('只有 Git 来源可以检查更新')
  const repo = parseRepoUrl(source.url)
  const current = typeof source.sha === 'string' ? source.sha : ''
  const branch = source.branch ?? 'main'
  let remote
  try {
    remote = await resolveRemoteSha({ repo, branch, token })
  } catch (error) {
    // The install recorded an archive-based identity when the commits API was
    // unavailable (no token, rate limit, GitLab without a readable commit).
    // Compare like with like rather than reporting a permanent error.
    if (!current.startsWith('archive:')) throw error
    const archive = await fetchBuffer(archiveUrlOf(repo, branch), providerHeaders(repo.provider, token))
    remote = `archive:${createHash('sha256').update(archive).digest('hex').slice(0, 16)}`
  }
  const changed = current.length === 0 || current !== remote
  return {
    id: source.id,
    label: typeof source.label === 'string' ? source.label : source.url,
    status: changed ? 'update-available' : 'up-to-date',
    current,
    remote,
  }
}

/**
 * Delete the skill directories one source installed, skipping shared names.
 * @param {{source: object, root?: string, skipSkills?: string[]}} options - removal options.
 * @returns {Promise<{removed: string[], skipped: string[]}>} removal outcome.
 */
export async function removeSourceSkills({ source, root, skipSkills = [] } = {}) {
  const base = typeof root === 'string' && root.length > 0 ? root : librarySkillsRoot()
  const skip = new Set((Array.isArray(skipSkills) ? skipSkills : []).map((name) => slugify(name)).filter((name) => name.length > 0))
  const removed = []
  const skipped = []
  for (const name of Array.isArray(source?.skills) ? source.skills : []) {
    const safe = slugify(name)
    if (safe.length === 0) continue
    if (skip.has(safe)) {
      skipped.push(safe)
      continue
    }
    const dir = join(base, safe)
    try {
      await stat(dir)
    } catch {
      continue
    }
    await rm(dir, { recursive: true, force: true })
    removed.push(safe)
  }
  return { removed, skipped }
}

/**
 * Read every skill currently on disk in the library.
 *
 * The registry cannot answer this: the library provider is registered per
 * Agent, so a global catalog read legitimately returns nothing. The panel needs
 * the on-disk truth instead, which is what this returns.
 *
 * @param {{root?: string}} [options] - listing options.
 * @returns {Promise<Array<{name: string, description: string, path: string, dir: string, modelInvocable: boolean, userInvocable: boolean, digest: string, whenToUse?: string}>>} skills sorted by name.
 */
export async function listLibrarySkills({ root } = {}) {
  const base = typeof root === 'string' && root.length > 0 ? root : librarySkillsRoot()
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(base, entry.name)
    const file = join(dir, 'SKILL.md')
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const parsed = parseSkillDocument(text)
    const declared = typeof parsed.meta.name === 'string' ? parsed.meta.name.trim() : ''
    const name = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(declared) ? declared : /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name) ? entry.name : ''
    if (name.length === 0) continue
    const description = typeof parsed.meta.description === 'string' ? parsed.meta.description.trim() : ''
    const whenToUse = typeof parsed.meta.whenToUse === 'string' ? parsed.meta.whenToUse.trim() : ''
    out.push({
      name,
      description,
      ...(whenToUse.length > 0 ? { whenToUse } : {}),
      path: file,
      dir,
      modelInvocable: parsed.meta['disable-model-invocation'] !== 'true',
      userInvocable: parsed.meta['user-invocable'] !== 'false',
      digest: bundleDigest([{ path: 'SKILL.md', data: text }]),
    })
  }
  out.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return out
}

/**
 * Delete one skill directory from the library.
 * @param {{root?: string, name: string}} options - removal options.
 * @returns {Promise<boolean>} whether a directory was removed.
 */
export async function removeSkillDir({ root, name } = {}) {
  const base = typeof root === 'string' && root.length > 0 ? root : librarySkillsRoot()
  const safe = slugify(name)
  if (safe.length === 0) return false
  const dir = join(base, safe)
  try {
    await stat(dir)
  } catch {
    return false
  }
  await rm(dir, { recursive: true, force: true })
  return true
}

/** Copy one directory tree (used by tests and future local-source support). */
export async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  await cp(from, to, { recursive: true })
}
