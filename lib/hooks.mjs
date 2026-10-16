// What each Claude Code hook records. Everything here is a no-op until `record` is switched on.
// Logged events: check (a test/build/typecheck/lint command and its outcome), error (a failed command, with a
// fingerprint), turn.end. Errors are also kept in state/errors.json so a later passing run of the same command
// can close them (Resolution); that cache can be rebuilt from the log.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify } from './checks.mjs'
import { readConfig } from './config.mjs'
import { fingerprint } from './fingerprint.mjs'
import { redact } from './redact.mjs'
import { lock, withSession } from './log.mjs'
import { projectDir, repoRootFs, vhdbDir } from './locate.mjs'

const TAIL = 4096
const SENSITIVE = /(?:^|[\s/=])\.env\b|\.pem\b|id_rsa|id_ed25519|credentials|\.npmrc|\.netrc|secrets?\b|keystore/i
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const BIN = fileURLToPath(new URL('../bin/vhdb.mjs', import.meta.url))

const errorsPath = env => join(vhdbDir(env), 'state', 'errors.json')

export function readErrors(env) {
  try {
    return JSON.parse(readFileSync(errorsPath(env), 'utf8'))
  } catch {
    return {}
  }
}

// errors.json is shared by every session of the project: read-modify-write under its own lock.
function updateErrors(env, fn) {
  mkdirSync(join(vhdbDir(env), 'state'), { recursive: true })
  const unlock = lock(join(vhdbDir(env), 'state', 'errors.lock'))
  try {
    const all = readErrors(env)
    const out = fn(all)
    const tmp = `${errorsPath(env)}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(all))
    renameSync(tmp, errorsPath(env))
    return out
  } finally {
    unlock()
  }
}

function relFile(file, root) {
  if (!file) return null
  const p = String(file).replaceAll('\\', '/')
  if (!isAbsolute(p)) return p.replace(/^\.\//, '')
  const rel = relative(root, p).replaceAll('\\', '/')
  return rel.startsWith('..') ? p : rel
}

const editedFile = input => input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? null

function envFor(input, env) {
  const e = { ...env }
  if (!e.VHDB_PROJECT_DIR && !e.CLAUDE_PROJECT_DIR && input.cwd) e.VHDB_PROJECT_DIR = input.cwd
  return e
}

// Returns nothing; throws only on real bugs (run.mjs swallows them).
export function handle(input, baseEnv = process.env) {
  const env = envFor(input, baseEnv)
  const cfg = readConfig(env)
  if (!cfg.record) return
  const sid = input.session_id
  if (!sid) return
  const root = repoRootFs(input.cwd ?? projectDir(env))
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return withSession(env, sid, ({ state }) => {
        state.turn += 1
        state.touched = []
      })
    case 'PostToolUse':
      if (EDIT_TOOLS.has(input.tool_name)) {
        const f = relFile(editedFile(input), root)
        if (!f) return
        return withSession(env, sid, ({ state }) => {
          state.touched = [...new Set([...(state.touched ?? []), f])].slice(-50)
          state.edits = [...(state.edits ?? []), { file: f, at: Date.now() }].slice(-200)
        })
      }
      if (input.tool_name === 'Bash') return onBashPass(input, env, sid)
      return
    case 'PostToolUseFailure':
      if (input.tool_name === 'Bash') return onBashFail(input, env, sid, root)
      return
    case 'Stop':
      if (input.stop_hook_active) return
      return onStop(env, sid)
    default:
  }
}

const cmdText = input => String(input.tool_input?.command ?? '')

function onBashPass(input, env, sid) {
  const check = classify(cmdText(input))
  if (!check) return
  const command = SENSITIVE.test(cmdText(input)) ? '' : redact(cmdText(input)).slice(0, 300)
  withSession(env, sid, ({ state, emit }) => {
    const now = Date.now()
    if (check.masked) {
      // exit status hidden by a pipe: record that it ran, but neither claim a pass nor close any error
      return emit('check', { check: check.check, key: check.key, command, outcome: 'unknown', tool_use_id: input.tool_use_id })
    }
    const resolves = updateErrors(env, all => {
      const out = []
      for (const [fp, e] of Object.entries(all)) {
        if (!e.open || e.key !== check.key) continue
        const same = e.lastCs === sid
        const files = same ? [...new Set((state.edits ?? []).filter(x => x.at >= (e.last ?? 0)).map(x => x.file))].slice(0, 20) : []
        e.open = false
        e.resolved = { at: now, cs: sid, turn: state.turn, files, confidence: same ? 'observed' : 'inferred' }
        out.push({ fp, confidence: e.resolved.confidence, files })
      }
      return out
    })
    emit('check', { check: check.check, key: check.key, command, outcome: 'pass', tool_use_id: input.tool_use_id, ...(resolves.length ? { resolves } : {}) })
  })
}

function onBashFail(input, env, sid, root) {
  if (input.is_interrupt) return
  const raw = String(input.error ?? '')
  const exit = /^Exit code (\d+)/.exec(raw)?.[1]
  const check = classify(cmdText(input))
  const sensitive = SENSITIVE.test(cmdText(input))
  const fpr = fingerprint(raw, { repoTop: root, home: homedir() })
  if (!fpr) return
  const etype = check ? check.check : 'runtime'
  const key = check?.key ?? redact(cmdText(input)).replace(/\s+/g, ' ').slice(0, 200)
  const files = [...new Set(fpr.loc.map(w => w.replace(/:\d+$/, '')).filter(f => existsSync(resolve(root, f))))].slice(0, 5)
  withSession(env, sid, ({ state, emit }) => {
    const now = Date.now()
    updateErrors(env, all => {
      const e = all[fpr.fp] ?? { seen: 0, first: now, sessions: [] }
      Object.assign(e, { etype, sig: redact(fpr.sig), key, files, last: now, lastCs: sid, open: true, seen: e.seen + 1, sessions: [...new Set([...e.sessions, sid])].slice(-10) })
      delete e.resolved
      all[fpr.fp] = e
    })
    emit('error', {
      tool: input.tool_name,
      etype,
      exit: exit === undefined ? null : Number(exit),
      fp: fpr.fp,
      sig: redact(fpr.sig),
      loc: fpr.loc,
      files,
      key,
      command: sensitive ? '' : redact(cmdText(input)).slice(0, 300),
      tail: sensitive ? '' : redact(raw.slice(-TAIL)),
      tool_use_id: input.tool_use_id,
    })
    if (check) emit('check', { check: check.check, key: check.key, command: sensitive ? '' : redact(cmdText(input)).slice(0, 300), outcome: 'fail', fps: [fpr.fp], tool_use_id: input.tool_use_id })
    state.openFps = [...new Set([...(state.openFps ?? []), fpr.fp])].slice(-20)
  })
}

function onStop(env, sid) {
  const all = readErrors(env)
  withSession(env, sid, ({ state, emit }) => {
    state.openFps = (state.openFps ?? []).filter(fp => all[fp]?.open)
    emit('turn.end', { files: state.touched ?? [], open: state.openFps })
  })
  if (!env.VHDB_NO_BG) {
    // Index what was just written without making the user wait for it.
    spawn(process.execPath, [BIN, 'stat'], { detached: true, stdio: 'ignore', env }).unref()
  }
}
