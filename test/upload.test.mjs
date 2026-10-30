import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readConfig, setConfig } from '../lib/config.mjs'
import { handle } from '../lib/hooks.mjs'
import { tryLock, withSession } from '../lib/log.mjs'
import { describeUpload, readRemote, readUploadState, saveUploadState, validateUrl, writeRemote } from '../lib/remote.mjs'
import { dryRun, enableUpload, maskEvent, readWindow, runUpload, validateEvent } from '../lib/upload.mjs'
import { WASM } from './fixture.mjs'

const CLI = fileURLToPath(new URL('../bin/vhdb.mjs', import.meta.url))
const MCP = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
const TOKEN = 'vhdb_abcd1234_SecretSecretSecretSecretSecretSecret0123'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

// A server that behaves like the real one where it matters to the client (ingest.rs), and can be told to misbehave.
function fakeServer() {
  const S = { token: TOKEN, project: 'alpha', data: new Map(), owners: new Map(), requests: [], script: [], delay: 0, reject: null, maxBody: Infinity, ticks: 0, clock: () => Date.now() }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const u = new URL(req.url, 'http://x')
    S.requests.push({ method: req.method, path: u.pathname, search: u.search, auth: req.headers.authorization, ct: req.headers['content-type'], len: req.headers['content-length'], te: req.headers['transfer-encoding'], ua: req.headers['user-agent'], body: body.toString() })
    if (S.delay) await sleep(S.delay)
    const send = (status, obj, headers = {}) => res.writeHead(status, { 'content-type': typeof obj === 'string' ? 'text/html' : 'application/json', ...headers }).end(typeof obj === 'string' ? obj : JSON.stringify(obj))
    const scripted = S.script[0] && (!S.script[0].method || S.script[0].method === req.method) ? S.script.shift() : null
    if (scripted) return send(scripted.status, scripted.body ?? { error: 'scripted' }, scripted.headers)
    if (req.headers.authorization !== `Bearer ${S.token}`) return send(401, { error: 'unauthorized' })
    const projects = u.searchParams.getAll('project')
    if (projects.length !== 1 || projects[0] !== S.project) return send(400, { error: 'project must be the one this token was issued for' })
    if (u.pathname !== '/v1/ingest') return send(404, { error: 'not found' })
    const user = 'uone'
    if (req.method === 'GET') {
      const s = u.searchParams.get('session') ?? ''
      if (S.owners.has(s) && S.owners.get(s) !== user) return send(409, { error: 'this session id is taken' })
      return send(200, { session: s, high_seq: S.data.get(s)?.at(-1)?.seq ?? 0 })
    }
    if (!req.headers['content-length']) return send(411, { error: 'Content-Length is required' })
    if (body.length > S.maxBody) return send(413, '<html>413 Request Entity Too Large</html>')
    let session = null
    const lines = body.toString().split('\n')
    const events = []
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      const bad = m => send(400, { error: m, line: i + 1 })
      let ev
      try {
        ev = JSON.parse(lines[i])
      } catch {
        return bad('not JSON')
      }
      if (typeof ev?.session !== 'string' || !SESSION_RE.test(ev.session)) return bad('session')
      if (session && ev.session !== session) return bad('one session')
      session = ev.session
      if (!Number.isInteger(ev.seq) || ev.seq < 1) return bad('seq')
      if (!Number.isInteger(ev.at) || ev.at < 1577836800000 || ev.at > S.clock() + 300000) return bad('at')
      if (S.reject && lines[i].includes(S.reject)) return bad('refused by the server')
      events.push(ev)
    }
    if (!session) return send(400, { error: 'the upload has no events' })
    if (S.owners.has(session) && S.owners.get(session) !== user) return send(409, { error: 'this session id is taken' })
    S.owners.set(session, user)
    const stored = S.data.get(session) ?? []
    let high = stored.at(-1)?.seq ?? 0
    let accepted = 0
    let duplicate = 0
    for (const ev of events) {
      if (ev.seq <= high) duplicate++
      else {
        stored.push(ev)
        high = ev.seq
        accepted++
      }
    }
    S.data.set(session, stored)
    return send(200, { session, accepted, duplicate, high_seq: high })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      after(() => server.close())
      resolve({ S, url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, close: () => server.close() })
    })
  })
}

