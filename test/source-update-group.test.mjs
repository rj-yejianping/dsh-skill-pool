/**
 * Real `/source/update` route against a synthetic local GitLab-like server.
 *
 * Verifies that a source update while the repo group is disabled preserves the
 * member's own enabled flag, so re-enabling the group restores it. Uses a temp
 * state, a temp archive and a loopback server; no live config is read.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { registerWebApi, ROUTE_PREFIX } from '../src/web-api.js'
import { StateStore, normalizeState } from '../src/store.js'

const tarAvailable = spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0

test('source/update keeps same-group member enabled for re-enabling', async (t) => {
  if (!tarAvailable) {
    t.skip('system tar is required for the synthetic GitLab archive fixture')
    return
  }
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rp-review-git-'))
  const projectDir = join(fixtureRoot, 'project-main')
  await mkdir(join(projectDir, 'shared'), { recursive: true })
  await writeFile(join(projectDir, 'shared', 'SKILL.md'), '---\nname: shared\ndescription: synthetic\n---\nbody\n', 'utf8')
  execFileSync('tar', ['-czf', join(fixtureRoot, 'archive.tar.gz'), '-C', fixtureRoot, 'project-main'])

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname.endsWith('/repository/commits/main')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'synthetic-new-sha' }))
      return
    }
    if (url.pathname.endsWith('/repository/archive.tar.gz')) {
      response.writeHead(200, { 'content-type': 'application/gzip' })
      response.end(await readFile(join(fixtureRoot, 'archive.tar.gz')))
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`

  const dir = await mkdtemp(join(tmpdir(), 'rp-review-state-'))
  const file = join(dir, 'state.json')
  const store = new StateStore({ file })
  await store.write(normalizeState({
    version: 4,
    settings: { enabled: true, mcpGate: true, injectSummary: true, gateDefaultSkills: false },
    sources: {
      src_a: {
        id: 'src_a', kind: 'git', label: 'group/project@main',
        url: `${origin}/group/project`, provider: 'gitlab', host: `127.0.0.1:${server.address().port}`,
        project: 'group/project', branch: 'main', subdir: '', sha: 'synthetic-old-sha',
        skills: ['shared'], excluded: [], createdAt: '2026-11-18T00:00:00.000Z',
      },
    },
    groups: {
      'repo:group/project': {
        key: 'repo:group/project', kind: 'repo', enabled: false,
        modes: ['standard'], workspaces: ['/workspace'],
      },
    },
    skills: {
      shared: {
        enabled: true, modes: [], workspaces: [], modesFrom: 'group', workspacesFrom: 'group',
        sourceId: 'src_a', installedAt: '2026-11-18T00:00:00.000Z',
      },
    },
    mcp: {},
  }))

  const handlers = new Map()
  const services = {
    connection: {
      admit: () => ({}),
      fetch: {
        register(route) {
          handlers.set(`${route.methods[0]} ${route.path}`, route.fetch)
          return () => handlers.delete(`${route.methods[0]} ${route.path}`)
        },
      },
    },
  }
  const ctx = {
    get: (name) => services[name],
    inject: (_names, callback) => callback({ get: (name) => services[name], effect: (register) => register() }),
    effect: (register) => register(),
  }
  registerWebApi({
    ctx, store, meta: { file, version: 'review' },
    onChanged: async () => {},
    logger: { warn() {}, info() {}, debug() {} },
  })
  const call = async (method, suffix, body) => {
    const pathname = suffix.split('?')[0]
    const handler = handlers.get(`${method} ${ROUTE_PREFIX}${pathname}`)
    const init = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const response = await handler(new Request(`http://dsh.invalid${ROUTE_PREFIX}${suffix}`, init))
    return { status: response.status, payload: await response.json() }
  }

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const before = await call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(before.payload.pool.skills, [], 'the disabled group hides the member')

    const update = await call('POST', '/source/update', { id: 'src_a' })
    assert.equal(update.status, 200, JSON.stringify(update.payload))
    const member = update.payload.state.skills.shared
    assert.equal(member.enabled, true, 'own enabled flag survives the update')
    assert.equal(member.modesFrom, 'group')
    assert.equal(member.workspacesFrom, 'group')

    const enable = await call('POST', '/group', { key: 'repo:group/project', enabled: true })
    assert.equal(enable.status, 200, JSON.stringify(enable.payload))
    const after = await call('GET', '/resolve?mode=standard&cwd=%2Fworkspace')
    assert.deepEqual(after.payload.pool.skills, ['shared'], 're-enabling the same group restores the member')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await new Promise((resolve) => server.close(resolve))
    await rm(dir, { recursive: true, force: true })
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
