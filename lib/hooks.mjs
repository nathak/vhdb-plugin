// What each Claude Code hook records. Everything here is a no-op until `record` is switched on.
// Logged events: check (a test/build/typecheck/lint command and its outcome), error (a failed command, with a
// fingerprint), turn.end. Errors are also kept in state/errors.json so a later passing run of the same command
// can close them (Resolution); that cache can be rebuilt from the log.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { readDecisions } from './decisions.mjs'
import { build } from './inject.mjs'
import { classify } from './checks.mjs'
import { readConfig } from './config.mjs'
import { fingerprint } from './fingerprint.mjs'
import { redact } from './redact.mjs'
import { lock, withSession } from './log.mjs'
import { locations, projectDir, repoRootFs, vhdbDir, wasmPath } from './locate.mjs'

const TAIL = 4096
const SENSITIVE = /(?:^|[\s/='"<>])\.env\b|\.pem\b|id_rsa|id_ed25519|credentials|\.npmrc|\.netrc|secrets?\b|keystore|\bprintenv\b|(?:^|[;&|\s])env\s*(?:$|[;&|])|\bexport\s+-p\b|\bset\s*(?:$|[;&|])|:\/\/[^\s:@\/]+:[^\s@\/]+@/im
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

const FILE_IN_TEXT = /[\w@./-]+\.[A-Za-z0-9]{1,6}\b/g

function focusFiles(prompt, prevTouched, root) {
  const out = new Set(prevTouched)
  for (const m of String(prompt ?? '').matchAll(FILE_IN_TEXT)) out.add(relFile(m[0], root))
  try {
    const st = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', timeout: 80, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of st.split('\n').slice(0, 50)) if (line.length > 3) out.add(line.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''))
  } catch {
    // no git, too slow: the other signals still work
  }
  return out
}

// Words of the prompt for the engine: plain words only, no VQL syntax.
function chatQuery(prompt) {
  const words = String(prompt ?? '').match(/[A-Za-z0-9_]{3,}|[가-힣]{2,}/g) ?? []
  return [...new Set(words)].slice(0, 12).join(' ')
}

function searchInWorker(env, query) {
  const loc = locations(env)
  const worker = new Worker(new URL('./worker-search.mjs', import.meta.url), { workerData: { root: loc.root, sessions: loc.sessions, wasm: wasmPath(env), query, limit: 5, now: Math.floor(Date.now() / 86400000) * 86400000, delayMs: Number(env.VHDB_TEST_DELAY_MS) || 0 } })
  const done = new Promise(res => {
    worker.once('message', res)
    worker.once('error', e => res({ ok: false, error: String(e.message ?? e) }))
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
  }
  try {
    const data = { decisions: readDecisions(env), errors: readErrors(env), chat: [] }
    const ctx = { prompt: input.prompt, focus: focusFiles(input.prompt, seen.prevTouched, root), prevOpen: seen.prevOpen, sessionId: sid, turn: seen.turn, injected: seen.injected, edits: seen.edits }
    row.layers123 = Math.round(performance.now() - t0)
    if (performance.now() > deadline) return void timing(env, { ...row, skipped: 'deadline' })
    if (search) {
      const left = Math.max(0, deadline - performance.now())
      const ans = await Promise.race([search.done, new Promise(res => setTimeout(() => res(null), left))])
      if (ans?.ok) data.chat = ans.hits
      else row.layer4 = ans ? 'error' : 'late'
    }
    const out = build(data, ctx, { budgetTokens: cfg.budgetTokens })
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

// Errors are only closed by the same check in the same place: another worktree or package is a different scope.
function scopeOf(input, root, check) {
  const rel = input.cwd ? relative(root, resolve(input.cwd)) : ''
  return createHash('sha1').update(`${root}|${rel}|${check.cwd ?? ''}`).digest('hex').slice(0, 8)
}

const cmdText = input => String(input.tool_input?.command ?? '')

function onBashPass(input, env, sid, root) {
  const check = classify(cmdText(input))
  if (!check) return
  const scope = scopeOf(input, root, check)
  const command = SENSITIVE.test(cmdText(input)) ? '' : redact(cmdText(input)).slice(0, 300)
  withSession(env, sid, ({ state, emit }) => {
    const now = Date.now()
    if (check.masked || input.tool_input?.run_in_background) {
      // exit status hidden by a pipe: record that it ran, but neither claim a pass nor close any error
      return emit('check', { check: check.check, key: redact(check.key), command, outcome: 'unknown', tool_use_id: input.tool_use_id })
    }
    const key = redact(check.key)
    const resolves = updateErrors(env, all => {
      const out = []
      for (const [fp, e] of Object.entries(all)) {
        if (!e.open || e.key !== key || e.scope !== scope) continue
        const same = e.lastCs === sid
        const files = same ? [...new Set((state.edits ?? []).filter(x => x.at >= (e.last ?? 0)).map(x => x.file))].slice(0, 20) : []
        e.open = false
        e.resolved = { at: now, cs: sid, turn: state.turn, files, confidence: same ? 'observed' : 'inferred' }
        out.push({ fp, confidence: e.resolved.confidence, files })
      }
      return out
    })
    emit('check', { check: check.check, key, command, outcome: 'pass', tool_use_id: input.tool_use_id, ...(resolves.length ? { resolves } : {}) })
  })
}

function onBashFail(input, env, sid, root, cfg) {
  if (input.is_interrupt) return
  const raw = String(input.error ?? '')
  const exit = /^Exit code (\d+)/.exec(raw)?.[1]
  const check = classify(cmdText(input))
  const sensitive = SENSITIVE.test(cmdText(input))
  // mask before fingerprinting: blanking digits afterwards would break the secret patterns' length rules
  const fpr = fingerprint(redact(raw), { repoTop: root, home: homedir() })
  if (!fpr) return
  if (sensitive) Object.assign(fpr, { sig: '(비공개)', loc: [], file: '' })
  const etype = check && !check.compound ? check.check : 'runtime'
  const key = redact(check?.key ?? cmdText(input)).replace(/\s+/g, ' ').slice(0, 200)
  const scope = check ? scopeOf(input, root, check) : scopeOf(input, root, {})
  const files = [...new Set(fpr.loc.map(w => w.replace(/:\d+$/, '')).filter(f => existsSync(resolve(root, f))))].slice(0, 5)
  return withSession(env, sid, ({ state, emit }) => {
    const now = Date.now()
    let prior = null
    updateErrors(env, all => {
      prior = all[fpr.fp] ? { ...all[fpr.fp] } : null
      const e = all[fpr.fp] ?? { seen: 0, first: now, sessions: [] }
      Object.assign(e, { etype, sig: redact(fpr.sig), key, scope, files, last: now, lastCs: sid, open: true, seen: e.seen + 1, sessions: [...new Set([...e.sessions, sid])].slice(-10) })
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
    if (check) emit('check', { check: check.check, key, command: sensitive ? '' : redact(cmdText(input)).slice(0, 300), outcome: 'fail', fps: [fpr.fp], tool_use_id: input.tool_use_id })
    state.openFps = [...new Set([...(state.openFps ?? []), fpr.fp])].slice(-20)
    return cfg.inject ? failureContext(env, state, fpr.fp, prior, files) : undefined
  })
}

// T2: a failure we have seen before is worth a word right now (what fixed it, which decisions touch those files).
function failureContext(env, state, fp, prior, files) {
  if (!prior || (!prior.seen && !prior.resolved)) return
  state.t2 = state.t2 ?? {}
  if (state.t2[fp] === state.turn) return // once per error per turn
  const shown = { ...readErrors(env)[fp], open: !prior.resolved, ...(prior.resolved ? { resolved: prior.resolved } : {}) }
  const out = build({ decisions: readDecisions(env), errors: { [fp]: shown }, chat: [] }, { prompt: '', focus: new Set(files), prevOpen: [fp], sessionId: '', turn: state.turn, injected: {}, edits: [] }, { minScore: 0.01 })
  if (!out) return
  state.t2[fp] = state.turn
  return { event: 'PostToolUseFailure', additionalContext: out.text }
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