// spawnSync would freeze this process, and the fake server with it: the CLI is run asynchronously.
function exec(env, args, input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', c => (stdout += c))
    child.stderr.on('data', c => (stderr += c))
    child.on('close', status => resolve({ status, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}

const total = S => [...S.data.values()].reduce((n, l) => n + l.length, 0)
const ev = (session, seq, extra = {}) => ({ v: 1, seq, at: Date.now() - 1000, session, turn: 1, kind: 'reply', text: `t${seq}`, ...extra })

// A repository stand-in: our dir, a swb sessions dir, upload on, remote.json written.
function repo(srv, { ledger = true, on = true, token = TOKEN } = {}) {
  const top = mkdtempSync(join(tmpdir(), 'vhdb-up-'))
  const swb = join(top, 'sessions')
  mkdirSync(swb, { recursive: true })
  const env = { VHDB_DIR: join(top, 'vhdb'), VHDB_SWB_SESSIONS: swb, VHDB_WASM: WASM, VHDB_NO_BG: '1' }
  if (srv) writeRemote(env, { url: srv.url, project: 'alpha', token, ledger })
  if (on) {
    if (srv) enableUpload(env)
    else setConfig(true, ['upload'], env)
  }
  const ledgerFile = (name, events) => appendFileSync(join(swb, name), events.map(e => `${JSON.stringify(e)}\n`).join(''))
  return { top, swb, env, ledgerFile }
}

test('validateEvent follows the server rules and maskEvent removes secrets under any shape', () => {
  const now = Date.now()
  assert.equal(validateEvent(ev('s1', 1), now), null)
  const cases = [
    [{ ...ev('s1', 1), v: 2 }, 'v'], [ev('../x', 1), 'session'], [ev('', 1), 'session'], [ev('s', 0), 'seq'], [ev('s', 1.5), 'seq'],
    [ev('s', 1, { kind: '' }), 'kind'], [ev('s', 1, { kind: 'a'.repeat(65) }), 'kind'], [ev('s', 1, { at: 5 }), 'at'], [ev('s', 1, { at: now + 6 * 60 * 1000 }), 'future'],
    [ev('s', 1, { turn: -1 }), 'turn'], [[1], 'shape'], [null, 'shape'],
  ]
  for (const [e, why] of cases) assert.equal(validateEvent(e, now), why, JSON.stringify(e).slice(0, 60))
  const m = maskEvent({ seq: 3, session: 's', id: 'keep', text: 'key sk-abcdefghijklmnopqrstuvwxyz0123 here', input: { password: ['p1', { deep: 'p2' }], env: [{ Name: 'API_TOKEN', Value: 'p3' }, { name: 'HOME', value: '/home/x' }], n: 7 }, tokens: 3 })
  const text = JSON.stringify(m)
  for (const leaked of ['sk-abc', 'p1', 'p2', 'p3']) assert.ok(!text.includes(leaked), leaked)
  assert.equal(m.id, 'keep')
  assert.equal(m.input.env[1].value, '/home/x')
  assert.equal(m.input.n, 7)
  assert.equal(m.tokens, 3)
})

test('remote.json: https only (loopback http allowed), 0600, wide permissions ignored, env token only as a fallback, nothing printed', () => {
  for (const bad of ['http://example.com', 'ftp://x', 'https://u:p@example.com', 'https://example.com/?a=1', 'https://example.com/#x', 'nonsense']) assert.equal(validateUrl(bad).ok, false, bad)
  for (const good of ['https://example.com/', 'http://127.0.0.1:7600', 'http://localhost', 'https://example.com/vhdb/']) assert.equal(validateUrl(good).ok, true, good)
  assert.equal(validateUrl('https://example.com/vhdb/').url, 'https://example.com/vhdb')
  const r = repo({ url: 'https://example.com' }, { on: false })
  const path = join(r.env.VHDB_DIR, 'remote.json')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(readRemote(r.env).ok, true)
  assert.throws(() => writeRemote(r.env, { url: 'http://example.com', project: 'alpha', token: TOKEN }), /https/)
  assert.throws(() => writeRemote(r.env, { url: 'https://example.com', project: 'alpha', token: 'nope' }), /토큰/)
  // a missing token keeps the one already stored
  writeRemote(r.env, { url: 'https://example.com', project: 'beta' })
  assert.equal(readRemote(r.env).token, TOKEN)
  assert.equal(readRemote(r.env).project, 'beta')
  // the environment variable fills in only where the file has none
  const other = TOKEN.replace('abcd1234', 'zzzz9999')
  assert.equal(readRemote({ ...r.env, VHDB_REMOTE_TOKEN: other }).token, TOKEN)
  const bare = repo(null, { on: false })
  writeRemote(bare.env, { url: 'https://example.com', project: 'alpha' })
  assert.equal(readRemote(bare.env).ok, false)
  assert.equal(readRemote({ ...bare.env, VHDB_REMOTE_TOKEN: other }).tokenSource, 'env')
  // too wide: not used, and the status says so
  spawnSync('chmod', ['644', path])
  const wide = readRemote(r.env)
  assert.equal(wide.ok, false)
  assert.match(wide.reason, /chmod 600/)
  assert.ok(!describeUpload(r.env, { upload: true }).includes(TOKEN))
})

test('happy path: our log and the ledger go out, one session per request, framed properly, and a second run sends nothing', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', Array.from({ length: 100 }, (_, i) => ev('sess0001-abcd', i + 1)))
  r.ledgerFile('s2.jsonl', Array.from({ length: 5 }, (_, i) => ev('sess0002-efgh', i + 1)))
  withSession(r.env, 'claude-a', ({ emit }) => emit('turn.end', { files: ['a.ts'] }))
  withSession(r.env, 'claude-b', ({ emit }) => emit('decision', { id: 'd-1', topic: 't' }))
  const out = await runUpload(r.env)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(total(srv.S), 107)
  assert.deepEqual([...srv.S.data.keys()].sort(), ['sess0001-abcd', 'sess0002-efgh', 'vhdb-claude-a', 'vhdb-claude-b'])
  for (const q of srv.S.requests) {
    assert.equal(q.auth, `Bearer ${TOKEN}`)
    assert.equal(q.ct, 'application/x-ndjson')
    assert.ok(Number(q.len) === Buffer.byteLength(q.body) && q.te === undefined, 'a Content-Length, never chunked')
    assert.match(q.ua, /^vhdb-plugin\/\S+ node\//)
    assert.equal(new URLSearchParams(q.search).getAll('project').join(), 'alpha')
    assert.equal(new Set(q.body.split('\n').filter(Boolean).map(l => JSON.parse(l).session)).size, 1)
  }
  const before = srv.S.requests.length
  appendFileSync(join(r.swb, 's1.jsonl'), '{"torn":')
  assert.equal((await runUpload(r.env)).sent, 0)
  assert.equal(srv.S.requests.length, before, 'nothing new, nothing sent (a half-written line waits)')
  r.ledgerFile('s2.jsonl', [ev('sess0002-efgh', 6)])
  assert.equal((await runUpload(r.env)).sent, 1)
  const st = readUploadState(r.env)
  assert.equal(st.totals.sent, 108)
})

test('a failure in the middle resumes where it stopped, and a lost state only costs duplicates', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  r.ledgerFile('big.jsonl', Array.from({ length: 5000 }, (_, i) => ev('big0001-aaaa', i + 1, { text: 'x'.repeat(400) })))
  const first = await runUpload(r.env, { caps: { requests: 2 } })
  assert.equal(first.requests, 2, 'asking where the server is, then one batch')
  assert.ok(srv.S.data.get('big0001-aaaa').length > 0 && srv.S.data.get('big0001-aaaa').length < 5000)
  srv.S.script.push({ status: 503, body: { error: 'busy' } })
  const failed = await runUpload(r.env)
  assert.equal(failed.ok, false)
  assert.equal(failed.stopped.status, 503)
  const bo = readUploadState(r.env).backoff
  assert.ok(bo.until > Date.now(), 'backs off after a 5xx')
  assert.equal((await runUpload(r.env, { bg: true })).waiting, bo.until, 'a hook-started run waits')
  const done = await runUpload(r.env, { all: true }) // a person asking: no waiting
  assert.equal(done.ok, true)
  assert.equal(srv.S.data.get('big0001-aaaa').length, 5000)
  const n = total(srv.S)
  // the state is lost (or rolled back): everything is read again, the server counts duplicates, nothing changes
  const st = readUploadState(r.env)
  st.offsets = {}
  st.sessions = {}
  saveUploadState(r.env, st)
  await runUpload(r.env, { all: true })
  assert.equal(total(srv.S), n)
  const gets = srv.S.requests.filter(q => q.method === 'GET')
  assert.ok(gets.length >= 1 && gets[0].search.includes('session=big0001-aaaa'), 'a big session asks where the server is first')
})

test('lines the server would refuse are not sent; a line only the server refuses is set aside and never retried', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', [ev('good0001-aaaa', 1), ev('good0001-aaaa', 2, { at: 5 }), ev('../evil', 1), ev('good0001-aaaa', 3, { text: 'POISON' }), ev('good0001-aaaa', 4)])
  appendFileSync(join(r.swb, 's1.jsonl'), 'not json\n')
  srv.S.reject = 'POISON'
  const out = await runUpload(r.env)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(srv.S.data.get('good0001-aaaa').map(e => e.seq), [1, 4])
  assert.ok(!srv.S.data.has('../evil'))
  const st = readUploadState(r.env)
  assert.equal(st.totals.refused_local, 3, 'bad at, bad session id, a line that is not JSON')
  assert.equal(st.totals.quarantined, 1)
  assert.deepEqual(st.sessions['good0001-aaaa'].skip, [3])
  const n = srv.S.requests.length
  await runUpload(r.env)
  assert.equal(srv.S.requests.length, n, 'no retry of the set-aside line')
})

test('409 shuts out that session only; 401, 404 and a wrong project stop the run and back off for hours; a new token starts over', async () => {
  const srv = await fakeServer()
  srv.S.owners.set('taken001-aaaa', 'someone-else')
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', [ev('taken001-aaaa', 1), ev('free0001-bbbb', 1)])
  assert.equal((await runUpload(r.env)).ok, true)
  assert.deepEqual([...srv.S.data.keys()], ['free0001-bbbb'])
  assert.equal(readUploadState(r.env).sessions['taken001-aaaa'].status, 'taken')
  assert.match(describeUpload(r.env, { upload: true }), /이미 남이 쓰는 세션 1/)
  const n = srv.S.requests.length
  r.ledgerFile('s1.jsonl', [ev('taken001-aaaa', 2)])
  await runUpload(r.env)
  assert.equal(srv.S.requests.length, n, 'no further request for a taken session')

  // 401
  const bad = repo(srv, { token: TOKEN.replace('Secret', 'Wrongg') })
  bad.ledgerFile('s1.jsonl', [ev('other001-cccc', 1)])
  let out = await runUpload(bad.env)
  assert.equal(out.stopped.status, 401)
  const q = srv.S.requests.length
  assert.equal((await runUpload(bad.env, { bg: true })).waiting > Date.now() + 5 * 3600 * 1000, true)
  assert.equal(srv.S.requests.length, q, 'no request while backed off')
  // the token is replaced: the back-off is gone
  writeRemote(bad.env, { url: srv.url, project: 'alpha', token: TOKEN })
  out = await runUpload(bad.env, { bg: true })
  assert.equal(out.ok, true)
  assert.equal(srv.S.data.get('other001-cccc').length, 1)

  // wrong project (the token is for another one): a 400 without a line
  const wrong = repo(srv)
  writeRemote(wrong.env, { url: srv.url, project: 'beta' })
  enableUpload(wrong.env)
  wrong.ledgerFile('s1.jsonl', [ev('other002-dddd', 1)])
  out = await runUpload(wrong.env)
  assert.equal(out.stopped.status, 400)
  assert.ok(readUploadState(wrong.env).backoff.until > Date.now() + 5 * 3600 * 1000)

  // 404, 405, 411, 501
  for (const status of [404, 405, 411, 501]) {
    const x = repo(srv)
    x.ledgerFile('s1.jsonl', [ev(`code${status}-aaaa`, 1)])
    srv.S.script.push({ status, body: { error: 'nope' } })
    out = await runUpload(x.env)
    assert.equal(out.stopped.status, status)
    assert.ok(readUploadState(x.env).backoff.until > Date.now() + 5 * 3600 * 1000, String(status))
  }
})

test('a 413 from a proxy halves the body size until it fits; a timeout shrinks it too', async () => {
  const srv = await fakeServer()
  srv.S.maxBody = 150 * 1024
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', Array.from({ length: 600 }, (_, i) => ev('prox0001-aaaa', i + 1, { text: 'y'.repeat(900) })))
  const out = await runUpload(r.env, { all: true })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(srv.S.data.get('prox0001-aaaa').length, 600)
  assert.ok(srv.S.requests.length > 4, 'it had to squeeze')

  const slow = await fakeServer()
  slow.S.delay = 400
  const t = repo(slow)
  t.ledgerFile('s1.jsonl', [ev('slow0001-aaaa', 1)])
  const res = await runUpload(t.env, { timeoutMs: 100 })
  assert.equal(res.ok, false)
  assert.match(res.stopped.text, /시간 초과/)
  assert.ok(readUploadState(t.env).maxBody < 768 * 1024)
  assert.ok(readUploadState(t.env).backoff.until > Date.now())
})

test('one event that is too big for a proxy is set aside; the session goes on', async () => {
  const srv = await fakeServer()
  srv.S.maxBody = 70 * 1024
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', [ev('fat00001-aaaa', 1), ev('fat00001-aaaa', 2, { text: 'z'.repeat(100 * 1024) }), ev('fat00001-aaaa', 3), ev('fat00001-aaaa', 4)])
  const out = await runUpload(r.env, { all: true })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(srv.S.data.get('fat00001-aaaa').map(e => e.seq), [1, 3, 4])
  const st = readUploadState(r.env)
  assert.deepEqual(st.sessions['fat00001-aaaa'].skip, [2])
  assert.equal(st.sessions['fat00001-aaaa'].status, undefined, 'the session is not shut out')
  // the server's own "session is full" is a different thing
  const full = await fakeServer()
  full.S.script.push({ status: 413, body: { error: 'this session has reached its size limit' } })
  const f = repo(full)
  f.ledgerFile('s1.jsonl', [ev('full0001-aaaa', 1)])
  await runUpload(f.env)
  assert.equal(readUploadState(f.env).sessions['full0001-aaaa'].status, 'full')
})

test('a 200 that is not the server (a page from a proxy) is not a success; the clock ahead of the server stops the run without losing lines', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', [ev('page0001-aaaa', 1), ev('page0001-aaaa', 2)])
  srv.S.script.push({ status: 200, body: '<html>welcome</html>' })
  const out = await runUpload(r.env)
  assert.equal(out.stopped.status, 200)
  assert.match(out.stopped.text, /형식이 아님/)
  const st = readUploadState(r.env)
  assert.equal(st.sessions['page0001-aaaa'].high, 0, 'nothing is recorded as sent')
  assert.ok(st.backoff.until > Date.now() + 5 * 3600 * 1000)
  assert.equal((await runUpload(r.env, { all: true })).ok, true, 'once the server answers properly, everything goes')
  assert.equal(srv.S.data.get('page0001-aaaa').length, 2)

  // the server finds the lines too far ahead of ITS clock: wait, do not set them aside
  const ahead = await fakeServer()
  const a = repo(ahead)
  a.ledgerFile('s1.jsonl', [ev('clock001-aaaa', 1), ev('clock001-aaaa', 2)])
  ahead.S.script.push({ status: 400, body: { error: 'at must be milliseconds since the epoch, not before 2020 and not ahead of the server clock', line: 1 } })
  const res = await runUpload(a.env)
  assert.match(res.stopped.text, /시계/)
  const as = readUploadState(a.env)
  assert.deepEqual(as.sessions['clock001-aaaa']?.skip ?? [], [])
  assert.equal(as.totals.quarantined, 0)
  assert.equal((await runUpload(a.env, { all: true })).ok, true)
  assert.equal(ahead.S.data.get('clock001-aaaa').length, 2)
})

