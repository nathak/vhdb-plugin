import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { LocateError, ledgerDir, normalizeFile, projectDir } from '../lib/locate.mjs'

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'ignore' })

test('project dir: VHDB_PROJECT_DIR beats CLAUDE_PROJECT_DIR beats cwd', () => {
  assert.equal(projectDir({ VHDB_PROJECT_DIR: 'a', CLAUDE_PROJECT_DIR: 'b' }), 'a')
  assert.equal(projectDir({ CLAUDE_PROJECT_DIR: 'b' }), 'b')
  assert.equal(projectDir({}), process.cwd())
})

test('ledger dir lives in the git common dir, shared by worktrees; missing sessions/ is explained', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'vhdb-repo-')))
  git(repo, 'init', '-q')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
  const env = { VHDB_PROJECT_DIR: repo }
  assert.throws(() => ledgerDir(env), e => e instanceof LocateError && e.message.includes('/swb ledger on'))
  mkdirSync(join(repo, '.git', 'swb-ledger', 'sessions'), { recursive: true })
  assert.equal(ledgerDir(env), join(repo, '.git', 'swb-ledger'))
  const wt = join(repo, '..', `wt-${process.pid}`)
  git(repo, 'worktree', 'add', '-q', wt)
  assert.equal(ledgerDir({ VHDB_PROJECT_DIR: wt }), join(repo, '.git', 'swb-ledger'))
})

test('not a git repo is reported, not thrown raw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vhdb-nogit-'))
  assert.throws(() => ledgerDir({ VHDB_PROJECT_DIR: dir }), LocateError)
})

test('VHDB_LEDGER_DIR overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vhdb-led-'))
  mkdirSync(join(dir, 'sessions'))
  assert.equal(ledgerDir({ VHDB_LEDGER_DIR: dir }), dir)
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
