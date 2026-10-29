// The uploader: sends the local history to the team server (POST /v1/ingest). Off unless the `upload` switch is on and
// remote.json names a server. The local files are the queue: <state>/upload.json keeps, per file, how far it has been
// read and, per session, the highest seq the server confirmed. State is saved only after a 200, so a crash resends
// at most what the server already has, and the server counts that as duplicates.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readConfig, setConfig } from './config.mjs'
import { tryLock } from './log.mjs'
import { logDir, swbSessionsDir } from './locate.mjs'
import { redact } from './redact.mjs'
import { credKey, readRemote, readUploadState, saveUploadState, stateDir, targetKey } from './remote.mjs'

const MASKED = '[가림]'
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const AT_MIN = 1577836800000
const AT_AHEAD = 5 * 60 * 1000
const FUTURE_MAX = 7 * 24 * 3600 * 1000 // further ahead than this is not a clock being off, it is a bad timestamp
const LINE_LIMIT = 1048576 - 256 // the server refuses a stored line above 1 MiB, and adds its own owner field
const WINDOW = 8 * 1024 * 1024
const MAX_BODY = 768 * 1024
const MIN_BODY = 64 * 1024
const MAX_EVENTS = 2000
const SKIP_MAX = 1000
const HOUR = 3600 * 1000
const CAPS = { requests: 64, bytes: 32 * 1024 * 1024, ms: 90000, quarantines: 20 }
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0'
  }
})()

// ---- the same checks and masking the server does (ingest.rs), so what is refused there is never sent ------------------

export function validateEvent(ev, now = Date.now()) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'shape'
  if (ev.v !== undefined && ev.v !== 1) return 'v'
  if (typeof ev.session !== 'string' || !SESSION_RE.test(ev.session)) return 'session'
  if (!Number.isSafeInteger(ev.seq) || ev.seq < 1) return 'seq'
  if (typeof ev.kind !== 'string' || Buffer.byteLength(ev.kind) < 1 || Buffer.byteLength(ev.kind) > 64 || /[\x00-\x1f\x7f-\x9f]/.test(ev.kind)) return 'kind'
  if (!Number.isSafeInteger(ev.at) || ev.at < AT_MIN) return 'at'
  if (ev.at > now + FUTURE_MAX) return 'at'
  if (ev.at > now + AT_AHEAD) return 'future' // this PC's clock was set back, or the event is from the future: wait, do not drop
  if (ev.turn !== undefined && !(Number.isInteger(ev.turn) && ev.turn >= 0 && ev.turn <= 0xffffffff)) return 'turn'
  return null
}

const STRUCTURE = new Set(['v', 'seq', 'at', 'session', 'turn', 'kind', 'owner', 'id', 'sha'])
const SECRET_NAMES = ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'api-key', 'access_key', 'accesskey', 'private_key', 'privatekey', 'credential', 'authorization']
const secretKey = k => {
  const l = String(k).toLowerCase()
  return SECRET_NAMES.some(n => l.includes(n))
}
const isTree = v => v !== null && typeof v === 'object'

function maskAll(v) {
  if (typeof v === 'string') return MASKED
  if (Array.isArray(v)) return v.map(maskAll)
  if (isTree(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskAll(x)]))
  return v
}

function maskValue(v) {
  if (typeof v === 'string') return v.length < 8 ? v : redact(v)
  if (Array.isArray(v)) return v.map(maskValue)
  if (isTree(v)) {
    // {"name": "API_TOKEN", "value": "…"}: the name says what the value is
    const named = ['name', 'key'].some(n => Object.entries(v).some(([k, x]) => k.toLowerCase() === n && typeof x === 'string' && secretKey(x)))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, named && k.toLowerCase() === 'value' ? maskAll(x) : maskEntry(k, x)]))
  }
  return v
}

const maskEntry = (k, v) => (secretKey(k) ? maskAll(v) : maskValue(v))

// Defence in depth: the server masks again. Throws when the engine that does the masking is unavailable (fail closed).
export function maskEvent(ev) {
  const out = {}
  for (const [k, v] of Object.entries(ev)) out[k] = STRUCTURE.has(k) && !isTree(v) ? v : maskEntry(k, v)
  return out
}