test('events dated ahead of this PC are kept for later, other client errors back off, Retry-After is honoured, the body size grows back', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  const t0 = Date.now()
  r.ledgerFile('s1.jsonl', [ev('futu0001-aaaa', 1), ev('futu0001-aaaa', 2, { at: t0 + 3600 * 1000 }), ev('futu0001-aaaa', 3)])
  let out = await runUpload(r.env)
  assert.equal(out.ok, true)
  assert.equal(srv.S.data.get('futu0001-aaaa')?.length ?? 0, 1, 'the sendable line before it went; the window waits')
  assert.equal(readUploadState(r.env).totals.refused_local, 0)
  srv.S.clock = () => t0 + 2 * 3600 * 1000
  out = await runUpload(r.env, { now: () => t0 + 2 * 3600 * 1000, all: true })
  srv.S.clock = () => Date.now()
  assert.equal(srv.S.data.get('futu0001-aaaa').length, 3, 'the clock caught up')

  const x = repo(srv)
  x.ledgerFile('s1.jsonl', [ev('err40001-aaaa', 1)])
  srv.S.script.push({ status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '7200' } })
  out = await runUpload(x.env)
  assert.equal(out.stopped.status, 429)
  assert.ok(readUploadState(x.env).backoff.until > Date.now() + 3600 * 1000, 'Retry-After wins over the first small step')
  const y = repo(srv)
  y.ledgerFile('s1.jsonl', [ev('err40002-aaaa', 1)])
  srv.S.script.push({ status: 403, body: '<html>blocked</html>' })
  out = await runUpload(y.env)
  assert.equal(out.stopped.status, 403)
  const until = readUploadState(y.env).backoff.until
  assert.ok(until > Date.now() && until < Date.now() + 3 * 60 * 1000, 'an unlisted 4xx backs off a minute, it does not retry every turn')

  const z = repo(srv)
  z.ledgerFile('s1.jsonl', Array.from({ length: 12 }, (_, i) => ev('grow0001-aaaa', i + 1, { text: 'g'.repeat(50 * 1024) })))
  saveUploadState(z.env, { v: 1, target: 'x', cred: 'x', offsets: {}, sessions: {}, backoff: null, maxBody: 64 * 1024, last: null, error: null, totals: {} })
  writeRemote(z.env, { url: srv.url, project: 'alpha', token: TOKEN })
  const first = await runUpload(z.env, { all: true })
  assert.equal(first.ok, true)
  assert.ok(readUploadState(z.env).maxBody > 64 * 1024 || srv.S.data.get('grow0001-aaaa').length === 12)
})

