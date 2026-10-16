// Where things are: the project's git repo, its smart-workbench ledger directory, the vendored wasm.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

// The ledger smart-workbench writes: <git common dir>/swb-ledger (worktrees share the main one).
export function ledgerDir(env = process.env) {
  const dir = env.VHDB_LEDGER_DIR || join(git(projectDir(env), ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'swb-ledger')
  if (!existsSync(join(dir, 'sessions'))) {
    throw new LocateError(`원장이 꺼져 있음: smart-workbench에서 \`/swb ledger on\` 후 사용 (찾은 경로: ${dir})`)
  }
  return dir
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
