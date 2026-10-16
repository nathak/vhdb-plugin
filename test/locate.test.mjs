import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { LocateError, gitCommonDir, locations, normalizeFile, projectDir, swbSessionsDir, vhdbDir } from '../lib/locate.mjs'

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' })

test('project dir: VHDB_PROJECT_DIR beats CLAUDE_PROJECT_DIR beats cwd', () => {
  assert.equal(projectDir({ VHDB_PROJECT_DIR: 'a', CLAUDE_PROJECT_DIR: 'b' }), 'a')
  assert.equal(projectDir({ CLAUDE_PROJECT_DIR: 'b' }), 'b')
  assert.equal(projectDir({}), process.cwd())
})

test('git common dir without starting git: plain repo, worktree, nested dir, not a repo', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'vhdb-repo-')))
  git(repo, 'init', '-q')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
  assert.equal(gitCommonDir(repo), join(repo, '.git'))
  mkdirSync(join(repo, 'a', 'b'), { recursive: true })
  assert.equal(gitCommonDir(join(repo, 'a', 'b')), join(repo, '.git'))
  const wt = join(repo, '..', `wt-${process.pid}`)
  git(repo, 'worktree', 'add', '-q', wt)
  assert.equal(realpathSync(gitCommonDir(wt)), join(repo, '.git'))
  assert.throws(() => gitCommonDir(mkdtempSync(join(tmpdir(), 'vhdb-nogit-'))), LocateError)
})

test('our dir sits beside swb-ledger; swb sessions are optional; nothing to read is explained', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'vhdb-repo3-')))
  git(repo, 'init', '-q')
  const env = { VHDB_PROJECT_DIR: repo }
  assert.equal(vhdbDir(env), join(repo, '.git', 'vhdb'))
  assert.equal(swbSessionsDir(env), null)
  assert.throws(() => locations(env), e => e instanceof LocateError && e.message.includes('/swb ledger on'))
  mkdirSync(join(repo, '.git', 'swb-ledger', 'sessions'), { recursive: true })
  const loc = locations(env)
  assert.deepEqual(loc.sessions, [join(repo, '.git', 'vhdb', 'log'), join(repo, '.git', 'swb-ledger', 'sessions')])
})

test('our log alone is enough (swb ledger off)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vhdb-own-'))
  mkdirSync(join(dir, 'log'))
  const loc = locations({ VHDB_DIR: dir, VHDB_SWB_SESSIONS: join(dir, 'none') })
  assert.deepEqual(loc.sessions, [join(dir, 'log')])
})

test('file paths: backslashes, ./ prefixes and absolute paths inside the repo', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'vhdb-repo2-')))
  git(repo, 'init', '-q')
  const env = { VHDB_PROJECT_DIR: repo }
  assert.equal(normalizeFile('.\\src\\a.ts', env), 'src/a.ts')
  assert.equal(normalizeFile('./src/a.ts', env), 'src/a.ts')
  assert.equal(normalizeFile(join(repo, 'src/a.ts'), env), 'src/a.ts')
  assert.equal(normalizeFile('/elsewhere/x.ts', env), '/elsewhere/x.ts')
})