// ---- reading the local files -----------------------------------------------------------------------------------------

// Whole lines from `offset` on, at most `max` bytes. A line still being written (no newline yet) is left for next time.
export function readWindow(path, offset, max = WINDOW) {
  const size = statSync(path).size
  if (offset > size) offset = 0 // the file was replaced
  const len = Math.min(max, size - offset)
  if (len <= 0) return { events: [], invalid: 0, start: offset, end: offset, size }
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    let got = 0
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, offset + got)
      if (n === 0) break
      got += n
    }
  } finally {
    closeSync(fd)
  }
  let end = buf.lastIndexOf(10) + 1
  let invalid = 0
  if (end === 0) {
    if (len < max) return { events: [], invalid: 0, start: offset, end: offset, size } // the first line is still being written
    end = len // a "line" longer than the whole window: nothing to make of it
    invalid = 1
  }
  const events = []
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      invalid++
    }
  }
  return { events, invalid, start: offset, end: offset + end, size }
}

export function listSources(env, remote) {
  const out = []
  const add = (prefix, dir) => {
    if (!dir || !existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) if (name.endsWith('.jsonl')) out.push({ key: `${prefix}:${name}`, path: join(dir, name) })
  }
  add('log', logDir(env))
  if (remote.ledger) {
    let dir = null
    try {
      dir = swbSessionsDir(env)
    } catch {
      // not in a git repository: only our own log
    }
    add('swb', dir)
  }
  return out
}

// ---- the run ---------------------------------------------------------------------------------------------------------

class Stop extends Error {
  // backoffMs null: the exponential back-off (1, 2, 4 ... 60 minutes); minMs: at least this long (Retry-After)
  constructor(status, text, backoffMs, shrink = false, minMs = 0) {
    super(text)
    this.status = status
    this.text = text
    this.backoffMs = backoffMs
    this.shrink = shrink
    this.minMs = minMs
  }
}

const shortError = v => redact(String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200))

function blankState(remote) {
  return { v: 1, target: targetKey(remote), cred: credKey(remote), offsets: {}, sessions: {}, backoff: null, maxBody: MAX_BODY, last: null, error: null, totals: { sent: 0, refused_local: 0, late: 0, quarantined: 0 } }
}

function loadState(env, remote) {
  const old = readUploadState(env)
  if (!old || old.target !== targetKey(remote)) return blankState(remote) // another server or project: nothing we sent counts
  if (old.cred !== credKey(remote)) return { ...old, cred: credKey(remote), backoff: null, error: null }
  old.totals = { sent: 0, refused_local: 0, late: 0, quarantined: 0, ...(old.totals ?? {}) }
  old.maxBody = Number.isInteger(old.maxBody) ? Math.min(MAX_BODY, Math.max(MIN_BODY, old.maxBody)) : MAX_BODY
  return old
}

async function call(ctx, method, query, body) {
  ctx.lock.touch()
  ctx.requests++
  const url = `${ctx.remote.url}/v1/ingest?${query}`
  const headers = { Authorization: `Bearer ${ctx.remote.token}`, Accept: 'application/json', 'User-Agent': `vhdb-plugin/${VERSION} node/${process.versions.node}` }
  if (body) headers['Content-Type'] = 'application/x-ndjson'
  let res
  try {
    res = await ctx.fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(ctx.timeoutMs) })
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw new Stop(null, timeout ? '응답 시간 초과' : `연결 실패 ${e?.cause?.code ?? e?.name ?? ''}`.trim(), null, timeout)
  }
  let json = null
  try {
    json = JSON.parse((await res.text()).slice(0, 4096))
  } catch {
    // an HTML error page from a proxy, for instance
  }
  const ra = Number(res.headers?.get?.('retry-after'))
  return { status: res.status, json, retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 6 * 3600) * 1000 : 0 }
}

const CONFIG_BACKOFF = 6 * HOUR

