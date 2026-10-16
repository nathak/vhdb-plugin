import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeLedger } from './fixture.mjs'

const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))

function start(env) {
  const child = spawn('node', [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = []
  const waiters = []
  let buf = ''
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
  const exited = new Promise(res => child.on('exit', code => res(code)))
  after(() => child.kill()) // an assertion failing mid-test must not leave the server (and the runner) hanging
  const next = async () => {
    while (!lines.length) await new Promise(r => waiters.push(r))
    return lines.shift()
  }
  return {
    lines,
    exited,
    raw: s => child.stdin.write(s),
    send: obj => child.stdin.write(`${JSON.stringify(obj)}\n`),
    nextJson: async () => JSON.parse(await next()),
    close: () => child.stdin.end(),
  }
}

test('MCP round trip', async () => {
  const l = makeLedger()
  const s = start(l.env)
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
  let r = await s.nextJson()
  assert.equal(r.id, 1)
  assert.equal(r.result.protocolVersion, '2025-06-18')
  assert.ok(r.result.capabilities.tools)
  assert.equal(r.result.serverInfo.name, 'vhdb')

  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' }) // no reply allowed
  s.send({ jsonrpc: '2.0', id: 'two', method: 'ping' })
  r = await s.nextJson()
  assert.equal(r.id, 'two') // string ids come back as sent, and the notification produced nothing before it
  assert.deepEqual(r.result, {})

  s.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  r = await s.nextJson()
  assert.deepEqual(r.result.tools.map(t => t.name), ['query_history', 'file_history', 'record_decision', 'vhdb_config'])
  assert.ok(r.result.tools.every(t => t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false))

  s.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'query_history', arguments: { query: 'kind:edit', limit: 5 } } })
  r = await s.nextJson()
  assert.equal(r.result.isError, false)
  assert.equal(r.result.content[0].text.split('\n').filter(x => x.startsWith('[edit]')).length, 5)

  l.add({ v: 1, seq: 101, at: Date.parse('2026-10-02T00:00:00Z'), session: 'sess0001-abcd', turn: 11, kind: 'prompt', text: '새단어qux' })
  s.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'query_history', arguments: { query: '새단어qux' } } })
  r = await s.nextJson()
  assert.match(r.result.content[0].text, /새단어qux/)

  s.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'file_history', arguments: { path: './src/a.ts' } } })
  r = await s.nextJson()
  assert.equal(r.result.isError, false)
  assert.match(r.result.content[0].text, /src\/a\.ts: 턴 [1-9]/)

  // tool-level failures are results, protocol-level ones are errors
  s.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'query_history', arguments: { query: 'since:garbage' } } })
  r = await s.nextJson()
  assert.ok(r.result?.isError === true || r.result.content[0].text.length > 0)
  s.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } })
  assert.equal((await s.nextJson()).error.code, -32602)
  s.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'query_history', arguments: { query: 'x', limit: 999 } } })
  assert.equal((await s.nextJson()).error.code, -32602)
  s.send({ jsonrpc: '2.0', id: 10, method: 'nope/method' })
  assert.equal((await s.nextJson()).error.code, -32601)
  s.raw('{not json\n')
  r = await s.nextJson()
  assert.equal(r.error.code, -32700)
  assert.equal(r.id, null)
  s.send([{ jsonrpc: '2.0', id: 11, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }])
  r = await s.nextJson()
  assert.ok(Array.isArray(r) && r.length === 1 && r[0].id === 11)

  s.close()
  assert.equal(await s.exited, 0)
})

test('a chunk split mid-line is reassembled; a missing ledger is a tool error, not a crash', async () => {
  const s = start({ VHDB_DIR: '/nonexistent/vhdb', VHDB_SWB_SESSIONS: '/nonexistent/sessions', VHDB_WASM: makeLedger().env.VHDB_WASM })
  const msg = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_history', arguments: { query: 'a' } } })}\n`
  s.raw(msg.slice(0, 20))
  await new Promise(r => setTimeout(r, 50))
  s.raw(msg.slice(20))
  const r = await s.nextJson()
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /읽을 이력이 없음/)
  s.send({ jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.equal((await s.nextJson()).id, 2) // still alive
  s.close()
  assert.equal(await s.exited, 0)
})

test('a tool failure inside the line chain does not stop later requests', async () => {
  const l = makeLedger()
  const s = start({ ...l.env, VHDB_WASM: '/nonexistent.wasm' })
  s.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_history', arguments: { query: 'a' } } })
  assert.equal((await s.nextJson()).result.isError, true)
  s.send({ jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.equal((await s.nextJson()).id, 2)
  s.close()
  assert.equal(await s.exited, 0)
})

test('vhdb_config: off by default, on/off round trip, bad switch rejected, nothing created before first change', async () => {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const l = makeLedger()
  const s = start(l.env)
  const call = async (id, args) => {
    s.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'vhdb_config', arguments: args } })
    return s.nextJson()
  }
  let r = await call(1, { action: 'status' })
  assert.match(r.result.content[0].text, /기록\(record\) 꺼짐, 주입\(inject\) 꺼짐/)
  assert.equal(existsSync(join(l.root, 'config.json')), false)
  r = await call(2, { action: 'on', targets: ['record'] })
  assert.match(r.result.content[0].text, /기록\(record\) 켜짐, 주입\(inject\) 꺼짐/)
  r = await call(3, { action: 'on' })
  assert.match(r.result.content[0].text, /기록\(record\) 켜짐, 주입\(inject\) 켜짐, 편집 전 확인\(guard\) 꺼짐/)
  r = await call(4, { action: 'off', targets: ['all'] })
  assert.match(r.result.content[0].text, /기록\(record\) 꺼짐, 주입\(inject\) 꺼짐/)
  assert.equal((await call(5, { action: 'toggle' })).error.code, -32602)
  r = await call(6, { action: 'on', targets: ['bogus'] })
  assert.equal(r.result.isError, true)
  s.close()
  assert.equal(await s.exited, 0)
})