test('changing the server or project switches upload off; the state is not edited while an uploader runs', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  const exec2 = (args, input) => exec(r.env, args, input)
  assert.equal(readConfig(r.env).upload, true)
  const p = await exec2(['remote', 'set', '--url', srv.url, '--project', 'other'], `${TOKEN}\n`)
  assert.equal(p.status, 0, p.stderr)
  assert.match(p.stdout, /업로드를 껐습니다/)
  assert.equal(readConfig(r.env).upload, false)
  enableUpload(r.env)
  // same address and project: it stays on
  const q = await exec2(['remote', 'set', '--url', srv.url, '--project', 'other'], `${TOKEN}\n`)
  assert.equal(q.status, 0)
  assert.equal(readConfig(r.env).upload, true)
  // a running uploader holds the lock: reset and --from-now refuse
  mkdirSync(join(r.env.VHDB_DIR, 'state'), { recursive: true })
  writeFileSync(join(r.env.VHDB_DIR, 'state', 'upload.lock'), `${process.pid}@${hostname()}`)
  const busy = await exec2(['remote', 'reset'])
  assert.equal(busy.status, 1)
  assert.match(busy.stderr, /진행 중/)
  assert.throws(() => enableUpload(r.env, { fromNow: true }), /진행 중/)
})

test('a nonsense timestamp is just filtered, a replaced file is read from its start, a clock 400 at line 3 sends the first two first', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  r.ledgerFile('a.jsonl', [ev('nons0001-aaaa', 1), ev('nons0001-aaaa', 2, { at: Date.UTC(2099, 0, 1) }), ev('nons0001-aaaa', 3)])
  r.ledgerFile('b.jsonl', [ev('othr0001-bbbb', 1)])
  const out = await runUpload(r.env)
  assert.equal(out.ok, true)
  assert.equal(srv.S.data.get('othr0001-bbbb').length, 1, 'a bad line in one file does not hold the others back')
  assert.deepEqual(srv.S.data.get('nons0001-aaaa').map(e => e.seq), [1, 3])
  assert.equal(readUploadState(r.env).totals.refused_local, 1)

  // the file is replaced by a bigger one under the same name, and the run ends before it is through
  const big = Array.from({ length: 400 }, (_, i) => ev('repl0001-cccc', i + 1, { text: 'r'.repeat(2000) }))
  const tmp = join(r.swb, 'c.new')
  writeFileSync(join(r.swb, 'c.jsonl'), `${JSON.stringify(ev('repl0000-cccc', 1))}\n`)
  await runUpload(r.env)
  writeFileSync(tmp, big.map(e => `${JSON.stringify(e)}\n`).join(''))
  const { renameSync } = await import('node:fs')
  renameSync(tmp, join(r.swb, 'c.jsonl'))
  await runUpload(r.env, { caps: { requests: 1 } })
  await runUpload(r.env, { all: true })
  assert.equal(srv.S.data.get('repl0001-cccc').length, 400, 'nothing of the new file was skipped')

  // a server clock complaint about line 3 of 5: the two before it go, nothing is set aside
  const clk = await fakeServer()
  const c = repo(clk)
  c.ledgerFile('s1.jsonl', Array.from({ length: 5 }, (_, i) => ev('clk30001-aaaa', i + 1)))
  clk.S.script.push({ status: 400, body: { error: 'at must be ... not ahead of the server clock', line: 3 } })
  await runUpload(c.env, { all: true })
  assert.equal(clk.S.requests.filter(q => q.method === 'POST')[1].body.split('\n').filter(Boolean).length, 2)
  assert.equal(clk.S.data.get('clk30001-aaaa').length, 5)
  assert.equal(readUploadState(c.env).totals.quarantined, 0)
})