// What an answer other than 200 means for the whole run (throws) or just this session (returns).
function refusal(ctx, st, sid, r, batch) {
  const text = shortError(r.json?.error ?? `HTTP ${r.status}`)
  const line = Number.isInteger(r.json?.line) ? r.json.line : null
  if (r.status === 400 && /server clock/.test(String(r.json?.error ?? ''))) {
    // This PC's clock runs more than 5 minutes ahead of the server's: nothing is lost, the lines wait until it does not
    if (line && line > 1 && line <= batch.length) {
      ctx.maxEvents = line - 1 // the lines before it are fine: send those first
      return 'retry'
    }
    throw new Stop(400, '이 PC 시계가 서버보다 5분 넘게 빠름: 시계를 맞추세요', 10 * 60 * 1000)
  }
  if ((r.status === 400 || r.status === 413) && line && line >= 1 && line <= batch.length) {
    const seq = batch[line - 1].seq
    st.skip.push(seq)
    ctx.state.totals.quarantined++
    ctx.quarantines++
    if (st.skip.length > SKIP_MAX || ctx.quarantines > ctx.caps.quarantines) {
      if (st.skip.length > SKIP_MAX) st.status = 'bad'
      throw new Stop(r.status, `서버가 줄을 계속 거부함: ${text}`, 60 * 1000)
    }
    return 'retry'
  }
  if (r.status === 409) {
    st.status = 'taken'
    return 'done'
  }
  if (r.status === 413) {
    if (/size limit/.test(String(r.json?.error ?? ''))) {
      st.status = 'full' // the server says this session has reached its size limit
      return 'done'
    }
    // a proxy in front of the server: a single event that is itself too big is set aside; otherwise smaller bodies, then fewer events
    ctx.state.okStreak = 0
    if (batch.length === 1) {
      // a small event that is refused too is not about its size: the setting or the proxy is wrong
      if (Buffer.byteLength(batch[0].line ?? '') < 16 * 1024) throw new Stop(413, '프록시가 작은 요청도 거부함: 설정을 확인', CONFIG_BACKOFF)
      st.skip.push(batch[0].seq)
      ctx.state.totals.quarantined++
      ctx.quarantines++
      if (st.skip.length > SKIP_MAX || ctx.quarantines > ctx.caps.quarantines) throw new Stop(413, '프록시가 요청을 계속 거부함', 60 * 1000)
    } else if (ctx.state.maxBody > MIN_BODY) ctx.state.maxBody = Math.max(MIN_BODY, Math.floor(ctx.state.maxBody / 2))
    else if (batch.length > 1) ctx.maxEvents = Math.ceil(batch.length / 2)
    else throw new Stop(413, '서버(또는 프록시)가 요청 크기를 거부함: 설정을 확인', CONFIG_BACKOFF)
    return 'retry'
  }
  const why = {
    400: '요청이 거부됨(프로젝트 이름이 토큰과 다름 등): 설정을 확인',
    401: '토큰이 만료·폐기됐거나 프로젝트에 묶이지 않음',
    404: '권한 없음, 프로젝트 없음, 또는 서버가 계정 모드가 아님',
    405: '서버가 업로드를 모름: 서버 버전 확인',
    411: '서버가 길이 없는 요청을 거부함',
    501: '서버가 이 요청 형식을 지원하지 않음',
  }[r.status]
  if (r.status >= 300 && r.status < 400) throw new Stop(r.status, '서버가 다른 주소로 보냄(리디렉션은 따라가지 않음): 최종 주소를 remote set 으로 설정', CONFIG_BACKOFF)
  if (why) throw new Stop(r.status, `${why} — ${text}`, CONFIG_BACKOFF)
  throw new Stop(r.status, text, null, false, [429, 503].includes(r.status) ? r.retryAfterMs : 0) // anything else: back off, try again
}

function nextBatch(ctx, todo) {
  const lines = []
  let bytes = 0
  for (const e of todo) {
    if (!e.line) {
      try {
        e.line = JSON.stringify(maskEvent(e.ev))
      } catch (err) {
        throw new Stop(null, `가림 처리 실패(보내지 않음): ${err?.name ?? 'Error'}`, 10 * 60 * 1000)
      }
      e.size = Buffer.byteLength(e.line) + 1
    }
    if (e.size > LINE_LIMIT) {
      e.drop = true
      ctx.window.refused_local++
      continue
    }
    if (lines.length > 0 && (bytes + e.size > ctx.state.maxBody || lines.length >= ctx.maxEvents)) break
    lines.push(e)
    bytes += e.size
  }
  return lines
}

