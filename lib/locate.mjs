// Where things are: the project's git repo, its smart-workbench ledger directory, the vendored wasm.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export class LocateError extends Error {}

export function projectDir(env = process.env) {
  return env.VHDB_PROJECT_DIR || env.CLAUDE_PROJECT_DIR || process.cwd()
}

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    throw new LocateError(`git 저장소가 아님: ${dir}`)
  }
}

export function repoTop(dir = projectDir()) {
  return git(dir, ['rev-parse', '--show-toplevel'])
}

// git common dir found with the file system only (no process start): follows a worktree's `.git` file and `commondir`.
export function gitCommonDir(dir = projectDir()) {
  let cur = resolve(dir)
  for (;;) {
    const dotgit = join(cur, '.git')
    if (existsSync(dotgit)) {
      if (statSync(dotgit).isDirectory()) return dotgit
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'))
      if (!m) break
      const gitdir = resolve(cur, m[1].trim())
      const cd = join(gitdir, 'commondir')
      return existsSync(cd) ? resolve(gitdir, readFileSync(cd, 'utf8').trim()) : gitdir
    }
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  throw new LocateError(`git 저장소가 아님: ${dir}`)
}

// Our own directory (engine files, our log, config, state) lives next to, never inside, smart-workbench's swb-ledger.
export function vhdbDir(env = process.env) {
  return env.VHDB_DIR || join(gitCommonDir(projectDir(env)), 'vhdb')
}

// smart-workbench's sessions/ (read only), or null when its ledger is off.
export function swbSessionsDir(env = process.env) {
  const dir = env.VHDB_SWB_SESSIONS ?? join(gitCommonDir(projectDir(env)), 'swb-ledger', 'sessions')
  return existsSync(dir) ? dir : null
}

export function logDir(env = process.env) {
  return join(vhdbDir(env), 'log')
}

// What the engine reads: our log plus (when present) the swb ledger. Needs at least one of them.
export function locations(env = process.env) {
  const root = vhdbDir(env)
  const swb = swbSessionsDir(env)
  if (!swb && !existsSync(join(root, 'log'))) {
    throw new LocateError('읽을 이력이 없음: smart-workbench에서 `/swb ledger on` 하거나 `/vhdb:on record`로 기록을 켠 뒤 사용')
  }
  return { root, sessions: [join(root, 'log'), ...(swb ? [swb] : [])], swb }
}

export function wasmPath(env = process.env) {
  const path = env.VHDB_WASM || join(pluginRoot, 'engine', 'vhdb.wasm')
  if (!existsSync(path)) throw new LocateError(`vhdb.wasm 없음: ${path} (scripts/sync-engine.sh 실행)`)
  return path
}

// Paths in the ledger are repo-relative with '/'; accept what a person types.
export function normalizeFile(input, env = process.env) {
  let p = String(input).trim().replaceAll('\\', '/')
  if (isAbsolute(p)) {
    try {
      const rel = relative(repoTop(projectDir(env)), p).replaceAll('\\', '/')
      if (!rel.startsWith('..')) p = rel
    } catch {
      // not in a repo: keep the absolute path
    }
  }
  while (p.startsWith('./')) p = p.slice(2)
  return p
}