test('the approved target: editing remote.json by hand stops the upload; --from-ui and status --json work without a terminal', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', [ev('appr0001-aaaa', 1)])
  const path = join(r.env.VHDB_DIR, 'remote.json')
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, `${JSON.stringify({ ...doc, project: 'elsewhere' })}\n`, { mode: 0o600 })
  const out = await runUpload(r.env)
  assert.match(out.skipped, /다시 켜세요/)
  assert.equal(srv.S.requests.length, 0)

  const q = repo(srv, { on: false })
  const status = async () => JSON.parse((await exec(q.env, ['remote', 'show', '--json'])).stdout)
  let j = await status()
  assert.deepEqual([j.upload, j.configured, j.ready, j.url, j.project], [false, true, true, srv.url, 'alpha'])
  assert.ok(!JSON.stringify(j).includes('SecretSecret'))
  assert.equal((await exec(q.env, ['remote', 'on'])).status, 1, 'a plain script is refused')
  assert.equal((await exec(q.env, ['remote', 'on', '--from-ui'])).status, 1, 'without an approval the flag does nothing')
  assert.equal(readConfig(q.env).upload, false)
  mkdirSync(join(q.env.VHDB_DIR, 'state'), { recursive: true })
  writeFileSync(join(q.env.VHDB_DIR, 'state', 'ui-approval'), '')
  const p = await exec(q.env, ['remote', 'on', '--from-ui', '--from-now'])
  assert.equal(p.status, 0, p.stderr)
  assert.ok(!existsSync(join(q.env.VHDB_DIR, 'state', 'ui-approval')), 'the approval is used up')
  await exec(q.env, ['remote', 'off'])
  assert.equal((await exec(q.env, ['remote', 'on', '--from-ui'])).status, 1, 'and it works once')
  writeFileSync(join(q.env.VHDB_DIR, 'state', 'ui-approval'), '')
  await exec(q.env, ['remote', 'on', '--from-ui'])
  assert.match(p.stdout, /프롬프트·응답/)
  j = await status()
  assert.equal(j.upload, true)
  assert.equal(j.approved, true)
  await exec(q.env, ['remote', 'off'])
  assert.equal((await status()).upload, false)
})