async function pushSession(ctx, sid, events) {
  const fresh = ctx.state.sessions[sid] === undefined
  const st = (ctx.state.sessions[sid] ??= { high: 0, skip: [] })
  if (st.status) return 'done'
  const skip = new Set(st.skip)
  let todo = events.filter(e => e.seq > st.high && !skip.has(e.seq))
  ctx.window.late += events.length - todo.length
  if (fresh && todo.length > 500) {
    // state lost, or a long-running session starts from scratch: ask where the server is instead of sending it all
    const g = await call(ctx, 'GET', `project=${encodeURIComponent(ctx.remote.project)}&session=${encodeURIComponent(sid)}`)
    if (g.status === 200 && !Number.isSafeInteger(g.json?.high_seq)) throw new Stop(200, '서버 응답이 vhdb-server 형식이 아님: 주소(경로)를 확인', CONFIG_BACKOFF)
    if (g.status === 200) {
      st.high = g.json.high_seq
      todo = todo.filter(e => e.seq > st.high)
    } else if (refusal(ctx, st, sid, g, []) === 'done') return 'done'
  }
  while (todo.length > 0) {
    if (ctx.requests >= ctx.caps.requests || ctx.sentBytes >= ctx.caps.bytes || ctx.now() - ctx.started > ctx.caps.ms) return 'budget'
    if (!readConfig(ctx.env).upload) throw new Stop(null, '업로드가 꺼짐', null)
    const batch = nextBatch(ctx, todo)
    todo = todo.filter(e => !e.drop)
    if (batch.length === 0) break
    const body = Buffer.from(`${batch.map(e => e.line).join('\n')}\n`)
    const r = await call(ctx, 'POST', `project=${encodeURIComponent(ctx.remote.project)}`, body)
    if (r.status === 200) {
      // Only an answer in the server's own shape counts: a proxy or a wrong path prefix may answer 200 with a page
      if (!Number.isSafeInteger(r.json?.high_seq) || r.json?.session !== sid) throw new Stop(200, '서버 응답이 vhdb-server 형식이 아님: 주소(경로)를 확인', CONFIG_BACKOFF)
      st.high = Math.max(st.high, r.json.high_seq)
      ctx.state.totals.sent += Number.isInteger(r.json?.accepted) ? r.json.accepted : batch.length
      ctx.state.okStreak = (ctx.state.okStreak ?? 0) + 1
      if (ctx.state.okStreak >= 5 && ctx.state.maxBody < MAX_BODY) {
        ctx.state.maxBody = Math.min(MAX_BODY, ctx.state.maxBody * 2) // the squeeze was temporary, or the limit was raised
        ctx.state.okStreak = 0
      }
      ctx.sentBytes += body.length
      ctx.state.last = { at: ctx.now() }
      ctx.state.backoff = null
      ctx.state.error = null
      todo = todo.filter(e => e.seq > st.high)
      saveUploadState(ctx.env, ctx.state)
      continue
    }
    const what = refusal(ctx, st, sid, r, batch)
    if (what === 'retry') {
      todo = todo.filter(e => !st.skip.includes(e.seq))
      continue
    }
    return 'done'
  }
  return 'done'
}

function groupBySession(ctx, events) {
  const now = ctx.now()
  const groups = new Map()
  const hold = new Map()
  for (const ev of events) {
    const why = validateEvent(ev, now)
    if (why === 'future') {
      // Later seqs of this session wait too: the server drops any seq at or below the highest it has seen.
      ctx.window.future++
      hold.set(ev.session, Math.min(hold.get(ev.session) ?? Infinity, ev.seq))
    }
    if (why) {
      if (why !== 'future') ctx.window.refused_local++
      continue
    }
    if (!groups.has(ev.session)) groups.set(ev.session, [])
    groups.get(ev.session).push({ seq: ev.seq, ev })
  }
  for (const [sid, list] of groups) {
    list.sort((a, b) => a.seq - b.seq)
    groups.set(sid, list.filter((e, i) => (i === 0 || e.seq !== list[i - 1].seq) && e.seq < (hold.get(sid) ?? Infinity)))
  }
  for (const [sid, list] of groups) if (list.length === 0) groups.delete(sid)
  return groups
}

