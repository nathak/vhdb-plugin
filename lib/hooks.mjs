// What each Claude Code hook records. Everything here is a no-op until `record` is switched on.
// Logged events: check (a test/build/typecheck/lint command and its outcome), error (a failed command, with a
// fingerprint), turn.end. Errors are also kept in state/errors.json so a later passing run of the same command
// can close them (Resolution); that cache can be rebuilt from the log (rebuildErrors).
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { readDecisions } from './decisions.mjs'
import { fn } from './core.mjs'
import { readConfig } from './config.mjs'
import { lock, safeId, withSession } from './log.mjs'
import { locations, projectDir, repoRootFs, vhdbDir, wasmPath } from './locate.mjs'

const TAIL = 4096

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
// fn(cache) returns [newCache, result]; the transitions themselves are computed by the Rust core.
function updateErrors(env, fn) {
  mkdirSync(join(vhdbDir(env), 'state'), { recursive: true })
  const unlock = lock(join(vhdbDir(env), 'state', 'errors.lock'))
  try {
    const [next, out] = fn(readErrors(env))
    const tmp = `${errorsPath(env)}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(next))
    renameSync(tmp, errorsPath(env))
    return out
  } finally {
    unlock()
  }
}

// Rebuilds errors.json from the log. The log is the truth: hooks append to it before they touch the cache, so after a
// crash the log is ahead and replaying it repairs the cache. The (slow) parse happens outside the lock; inside it only
// what was appended since is read. The old cache is passed as a hint for events logged before they carried a scope.
export function rebuildErrors(env) {
  const dir = join(vhdbDir(env), 'log')
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /^vhdb-.*\.jsonl$/.test(f)).sort() : []
  const offsets = new Map()
  const read = name => {
    const buf = readFileSync(join(dir, name))
    const end = buf.lastIndexOf(10) + 1 // a torn last line is not an event yet
    const from = offsets.get(name) ?? 0
    offsets.set(name, end)
    const events = []
    for (const line of buf.subarray(from, end).toString('utf8').split('\n')) {
      try {
        const ev = JSON.parse(line)
        if (ev && (ev.kind === 'error' || ev.kind === 'check')) events.push(ev)
      } catch {
        // a damaged line is skipped
      }
    }
    return events
  }
  const logs = files.map(name => ({ name, events: read(name) }))
  mkdirSync(join(vhdbDir(env), 'state'), { recursive: true })
  const unlock = lock(join(vhdbDir(env), 'state', 'errors.lock'))
  try {
    for (const l of logs) l.events.push(...read(l.name))
    for (const name of existsSync(dir) ? readdirSync(dir) : []) {
      if (/^vhdb-.*\.jsonl$/.test(name) && !files.includes(name)) logs.push({ name, events: read(name) })
    }
    const r = fn('h.errors_replay', { logs, hint: readErrors(env) })
    const tmp = `${errorsPath(env)}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(r.cache))
    renameSync(tmp, errorsPath(env))
    return r.stats
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

// Returns { event, additionalContext } when something should be shown to Claude, otherwise nothing.
// Throws only on real bugs (run.mjs swallows them).
// t0: when the time budget started, in performance.now() terms. A hook is a fresh process, so 0 (process start) is right;
// tests running inside a long-lived process pass their own.
export async function handle(input, baseEnv = process.env, { t0 = 0 } = {}) {
  const env = envFor(input, baseEnv)
  const cfg = readConfig(env)
  if (!cfg.record && !cfg.inject) return
  const sid = input.session_id
  if (!sid) return
  const root = repoRootFs(input.cwd ?? projectDir(env))
  switch (input.hook_event_name) {
    case 'UserPromptSubmit':
      return onPrompt(input, env, sid, root, cfg, t0)
    case 'PostToolUse':
      if (!cfg.record) return
      if (EDIT_TOOLS.has(input.tool_name)) {
        const f = relFile(editedFile(input), root)
        if (!f) return
        return withSession(env, sid, ({ state }) => {
          state.touched = [...new Set([...(state.touched ?? []), f])].slice(-50)
          state.edits = [...(state.edits ?? []), { file: f, at: Date.now() }].slice(-200)
        })
      }
      if (input.tool_name === 'Bash') return onBashPass(input, env, sid, root)
      return
    case 'PostToolUseFailure':
      if (cfg.record && input.tool_name === 'Bash') return onBashFail(input, env, sid, root, cfg)
      return
    case 'Stop':
      if (!cfg.record || input.stop_hook_active) return
      return onStop(env, sid)
    default:
  }
}

const timing = (env, row) => {
  try {
    mkdirSync(join(vhdbDir(env), 'state'), { recursive: true })
    appendFileSync(join(vhdbDir(env), 'state', 'timing.jsonl'), `${JSON.stringify(row)}\n`)
  } catch {
    // timing is best effort
  }
}

function focusFiles(prompt, prevTouched, root) {
  const out = new Set(prevTouched)
  for (const f of fn('h.prompt_files', String(prompt ?? ''))) out.add(relFile(f, root))
  try {
    const st = execFileSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-C', root, 'status', '--porcelain'], { encoding: 'utf8', timeout: 80, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of st.split('\n').slice(0, 50)) if (line.length > 3) out.add(line.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''))
  } catch {
    // no git, too slow: the other signals still work
  }
  return out
}

const chatQuery = prompt => fn('h.chat_query', String(prompt ?? ''))

function searchInWorker(env, query) {
  try {
    return startWorker(env, query)
  } catch {
    return null // no wasm, no history to search, worker could not start: the other layers still count
  }
}

function startWorker(env, query) {
  const loc = locations(env)
  const worker = new Worker(new URL('./worker-search.mjs', import.meta.url), { workerData: { root: loc.root, sessions: loc.sessions, wasm: wasmPath(env), query, limit: 5, now: Math.floor(Date.now() / 86400000) * 86400000, delayMs: Number(env.VHDB_TEST_DELAY_MS) || 0 } })
  const done = new Promise(res => {
    worker.once('message', res)
    worker.once('error', e => res({ ok: false, error: String(e.message ?? e) }))
    worker.once('exit', () => res({ ok: false, error: 'exit' }))
  })
  return { done, stop: () => worker.terminate() }
}

async function onPrompt(input, env, sid, root, cfg, t0) {
  const deadline = t0 + cfg.deadlineMs - 15
  const seen = withSession(env, sid, ({ state }) => {
    const before = { turn: state.turn + 1, prevTouched: state.touched ?? [], prevOpen: state.openFps ?? [], injected: state.injected ?? {}, edits: state.edits ?? [] }
    state.turn += 1
    state.touched = []
    return before
  })
  if (!cfg.inject) return
  const row = { at: Date.now(), event: 'T1', turn: seen.turn }
  let search = null
  if (existsSync(join(vhdbDir(env), 'MANIFEST'))) {
    const q = chatQuery(input.prompt)
    if (q) search = searchInWorker(env, q)
    if (q && !search) row.layer4 = 'error'
  }
  try {
    const data = { decisions: readDecisions(env), errors: cfg.record ? readErrors(env) : {}, chat: [] }
    const ctx = { prompt: input.prompt, focus: focusFiles(input.prompt, seen.prevTouched, root), prevOpen: cfg.record ? seen.prevOpen : [], sessionId: sid, turn: seen.turn, injected: seen.injected, edits: seen.edits }
    row.layers123 = Math.round(performance.now() - t0)
    if (performance.now() > deadline) return void timing(env, { ...row, skipped: 'deadline' })
    if (search) {
      const left = Math.max(0, deadline - performance.now())
      const ans = await Promise.race([search.done, new Promise(res => setTimeout(() => res(null), left))])
      if (ans?.ok) data.chat = ans.hits
      else row.layer4 = ans ? 'error' : 'late'
    }
    const out = fn('h.inject', { decisions: [...data.decisions.values()], errors: data.errors, chat: data.chat, ctx: { ...ctx, focus: [...ctx.focus] }, budgetTokens: cfg.budgetTokens })
    row.ms = Math.round(performance.now() - t0)
    if (!out) return void timing(env, { ...row, skipped: 'nothing' })
    withSession(env, sid, ({ state }) => {
      state.injected = { ...(state.injected ?? {}) }
      for (const k of out.keys) state.injected[k] = { turn: seen.turn, at: Date.now() }
      for (const [k, v] of Object.entries(state.injected)) if (seen.turn - v.turn > 20) delete state.injected[k]
    })
    timing(env, { ...row, shown: out.keys.length, tokens: out.tokens })
    return { event: 'UserPromptSubmit', additionalContext: out.text }
  } finally {
    search?.stop()
  }
}

const relOf = (input, root) => (input.cwd ? relative(root, resolve(input.cwd)) : '')

const cmdText = input => String(input.tool_input?.command ?? '')

function onBashPass(input, env, sid, root) {
  const res = fn('h.analyze_pass', { command: cmdText(input), tool_use_id: input.tool_use_id, run_in_background: Boolean(input.tool_input?.run_in_background), root, rel: relOf(input, root) })
  if (!res) return
  withSession(env, sid, ({ state, emit }) => {
    // exit status hidden by a pipe or the command ran in the background: record that it ran, claim no pass, close nothing
    if (!res.close) return emit('check', res.event)
    const now = Date.now()
    // the log line goes in first, under the cache lock: a crash between the two leaves the log ahead, which rebuildErrors repairs
    updateErrors(env, cache => {
      const r = fn('h.errors_pass', { cache, key: res.key, scope: res.scope, now, cs: safeId(sid), turn: state.turn, edits: state.edits ?? [] })
      emit('check', { ...res.event, at: now, ...(r.resolves.length ? { resolves: r.resolves } : {}) })
      return [r.cache]
    })
  })
}

function onBashFail(input, env, sid, root, cfg) {
  const a = fn('h.analyze_fail', { command: cmdText(input), error: String(input.error ?? ''), tool_name: input.tool_name, tool_use_id: input.tool_use_id, interrupt: Boolean(input.is_interrupt), root, rel: relOf(input, root), home: homedir() })
  if (!a) return
  const files = a.candidates.filter(f => existsSync(resolve(root, f))).slice(0, 5)
  return withSession(env, sid, ({ state, emit }) => {
    let prior = null
    updateErrors(env, cache => {
      const ev = emit('error', { ...a.error_event, files })
      const r = fn('h.errors_fail', { cache, fp: a.fp, etype: a.etype, sig: a.sig, key: a.key, scope: a.scope, files, now: ev.at, cs: ev.cs })
      prior = r.prior
      return [r.cache]
    })
    if (a.check_event) emit('check', a.check_event)
    state.openFps = [...new Set([...(state.openFps ?? []), a.fp])].slice(-20)
    return cfg.inject ? failureContext(env, state, a.fp, prior, files) : undefined
  })
}

// T2: a failure we have seen before is worth a word right now (what fixed it, which decisions touch those files).
function failureContext(env, state, fp, prior, files) {
  state.t2 = state.t2 ?? {}
  if (state.t2[fp] === state.turn) return // once per error per turn
  const out = fn('h.t2', { entry: readErrors(env)[fp], prior, decisions: [...readDecisions(env).values()], files, turn: state.turn, fp })
  if (!out) return
  state.t2[fp] = state.turn
  state.injected = { ...(state.injected ?? {}), [`e:${fp}`]: { turn: state.turn, at: Date.now() } }
  return { event: 'PostToolUseFailure', additionalContext: out.text }
}

function onStop(env, sid) {
  const all = readErrors(env)
  withSession(env, sid, ({ state, emit }) => {
    state.openFps = fn('h.errors_prune', { cache: all, open_fps: state.openFps ?? [] })
    emit('turn.end', { files: state.touched ?? [], open: state.openFps })
  })
  if (!env.VHDB_NO_BG) {
    // Index what was just written without making the user wait for it.
    spawn(process.execPath, [BIN, 'stat'], { detached: true, stdio: 'ignore', env }).unref()
  }
}