test('a server that is down, a redirect and a switch that is off: no crash, no request where none belongs', async () => {
  const srv = await fakeServer()
  const port = srv.port
  srv.close()
  await sleep(50)
  const down = repo({ url: `http://127.0.0.1:${port}` })
  down.ledgerFile('s1.jsonl', [ev('down0001-aaaa', 1)])
  const out = await runUpload(down.env)
  assert.equal(out.ok, false)
  assert.match(out.stopped.text, /연결 실패/)
  assert.ok(readUploadState(down.env).backoff.until > Date.now())

  const target = await fakeServer()
  const bounce = await fakeServer()
  bounce.S.script.push({ status: 302, body: '', headers: { location: `${target.url}/v1/ingest?project=alpha` } })
  const b = repo(bounce)
  b.ledgerFile('s1.jsonl', [ev('redir001-aaaa', 1)])
  const res = await runUpload(b.env)
  assert.equal(res.stopped.status, 302)
  assert.equal(target.S.requests.length, 0, 'a redirect is not followed (the token would go along)')

  const off = repo(target, { on: false })
  off.ledgerFile('s1.jsonl', [ev('off00001-aaaa', 1)])
  assert.equal((await runUpload(off.env)).skipped, '업로드가 꺼져 있음')
  assert.equal(target.S.requests.length, 0)
})

test('only one uploader runs at a time; a dead one is taken over', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', [ev('lock0001-aaaa', 1)])
  mkdirSync(join(r.env.VHDB_DIR, 'state'), { recursive: true })
  const lockPath = join(r.env.VHDB_DIR, 'state', 'upload.lock')
  writeFileSync(lockPath, `${process.pid}@${hostname()}`)
  assert.equal((await runUpload(r.env)).busy, true)
  assert.equal(srv.S.requests.length, 0)
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString()
  writeFileSync(lockPath, `${dead}@${hostname()}`)
  assert.equal((await runUpload(r.env)).ok, true)
  assert.equal(total(srv.S), 1)
  assert.equal(existsSync(lockPath), false, 'released at the end')
  const a = tryLock(join(r.top, 'x.lock'))
  assert.ok(a)
  assert.equal(tryLock(join(r.top, 'x.lock')), null)
  a.release()
  assert.ok(tryLock(join(r.top, 'x.lock')))
})

test('secrets are masked before they leave, and the token appears nowhere but remote.json', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  r.ledgerFile('s1.jsonl', [ev('mask0001-aaaa', 1, { text: 'key sk-abcdefghijklmnopqrstuvwxyz0123 ok', input: { password: 'hunter2hunter2' } })])
  await runUpload(r.env)
  const sent = srv.S.requests.map(q => q.body).join('')
  assert.ok(!sent.includes('sk-abc') && !sent.includes('hunter2'))
  // CLI output, status text and every file under our directory, on the success path and on the failure path
  const texts = []
  const cli = async (...args) => {
    const p = await exec(r.env, args)
    texts.push(p.stdout, p.stderr)
    return p
  }
  assert.equal((await cli('remote', 'check')).status, 0)
  await cli('remote', 'show')
  await cli('upload', '--dry-run')
  srv.S.token = 'something-else'
  r.ledgerFile('s1.jsonl', [ev('mask0001-aaaa', 2)])
  const failed = await runUpload(r.env)
  assert.equal(failed.stopped.status, 401)
  texts.push(describeUpload(r.env, { upload: true }), JSON.stringify(failed))
  for (const t of texts) assert.ok(!t.includes(TOKEN) && !t.includes('SecretSecret'), 'token in output')
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
  for (const f of walk(r.env.VHDB_DIR)) {
    if (f.endsWith('remote.json')) continue
    assert.ok(!readFileSync(f, 'utf8').includes('SecretSecret'), f)
  }
})