async function pass(ctx) {
  for (const src of listSources(ctx.env, ctx.remote)) {
    let off = ctx.state.offsets[src.key] ?? 0
    try {
      const id = statSync(src.path)
      const sig = `${id.dev}:${id.ino}`
      ctx.state.ids ??= {}
      if (ctx.state.ids[src.key] && ctx.state.ids[src.key] !== sig) {
        off = 0 // another file under the same name: read it from its start, and say so in the saved state too
        ctx.state.offsets[src.key] = 0
      }
      ctx.state.ids[src.key] = sig
    } catch {
      continue
    }
    for (;;) {
      let w
      try {
        w = readWindow(src.path, off)
      } catch {
        break // the file went away
      }
      if (w.start !== off) off = w.start
      if (w.end === off) break
      ctx.window = { refused_local: w.invalid, late: 0, future: 0 }
      let complete = true
      for (const [sid, list] of groupBySession(ctx, w.events)) {
        if ((await pushSession(ctx, sid, list)) === 'budget') {
          complete = false
          break
        }
      }
      if (!complete) return false
      if (ctx.window.future > 0) {
        // events dated ahead of this PC's own clock: kept for later, the offset stays
        ctx.state.error = { status: null, text: `시계보다 앞선 이벤트 ${ctx.window.future}개가 있어 기다림`, at: ctx.now() }
        saveUploadState(ctx.env, ctx.state)
        break // this file waits where it is; the other sources go on
      }
      off = w.end
      ctx.state.offsets[src.key] = off
      ctx.state.totals.refused_local += ctx.window.refused_local
      ctx.state.totals.late += ctx.window.late
      saveUploadState(ctx.env, ctx.state)
      if (off >= w.size) break
    }
  }
  return true
}

function wantTime(env) {
  try {
    return statSync(join(stateDir(env), 'upload.want')).mtimeMs
  } catch {
    return 0
  }
}

// Runs one upload. Returns a summary and never throws for anything the server or the network does.
//   bg: started by a hook (honours the back-off); all: keep going until everything is sent; fetchImpl/now/caps: tests.
export async function runUpload(env = process.env, opts = {}) {
  const startedAt = Date.now()
  const out = await runOnce(env, opts)
  // A turn ended between our last look at upload.want and the release of the lock: its process found us busy and left.
  if (!opts._again && !out.busy && !out.skipped && !out.stopped && wantTime(env) > startedAt) return runOnce(env, { ...opts, _again: true })
  return out
}

