/**
 * Sparse Git download for GitHub sources.
 *
 * A GitHub source only ever installs one sub-directory, so the pool must not
 * pull the whole repository archive: `codeload` answers the same multi-megabyte
 * tarball for every source of the same repo, which on a slow link turns each
 * update into a hard timeout. These tests drive the sparse path against a local
 * `file://` repository, so no network is involved: the fixture carries a large
 * `docs/` payload that a correct sparse fetch never materialises.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { downloadRepo, sparseCloneRepo } from '../src/library.js'

/** Every file below `dir`, as slash-separated paths relative to it. */
async function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await listFiles(join(dir, entry.name), relative)))
      continue
    }
    out.push(relative)
  }
  return out.sort()
}

/**
 * Build a repository shaped like a skills repo: two skills plus a payload big
 * enough that downloading it would be the difference the sparse path makes.
 */
async function makeFixtureRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'rp-sparse-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const work = join(root, 'work')
  await mkdir(join(work, 'skills/alpha/reference'), { recursive: true })
  await mkdir(join(work, 'skills/beta'), { recursive: true })
  await mkdir(join(work, 'docs'), { recursive: true })
  await writeFile(join(work, 'skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: first skill\n---\nbody\n')
  await writeFile(join(work, 'skills/alpha/reference/notes.md'), 'notes\n')
  await writeFile(join(work, 'skills/beta/SKILL.md'), '---\nname: beta\ndescription: second skill\n---\nbody\n')
  await writeFile(join(work, 'docs/huge.txt'), 'x'.repeat(512 * 1024))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work })
  execFileSync('git', ['add', '-A'], { cwd: work })
  execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-qm', 'init'], { cwd: work })
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work }).toString().trim()
  // The clone URL is `<origin>/<project>.git`, so the bare repository lives at
  // exactly that path.
  const origin = join(root, 'host')
  await mkdir(join(origin, 'owner'), { recursive: true })
  const bare = join(origin, 'owner/repo.git')
  execFileSync('git', ['clone', '-q', '--bare', work, bare])
  return { bare, sha, root, origin, project: 'owner/repo' }
}

/** The parsed-repository shape `parseRepoUrl` produces for a GitHub project. */
function githubRepo(fixture) {
  return {
    provider: 'github',
    host: 'github.com',
    hostLabel: 'github.com',
    origin: `file://${fixture.origin}`,
    apiBase: 'https://api.github.com',
    project: fixture.project,
    branchHint: '',
    subdirHint: '',
  }
}

test('sparseCloneRepo materialises only the requested sub-directory', async (t) => {
  const fixture = await makeFixtureRepo(t)
  const workDir = await mkdtemp(join(tmpdir(), 'rp-sparse-work-'))
  t.after(() => rm(workDir, { recursive: true, force: true }))

  const result = await sparseCloneRepo({
    repo: githubRepo(fixture),
    branch: 'main',
    subdir: 'skills/alpha',
    workDir,
  })

  assert.equal(result.sha, fixture.sha, 'the clone must report its own commit id')
  assert.deepEqual(await listFiles(result.extractDir), [
    'repo/skills/alpha/SKILL.md',
    'repo/skills/alpha/reference/notes.md',
  ])
  assert.match(result.digest, /^sha256:[0-9a-f]{32}$/)
})

test('sparse clone keeps the whole tree when the source names no sub-directory', async (t) => {
  const fixture = await makeFixtureRepo(t)
  const workDir = await mkdtemp(join(tmpdir(), 'rp-sparse-work-'))
  t.after(() => rm(workDir, { recursive: true, force: true }))

  const result = await sparseCloneRepo({
    repo: githubRepo(fixture),
    branch: 'main',
    subdir: '',
    workDir,
  })

  assert.deepEqual(await listFiles(result.extractDir), [
    'repo/docs/huge.txt',
    'repo/skills/alpha/SKILL.md',
    'repo/skills/alpha/reference/notes.md',
    'repo/skills/beta/SKILL.md',
  ])
})

test('downloadRepo answers a GitHub source through the sparse path', async (t) => {
  const fixture = await makeFixtureRepo(t)
  const repo = githubRepo(fixture)

  const result = await downloadRepo({ repo, branch: 'main', subdir: 'skills/beta' })

  t.after(() => rm(result.workDir, { recursive: true, force: true }))
  assert.equal(result.sparse, true, 'a GitHub source with git available must not fetch an archive')
  assert.equal(result.sha, fixture.sha)
  assert.deepEqual(await listFiles(result.extractDir), ['repo/skills/beta/SKILL.md'])
})

test('a failed clone names the git sub-command it could not run', async (t) => {
  const fixture = await makeFixtureRepo(t)
  const workDir = await mkdtemp(join(tmpdir(), 'rp-sparse-work-'))
  t.after(() => rm(workDir, { recursive: true, force: true }))

  await assert.rejects(
    sparseCloneRepo({
      repo: { ...githubRepo(fixture), origin: 'file:///nonexistent-repository' },
      branch: 'main',
      subdir: 'skills/alpha',
      workDir,
    }),
    /^Error: git clone 失败：/,
  )
})

test('a sub-directory name that looks like a glob is still checked out literally', async (t) => {
  const fixture = await makeFixtureRepo(t)
  // Cone-mode sparse checkout rejects `*?[]\` in a directory name unless the
  // check is skipped; a repository may legitimately hold such a name.
  const work = join(fixture.root, 'work')
  execFileSync('git', ['-C', work, 'mv', 'skills/beta', 'skills/b[eta]'])
  execFileSync('git', ['-C', work, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-qm', 'rename'])
  // The served repository is a bare copy; it has to see the rename too.
  await rm(fixture.bare, { recursive: true, force: true })
  execFileSync('git', ['clone', '-q', '--bare', work, fixture.bare])
  const workDir = await mkdtemp(join(tmpdir(), 'rp-sparse-work-'))
  t.after(() => rm(workDir, { recursive: true, force: true }))

  const result = await sparseCloneRepo({
    repo: githubRepo(fixture),
    branch: 'main',
    subdir: 'skills/b[eta]',
    workDir,
  })

  assert.deepEqual(await listFiles(result.extractDir), ['repo/skills/b[eta]/SKILL.md'])
})