test('the CLI: --token is refused, the token comes from stdin, on/off/clear/reset do what they say', async () => {
  const srv = await fakeServer()
  const r = repo(null, { on: false })
  const run = (args, input) => exec(r.env, args, input)
  let p = await run(['remote', 'set', '--url', srv.url, '--project', 'alpha', '--token', TOKEN])
  assert.equal(p.status, 1)
  assert.match(p.stderr, /표준입력/)
  assert.ok(!existsSync(join(r.env.VHDB_DIR, 'remote.json')))
  p = await run(['remote', 'set', '--url', 'http://example.com', '--project', 'alpha'], TOKEN)
  assert.equal(p.status, 1)
  p = await run(['remote', 'set', '--url', srv.url, '--project', 'alpha'], `${TOKEN}\n`)
  assert.equal(p.status, 0, p.stderr)
  assert.equal(statSync(join(r.env.VHDB_DIR, 'remote.json')).mode & 0o777, 0o600)
  assert.ok(!p.stdout.includes(TOKEN))
  r.ledgerFile('s1.jsonl', [ev('cli00001-aaaa', 1), ev('cli00001-aaaa', 2)])
  p = await run(['upload', '--dry-run'])
  assert.match(p.stdout, /보낼 수 있는 이벤트 2개/)
  assert.equal((await run(['upload'])).status, 1, 'upload is refused while the switch is off')
  assert.equal(srv.S.requests.length, 0)
  p = await run(['remote', 'check'])
  assert.match(p.stdout, /^200 /)
  p = await run(['remote', 'on', '--from-now'])
  assert.equal(p.status, 1, 'not from a script: only a person at a terminal switches it on')
  assert.match(p.stderr, /터미널/)
  assert.equal(readConfig(r.env).upload, false)
  // with a terminal (a pty from `script`) it works and says what goes out
  p = await new Promise(resolve => {
    const c = spawn('script', ['-qec', `${process.execPath} ${CLI} remote on --from-now`, '/dev/null'], { env: { ...process.env, ...r.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', d => (out += d))
    c.on('close', status => resolve({ status, stdout: out }))
  })
  assert.match(p.stdout, /프롬프트·응답/)
  assert.match(p.stdout, /서버 관리자가 지워야/)
  assert.equal(readConfig(r.env).upload, true)
  assert.match((await run(['upload'])).stdout, /보낸 이벤트 0개/, 'from now on: what was there is not sent')
  r.ledgerFile('s1.jsonl', [ev('cli00001-aaaa', 3)])
  assert.match((await run(['upload'])).stdout, /보낸 이벤트 1개/)
  await run(['remote', 'off'])
  assert.equal((await run(['upload'])).status, 1)
  enableUpload(r.env)
  assert.equal((await run(['remote', 'reset'])).status, 0)
  assert.equal(readUploadState(r.env), null)
  await run(['remote', 'clear'])
  assert.ok(!existsSync(join(r.env.VHDB_DIR, 'remote.json')))
  assert.match((await run(['remote', 'show'])).stdout, /꺼짐/)
})

test('the Stop hook starts nothing when upload is off, creates no state when only upload is on, and honours back-off', async () => {
  const srv = await fakeServer()
  const r = repo(srv, { on: false })
  const repoDir = join(r.top, 'work')
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  const env = { ...r.env, VHDB_PROJECT_DIR: repoDir }
  delete env.VHDB_NO_BG
  const stop = () => handle({ hook_event_name: 'Stop', session_id: 'sx', cwd: repoDir }, env)
  await stop()
  assert.ok(!existsSync(join(env.VHDB_DIR, 'state', 'upload.want')), 'switch off: nothing')
  enableUpload(env)
  r.ledgerFile('s1.jsonl', [ev('hook0001-aaaa', 1)])
  // a prompt with only upload on creates no log, no session state
  await handle({ hook_event_name: 'UserPromptSubmit', session_id: 'sx', cwd: repoDir, prompt: 'hello' }, env)
  assert.ok(!existsSync(join(env.VHDB_DIR, 'log')))
  await stop()
  assert.ok(existsSync(join(env.VHDB_DIR, 'state', 'upload.want')), 'a turn ended: the uploader was asked for')
  for (let i = 0; i < 100 && total(srv.S) === 0; i++) await sleep(100)
  assert.equal(total(srv.S), 1, 'the background process sent it')
  assert.ok(!existsSync(join(env.VHDB_DIR, 'log')), 'and only upload is on, so no log of ours')
  // during a back-off no process is started
  const st = readUploadState(env)
  st.backoff = { until: Date.now() + 3600 * 1000, step: 1 }
  saveUploadState(env, st)
  r.ledgerFile('s1.jsonl', [ev('hook0001-aaaa', 2)])
  await stop()
  await sleep(600)
  assert.equal(total(srv.S), 1)
  // a new token ends the back-off made under the old one
  const fresh = TOKEN.replace('abcd1234', 'wxyz5678')
  srv.S.token = fresh
  writeRemote(env, { url: srv.url, project: 'alpha', token: fresh })
  await stop()
  for (let i = 0; i < 100 && total(srv.S) === 1; i++) await sleep(100)
  assert.equal(total(srv.S), 2, 'the old back-off does not hold back the new token')
  // VHDB_NO_BG
  st.backoff = null
  saveUploadState(env, st)
  r.ledgerFile('s1.jsonl', [ev('hook0001-aaaa', 3)])
  await handle({ hook_event_name: 'Stop', session_id: 'sx', cwd: repoDir }, { ...env, VHDB_NO_BG: '1' })
  await sleep(600)
  assert.equal(total(srv.S), 2)
})

test('MCP: upload cannot be switched on by the model, `all` never includes it, `off all` turns it off, status names no token', async () => {
  const srv = await fakeServer()
  const r = repo(srv, { on: false })
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...r.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  after(() => child.kill())
  const lines = []
  let buf = ''
  const waiters = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', c => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, i))
      buf = buf.slice(i + 1)
      waiters.splice(0).forEach(w => w())
    }
  })
  let id = 0
  const call = async args => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'vhdb_config', arguments: args } })}\n`)
    while (!lines.length) await new Promise(res => waiters.push(res))
    return JSON.parse(lines.shift())
  }
  let res = await call({ action: 'on', targets: ['upload'] })
  assert.ok(res.error || res.result?.isError, 'refused')
  assert.match(JSON.stringify(res), /터미널/)
  assert.ok(!existsSync(join(r.env.VHDB_DIR, 'config.json')) || JSON.parse(readFileSync(join(r.env.VHDB_DIR, 'config.json'), 'utf8')).upload !== true)
  res = await call({ action: 'on' })
  assert.match(res.result.content[0].text, /업로드\(upload\) 꺼짐/)
  enableUpload(r.env)
  res = await call({ action: 'status' })
  assert.match(res.result.content[0].text, /업로드\(upload\) 켜짐 — http:\/\/127\.0\.0\.1:\d+ · 프로젝트 alpha · 토큰 설정됨/)
  assert.ok(!res.result.content[0].text.includes('SecretSecret'))
  res = await call({ action: 'off', targets: ['all'] })
  assert.match(res.result.content[0].text, /업로드\(upload\) 꺼짐/)
  child.stdin.end()
})

test('readWindow reads whole lines only and starts over for a replaced file', () => {
  const r = repo(null, { on: false })
  const p = join(r.swb, 'w.jsonl')
  writeFileSync(p, `${JSON.stringify(ev('win00001-aaaa', 1))}\n${JSON.stringify(ev('win00001-aaaa', 2))}\n{"half`)
  const w = readWindow(p, 0)
  assert.equal(w.events.length, 2)
  assert.equal(w.end, readFileSync(p).lastIndexOf(10) + 1)
  assert.equal(readWindow(p, w.end).events.length, 0)
  assert.equal(readWindow(p, 10_000_000).start, 0, 'the file is shorter than the offset: it was replaced')
  assert.equal(dryRun({ ...r.env }).ok, false, 'no server configured')
})