async function runOnce(env, opts) {
  const cfg = readConfig(env)
  if (!cfg.upload) return { ok: false, skipped: '업로드가 꺼져 있음' }
  const remote = readRemote(env)
  if (!remote.ok) return { ok: false, skipped: remote.reason }
  if (cfg.uploadTarget !== targetKey(remote)) return { ok: false, skipped: '서버·프로젝트 설정이 켤 때 확인한 것과 다름: remote on 으로 다시 켜세요' }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return { ok: false, skipped: 'NODE_TLS_REJECT_UNAUTHORIZED=0 이면 보내지 않음' }
  try {
    redact('probe-0123456789') // the masking engine must work, or nothing leaves this machine
  } catch (e) {
    return { ok: false, skipped: `가림 처리 엔진을 쓸 수 없어 보내지 않음: ${e.message}` }
  }
  mkdirSync(stateDir(env), { recursive: true })
  const lock = tryLock(join(stateDir(env), 'upload.lock'))
  if (!lock) return { ok: true, busy: true }
  const now = opts.now ?? Date.now
  try {
    const state = loadState(env, remote)
    if (opts.bg && state.backoff?.until > now()) return { ok: true, waiting: state.backoff.until }
    const caps = { ...CAPS, ...(opts.caps ?? {}) }
    if (opts.all) Object.assign(caps, { requests: Infinity, bytes: Infinity, ms: Infinity, ...(opts.caps ?? {}) })
    const ctx = { env, remote, state, lock, caps, now, fetch: opts.fetchImpl ?? globalThis.fetch, timeoutMs: opts.timeoutMs ?? 25000, started: now(), maxEvents: MAX_EVENTS, requests: 0, sentBytes: 0, quarantines: 0, window: { refused_local: 0, late: 0 } }
    const before = state.totals.sent
    let stopped = null
    try {
      // A turn that ends while we are busy leaves a newer upload.want behind: look once more, a few times at most.
      for (let passes = 0; passes < 3; passes++) {
        const startedAt = now()
        if (!(await pass(ctx))) break
        if (wantTime(env) <= startedAt) break
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e
      stopped = e
      state.error = { status: e.status, text: e.text, at: now() }
      if (e.shrink) state.maxBody = Math.max(MIN_BODY, Math.floor(state.maxBody / 2))
      if (e.text !== '업로드가 꺼짐') {
        const exp = Math.min(60, 2 ** Math.min(6, state.backoff?.step ?? 0)) * 60 * 1000
        state.backoff = { until: now() + Math.max(e.backoffMs ?? exp, e.minMs), step: (state.backoff?.step ?? 0) + 1 }
      }
      saveUploadState(env, state)
    }
    saveUploadState(env, state)
    return { ok: !stopped, sent: state.totals.sent - before, requests: ctx.requests, stopped: stopped ? { status: stopped.status, text: stopped.text } : null, totals: state.totals }
  } finally {
    lock.release()
  }
}

// What would be sent, without the network and without touching the state: per session and reason counts only.
export function dryRun(env = process.env) {
  const remote = readRemote(env)
  if (!remote.ok) return { ok: false, skipped: remote.reason }
  const state = readUploadState(env)
  const offsets = state?.target === targetKey(remote) ? state.offsets : {}
  const sessions = {}
  const refused = {}
  let files = 0
  let events = 0
  const now = Date.now()
  for (const src of listSources(env, remote)) {
    files++
    let off = offsets[src.key] ?? 0
    for (;;) {
      const w = readWindow(src.path, off)
      if (w.end === w.start) break
      if (w.invalid) refused.json = (refused.json ?? 0) + w.invalid
      for (const ev of w.events) {
        events++
        const why = validateEvent(ev, now)
        if (why) refused[why] = (refused[why] ?? 0) + 1
        else sessions[ev.session] = (sessions[ev.session] ?? 0) + 1
      }
      off = w.end
      if (off >= w.size) break
    }
  }
  return { ok: true, files, events, sessions: Object.keys(sessions).length, sendable: Object.values(sessions).reduce((a, b) => a + b, 0), refused }
}

// Marks everything that exists now as already handled, for "only from now on".
export function skipExisting(env = process.env) {
  const remote = readRemote(env)
  if (!remote.ok) throw new Error(remote.reason)
  const state = loadState(env, remote)
  state.ids ??= {}
  for (const src of listSources(env, remote)) {
    const st = statSync(src.path)
    state.offsets[src.key] = st.size
    state.ids[src.key] = `${st.dev}:${st.ino}`
  }
  saveUploadState(env, state)
}

// For commands that change the upload state by hand: not while an uploader runs (it would overwrite the change).
export function withUploadLock(env, fn) {
  mkdirSync(stateDir(env), { recursive: true })
  const lock = tryLock(join(stateDir(env), 'upload.lock'))
  if (!lock) throw new Error('업로드가 진행 중입니다. 잠시 뒤에 다시 하세요')
  try {
    return fn()
  } finally {
    lock.release()
  }
}

// Switches upload on. Callers make sure a person asked for it (a terminal); `fromNow` marks what exists as handled.
export function enableUpload(env = process.env, { fromNow = false } = {}) {
  const remote = readRemote(env)
  if (!remote.ok) throw new Error(remote.reason)
  withUploadLock(env, () => {
    if (fromNow) skipExisting(env)
    setConfig(true, ['upload'], env, { uploadTarget: targetKey(remote) })
  })
  return remote
}