test('record_decision: off by default, records, supersede chain of 3, stale supersede refused, status filter', async () => {
  const l = makeLedger()
  const s = start(l.env)
  let n = 100
  const tool = async (name, args) => {
    s.send({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } })
    return s.nextJson()
  }
  const text = r => r.result.content[0].text
  const dec = (topic, chosen, extra = {}) => tool('record_decision', { topic, chosen, reason: `${chosen} 이유`, files: ['./src/a.ts'], ...extra })

  let r = await dec('토큰갱신', 'interceptor')
  assert.equal(r.result.isError, true)
  assert.match(text(r), /기록 꺼짐/)

  await tool('vhdb_config', { action: 'on', targets: ['record'] })
  r = await dec('토큰갱신', '방식A')
  const a = /d-[0-9a-f]{10}/.exec(text(r))[0]
  r = await dec('토큰갱신', '방식B', { supersedes: a })
  const b = /d-[0-9a-f]{10}/.exec(text(r))[0]
  r = await dec('토큰갱신', '방식C', { supersedes: b })
  const c = /d-[0-9a-f]{10}/.exec(text(r))[0]
  assert.equal(new Set([a, b, c]).size, 3)

  r = await dec('토큰갱신', '방식D', { supersedes: a }) // a is already replaced
  assert.equal(r.result.isError, true)
  assert.match(text(r), new RegExp(`${c}`))
  r = await dec('x', 'y', { supersedes: 'd-0000000000' })
  assert.equal(r.result.isError, true)
  assert.match(text(r), /없는 결정/)
  assert.equal((await dec('x', 'y', { supersedes: 'nope' })).error.code, -32602)
  assert.equal((await tool('record_decision', { topic: 't' })).error.code, -32602)

  const q = async query => text(await tool('query_history', { query, limit: 20 }))
  const active = await q('kind:decision 토큰갱신')
  assert.match(active, /방식C/)
  assert.ok(!/방식A|방식B/.test(active))
  assert.match(active, /대체된 결정 2건 숨김/)
  const all = await q('kind:decision 토큰갱신 status:all')
  assert.ok(/방식A/.test(all) && /방식B/.test(all) && /방식C/.test(all))
  assert.match(all, /\(superseded\)/)
  const old = await q('kind:decision status:superseded 토큰갱신')
  assert.ok(/방식A/.test(old) && /방식B/.test(old) && !/방식C/.test(old))
  const byFile = await q('file:src/a.ts kind:decision')
  assert.match(byFile, /방식C/)
  s.close()
  assert.equal(await s.exited, 0)
})

test('error:<fp> finds the error and the check that carried it', async () => {
  const { handle } = await import('../lib/hooks.mjs')
  const { mkdirSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const l = makeLedger()
  const repo = mkdtempSync(join(tmpdir(), 'vhdb-r-'))
  mkdirSync(join(repo, '.git'))
  const env = { ...l.env, VHDB_PROJECT_DIR: repo, VHDB_NO_BG: '1' }
  const { setConfig } = await import('../lib/config.mjs')
  setConfig(true, ['record'], env)
  handle({ hook_event_name: 'PostToolUseFailure', session_id: 'e1', cwd: repo, tool_name: 'Bash', tool_use_id: 'u', tool_input: { command: 'npm test' }, error: 'Exit code 1\nRangeError: Maximum call stack size exceeded\n    at f (src/x.js:3:1)' }, env)
  const log = (await import('node:fs')).readFileSync(join(l.root, 'log', 'vhdb-e1.jsonl'), 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x))
  const fp = log[0].fp
  const s = start(env)
  s.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query_history', arguments: { query: `error:${fp}` } } })
  const t = (await s.nextJson()).result.content[0].text
  assert.match(t, new RegExp(`\\[error\\].*fp:${fp}`))
  assert.match(t, /\[check\] .*fail/)
  assert.ok(!t.includes('at f (src/x.js'), 'the output tail (stack) is never shown')
  s.close()
})