test('a newest line without its newline (smart-workbench writes the newline first) is read once it parses, and blank lines are skipped', () => {
  const r = repo(null, { on: false })
  const p = join(r.swb, 'n.jsonl')
  const a = JSON.stringify(ev('nl000001-aaaa', 1))
  const b = JSON.stringify(ev('nl000001-aaaa', 2))
  writeFileSync(p, `\n${a}\n\n${b}`)
  const w = readWindow(p, 0)
  assert.deepEqual(w.events.map(e => e.seq), [1, 2])
  assert.equal(w.end, readFileSync(p).length)
  appendFileSync(p, `\n${JSON.stringify(ev('nl000001-aaaa', 3))}`)
  assert.deepEqual(readWindow(p, w.end).events.map(e => e.seq), [3])
  // a half-written last line is still left alone
  appendFileSync(p, `\n{"v":1,"seq":4,"te`)
  const h = readWindow(p, w.end)
  assert.deepEqual(h.events.map(e => e.seq), [3])
  assert.equal(h.invalid, 0)
})

test('the approval covers the ledger setting too; a token swap needs no new approval; approvalPath is always absolute', async () => {
  const srv = await fakeServer()
  const r = repo(srv)
  const show = async env => JSON.parse((await exec(env, ['remote', 'show', '--json'])).stdout)
  assert.equal((await show(r.env)).approved, true)
  // same address and project, but now without the ledger: the upload goes off
  const set = await exec(r.env, ['remote', 'set', '--url', srv.url, '--project', 'alpha', '--no-ledger'], `${TOKEN}\n`)
  assert.equal(set.status, 0, set.stderr)
  assert.match(set.stdout, /업로드를 껐습니다/)
  assert.equal(readConfig(r.env).upload, false)
  // a token swap alone keeps an approved setting approved
  const q = repo(srv)
  const other = `vhdb_${'x'.repeat(43)}`
  const swap = await exec(q.env, ['remote', 'set', '--url', srv.url, '--project', 'alpha'], `${other}\n`)
  assert.equal(swap.status, 0, swap.stderr)
  assert.equal(readConfig(q.env).upload, true)
  assert.equal((await show(q.env)).approved, true)
  // editing the file by hand: ledger false, or the key removed (= true) after approving without the ledger
  const hand = repo(srv)
  const handPath = join(hand.env.VHDB_DIR, 'remote.json')
  const hd = JSON.parse(readFileSync(handPath, 'utf8'))
  writeFileSync(handPath, `${JSON.stringify({ ...hd, ledger: false })}\n`, { mode: 0o600 })
  assert.equal((await show(hand.env)).approved, false)
  assert.match((await show(hand.env)).reason, /다시 켜야/)
  assert.match((await runUpload(hand.env)).skipped, /다시 켜세요/)
  const noLedger = repo(srv, { ledger: false })
  const nlPath = join(noLedger.env.VHDB_DIR, 'remote.json')
  const nl = JSON.parse(readFileSync(nlPath, 'utf8'))
  delete nl.ledger
  writeFileSync(nlPath, `${JSON.stringify(nl)}\n`, { mode: 0o600 })
  assert.equal((await show(noLedger.env)).approved, false)
  assert.match((await runUpload(noLedger.env)).skipped, /다시 켜세요/)
  assert.equal(srv.S.requests.length, 0)
  // approvalPath: given even without a server setting, and absolute for a relative VHDB_DIR
  const bare = repo(null, { on: false })
  const j = await show(bare.env)
  assert.equal(j.configured, false)
  assert.ok(isAbsolute(j.approvalPath))
  assert.ok(j.approvalPath.endsWith(join('state', 'ui-approval')))
  const rel = await exec({ ...bare.env, VHDB_DIR: 'relative-vhdb' }, ['remote', 'show', '--json'])
  assert.ok(isAbsolute(JSON.parse(rel.stdout).approvalPath))
})
