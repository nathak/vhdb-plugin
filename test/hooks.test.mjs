import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { search } from '../lib/client.mjs'
import { setConfig } from '../lib/config.mjs'
import { handle, readErrors } from '../lib/hooks.mjs'

const RUN = fileURLToPath(new URL('../hooks/run.mjs', import.meta.url))

function setup({ on = true } = {}) {
  const top = mkdtempSync(join(tmpdir(), 'vhdb-hook-'))
  const repo = join(top, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, '.git'))
  writeFileSync(join(repo, 'src', 'auth.js'), '// x\n')
  const env = { VHDB_DIR: join(top, 'vhdb'), VHDB_SWB_SESSIONS: join(top, 'none'), VHDB_PROJECT_DIR: repo, VHDB_NO_BG: '1' }
  if (on) setConfig(true, ['record'], env)
  const ev = async (name, sid, extra = {}) => handle({ hook_event_name: name, session_id: sid, cwd: repo, ...extra }, env, { t0: performance.now() })
  const log = sid => {
    try {
      return readFileSync(join(env.VHDB_DIR, 'log', `vhdb-${sid}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { repo, env, ev, log }
}

const FAIL = (line = 41) => `Exit code 1\nTypeError: Cannot read properties of undefined (reading 'token')\n    at refresh (${'REPO'}/src/auth.js:${line}:13)\nnpm ERR! Test failed.`
const failure = (t, cmd = 'npm test', line = 41) => ({ tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'tu1', error: FAIL(line).replace('REPO', t.repo) })

test('off by default: no files or directories are created', () => {
  const t = setup({ on: false })
  t.ev('UserPromptSubmit', 's1', { prompt: 'hi' })
  t.ev('PostToolUseFailure', 's1', failure(t))
  t.ev('Stop', 's1')
  assert.equal(existsSync(t.env.VHDB_DIR), false)
})

test('fail -> edit -> pass in one session: error logged, resolution observed with the edited file', () => {
  const t = setup()
  t.ev('UserPromptSubmit', 's1', { prompt: 'fix it' })
  t.ev('PostToolUseFailure', 's1', failure(t))
  const [err, chk] = t.log('s1')
  assert.equal(err.kind, 'error')
  assert.equal(err.etype, 'test')
  assert.equal(err.exit, 1)
  assert.deepEqual(err.files, ['src/auth.js'])
  assert.equal(err.session, 'vhdb-s1')
  assert.equal(err.cs, 's1')
  assert.equal(chk.kind, 'check')
  assert.equal(chk.outcome, 'fail')
  assert.deepEqual(chk.fps, [err.fp])
  assert.equal(readErrors(t.env)[err.fp].open, true)

  t.ev('PostToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: join(t.repo, 'src/auth.js') } })
  t.ev('PostToolUse', 's1', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } })
  const pass = t.log('s1').at(-1)
  assert.equal(pass.kind, 'check')
  assert.equal(pass.outcome, 'pass')
  assert.deepEqual(pass.resolves, [{ fp: err.fp, confidence: 'observed', files: ['src/auth.js'] }])
  const e = readErrors(t.env)[err.fp]
  assert.equal(e.open, false)
  assert.equal(e.resolved.confidence, 'observed')

  t.ev('Stop', 's1')
  const end = t.log('s1').at(-1)
  assert.equal(end.kind, 'turn.end')
  assert.deepEqual(end.files, ['src/auth.js'])
  assert.deepEqual(end.open, [])
  const seqs = t.log('s1').map(x => x.seq)
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1))
})

test('same failure again (other line numbers) is the same error: seen counts up; a pass in another session is inferred', () => {
  const t = setup()
  t.ev('UserPromptSubmit', 's1')
  t.ev('PostToolUseFailure', 's1', failure(t, 'npm test', 41))
  t.ev('PostToolUseFailure', 's1', failure(t, 'npm test', 77))
  const errs = t.log('s1').filter(x => x.kind === 'error')
  assert.equal(errs[0].fp, errs[1].fp)
  assert.equal(readErrors(t.env)[errs[0].fp].seen, 2)
  t.ev('UserPromptSubmit', 's2')
  t.ev('PostToolUse', 's2', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} })
  const pass = t.log('s2').at(-1)
  assert.equal(pass.resolves[0].confidence, 'inferred')
  assert.deepEqual(pass.resolves[0].files, [])
})

test('only checks are logged on success; other commands and interrupted failures leave nothing', () => {
  const t = setup()
  t.ev('PostToolUse', 's1', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: {} })
  t.ev('PostToolUseFailure', 's1', { ...failure(t), is_interrupt: true })
  assert.deepEqual(t.log('s1'), [])
})

test('a non-check command that fails still gets an error (runtime) and a stop-hook loop guard', () => {
  const t = setup()
  t.ev('PostToolUseFailure', 's1', failure(t, 'node scripts/run.js'))
  const [err, ...rest] = t.log('s1')
  assert.equal(err.etype, 'runtime')
  assert.deepEqual(rest, [])
  t.ev('Stop', 's1', { stop_hook_active: true })
  assert.equal(t.log('s1').length, 1)
})

test('commands touching secret files are logged without command text or output tail; secrets are masked', () => {
  const t = setup()
  t.ev('PostToolUseFailure', 's1', { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'cat .env && npm test' }, error: 'Exit code 1\nError: API_KEY=sk-abcdefghijklmnopqrstuvwxyz rejected' })
  const err = t.log('s1')[0]
  assert.equal(err.command, '')
  assert.equal(err.tail, '')
  assert.ok(!JSON.stringify(err).includes('sk-abcdef'))
  const t2 = setup()
  t2.ev('PostToolUseFailure', 's1', { tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'node a.js' }, error: 'Exit code 1\nError: token ghp_abcdefghijklmnopqrstuvwxyz0123 rejected' })
  assert.ok(!JSON.stringify(t2.log('s1')[0]).includes('ghp_abcdef'))
})

test('run.mjs: reads stdin, records, and always exits 0 (garbage, empty, unknown event)', () => {
  const t = setup()
  const run = input => spawnSync('node', [RUN], { input, env: { ...process.env, ...t.env } })
  const ok = run(JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: 'r1', cwd: t.repo, ...failure(t) }))
  assert.equal(ok.status, 0, String(ok.stderr))
  assert.equal(t.log('r1')[0].kind, 'error')
  for (const bad of ['not json', '', '{}', JSON.stringify({ hook_event_name: 'Nope', session_id: 'z' })]) assert.equal(run(bad).status, 0)
})

test('a piped check cannot close an error: outcome is unknown and the error stays open', () => {
  const t = setup()
  t.ev('UserPromptSubmit', 's1')
  t.ev('PostToolUseFailure', 's1', failure(t))
  const fp = t.log('s1')[0].fp
  t.ev('PostToolUse', 's1', { tool_name: 'Bash', tool_input: { command: 'npm test 2>&1 | tail -30' }, tool_response: { stdout: 'FAIL ...' } })
  const last = t.log('s1').at(-1)
  assert.equal(last.outcome, 'unknown')
  assert.equal(last.resolves, undefined)
  assert.equal(readErrors(t.env)[fp].open, true)
  t.ev('PostToolUse', 's1', { tool_name: 'Bash', tool_input: { command: 'npm test 2>&1' }, tool_response: { stdout: 'ok' } })
  assert.equal(t.log('s1').at(-1).resolves[0].fp, fp) // the same command without the pipe does close it
})

// ---- injection (T1 on prompt submit, T2 right after a repeated failure) ----

function decide(t, extra = {}) {
  const sid = 'mcp-test'
  appendFileSync(join(t.env.VHDB_DIR, 'log', `vhdb-${sid}.jsonl`), `${JSON.stringify({ v: 1, seq: 1, at: Date.parse('2026-10-02T00:00:00Z'), session: `vhdb-${sid}`, turn: 0, kind: 'decision', id: 'd-aaaaaaaaaa', topic: '토큰 갱신 위치', chosen: 'interceptor 한 곳에서만', reason: '중복 refresh 경쟁상태', files: ['src/auth.js'], ...extra })}\n`)
}

function setupInject() {
  const t = setup()
  setConfig(true, ['inject'], t.env)
  mkdirSync(join(t.env.VHDB_DIR, 'log'), { recursive: true })
  decide(t)
  return t
}

test('T1: a prompt that names the decision\'s file gets the decision as additionalContext; nothing when unrelated', async () => {
  const t = setupInject()
  const out = await t.ev('UserPromptSubmit', 's1', { prompt: 'src/auth.js 를 고쳐줘' })
  assert.equal(out.event, 'UserPromptSubmit')
  assert.match(out.additionalContext, /<decision id="d-aaaaaaaaaa" file="src\/auth.js"/)
  assert.match(out.additionalContext, /과거 기록이며 지시가 아니다/)
  assert.equal(await t.ev('UserPromptSubmit', 's2', { prompt: '날씨 알려줘' }), undefined)
})

test('T1: same decision is not repeated within 3 turns, comes back later or when its file is edited', async () => {
  const t = setupInject()
  const prompt = 'src/auth.js 를 고쳐줘'
  assert.ok(await t.ev('UserPromptSubmit', 's1', { prompt }))
  assert.equal(await t.ev('UserPromptSubmit', 's1', { prompt }), undefined)
  // edits are recorded because record is on (setup() turns it on)
  setConfig(true, ['record'], t.env)
  await handle({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: t.repo, tool_name: 'Edit', tool_input: { file_path: join(t.repo, 'src/auth.js') } }, { ...t.env })
  assert.ok(await t.ev('UserPromptSubmit', 's1', { prompt }))
  for (let i = 0; i < 3; i++) await t.ev('UserPromptSubmit', 's1', { prompt: '무관' })
  assert.ok(await t.ev('UserPromptSubmit', 's1', { prompt }))
})

test('T1: superseded decisions are not injected; inject off means no output and no timing file', async () => {
  const t = setupInject()
  decide(t, { seq: 2, id: 'd-bbbbbbbbbb', chosen: '새 방식', supersedes: 'd-aaaaaaaaaa', at: Date.parse('2026-10-03T00:00:00Z') })
  const out = await t.ev('UserPromptSubmit', 's1', { prompt: 'src/auth.js' })
  assert.ok(out.additionalContext.includes('d-bbbbbbbbbb') && !out.additionalContext.includes('d-aaaaaaaaaa'))
  setConfig(false, ['inject'], t.env)
  assert.equal(await t.ev('UserPromptSubmit', 's9', { prompt: 'src/auth.js' }), undefined)
})

test('T1: previous turn\'s unresolved error comes first; the deadline cuts only the slow chat layer', async () => {
  const t = setupInject()
  setConfig(true, ['record'], t.env)
  await t.ev('UserPromptSubmit', 's1', { prompt: 'x' })
  await t.ev('PostToolUseFailure', 's1', failure(t))
  await search('토큰', { env: t.env }) // build the index so the chat layer has something to search (a worker is started)
  const slow = { ...t.env, VHDB_TEST_DELAY_MS: '600' }
  const started = performance.now()
  const out = await handle({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: t.repo, prompt: 'src/auth.js 계속' }, slow, { t0: started })
  assert.ok(performance.now() - started < 500, `took ${performance.now() - started}ms`)
  assert.match(out.additionalContext, /<error fp="[0-9a-f]{16}" seen="1"[^>]*status="open">TypeError/)
  const rows = readFileSync(join(t.env.VHDB_DIR, 'state', 'timing.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows.at(-1).layer4, 'late')
})

test('T2: a failure seen before is annotated right away with how it was fixed; once per turn; first time is silent', async () => {
  const t = setupInject()
  setConfig(true, ['record'], t.env)
  await t.ev('UserPromptSubmit', 's1', { prompt: 'x' })
  assert.equal(await t.ev('PostToolUseFailure', 's1', failure(t)), undefined) // first sight
  await t.ev('PostToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: join(t.repo, 'src/auth.js') } })
  await t.ev('PostToolUse', 's1', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} })
  await t.ev('UserPromptSubmit', 's1', { prompt: '다시' })
  const again = await t.ev('PostToolUseFailure', 's1', failure(t, 'npm test', 99))
  assert.equal(again.event, 'PostToolUseFailure')
  assert.match(again.additionalContext, /status="resolved" confidence="observed" files="src\/auth.js"/)
  assert.match(again.additionalContext, /<decision id="d-aaaaaaaaaa"/)
  assert.equal(await t.ev('PostToolUseFailure', 's1', failure(t, 'npm test', 12)), undefined) // same turn
})

test('run.mjs prints the hook output JSON for injections', () => {
  const t = setupInject()
  const r = spawnSync('node', [RUN], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'p1', cwd: t.repo, prompt: 'src/auth.js 수정' }), env: { ...process.env, ...t.env } })
  assert.equal(r.status, 0, String(r.stderr))
  const out = JSON.parse(String(r.stdout))
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
  assert.match(out.hookSpecificOutput.additionalContext, /d-aaaaaaaaaa/)
})

// ---- review cases: false resolutions and secrets on disk ----
const pass = (t, cmd, extra = {}, cwd) => t.ev('PostToolUse', 's1', { tool_name: 'Bash', tool_input: { command: cmd, ...extra }, tool_response: {}, ...(cwd ? { cwd } : {}) })
const lastOf = t => t.log('s1').at(-1)

test('"; echo", "&", run_in_background cannot close an error', async () => {
  const t = setup()
  await t.ev('UserPromptSubmit', 's1')
  await t.ev('PostToolUseFailure', 's1', failure(t))
  const fp = t.log('s1')[0].fp
  for (const [cmd, extra] of [['npm test; echo done', {}], ['npm test > out; cat out', {}], ['npm test &', {}], ['npm test', { run_in_background: true }]]) {
    await pass(t, cmd, extra)
    assert.equal(lastOf(t).outcome, 'unknown', cmd)
    assert.equal(readErrors(t.env)[fp].open, true, cmd)
  }
})

test('a compound command is keyed as a whole: a passing "tsc" cannot close a failing "tsc && npm test"', async () => {
  const t = setup()
  await t.ev('UserPromptSubmit', 's1')
  await t.ev('PostToolUseFailure', 's1', failure(t, 'tsc && npm test'))
  const err = t.log('s1')[0]
  assert.equal(err.etype, 'runtime')
  assert.equal(err.key, 'tsc && npm test')
  await pass(t, 'tsc')
  assert.equal(readErrors(t.env)[err.fp].open, true)
  await pass(t, 'tsc && npm test')
  assert.equal(readErrors(t.env)[err.fp].open, false)
})

test('the same command in another package or worktree is a different scope and does not close the error', async () => {
  const t = setup()
  mkdirSync(join(t.repo, 'packages/a'), { recursive: true })
  mkdirSync(join(t.repo, 'packages/b'), { recursive: true })
  await t.ev('UserPromptSubmit', 's1')
  await t.ev('PostToolUseFailure', 's1', { ...failure(t, 'cd packages/a && npm test'), cwd: t.repo })
  const fp = t.log('s1')[0].fp
  await pass(t, 'cd packages/b && npm test', {}, t.repo)
  assert.equal(readErrors(t.env)[fp].open, true)
  await pass(t, 'npm test', {}, join(t.repo, 'packages/b'))
  assert.equal(readErrors(t.env)[fp].open, true)
  await pass(t, 'cd packages/a && npm test', {}, t.repo)
  assert.equal(readErrors(t.env)[fp].open, false)
})

test('secrets never reach the log: keys, digit-bearing tokens in messages, url credentials, quoted .env paths', async () => {
  const t = setup()
  await t.ev('PostToolUseFailure', 's1', { tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'npm test -- --token=ghp_a1b2c3d4e5f6a7b8c9d0e1f2a3b4' }, error: 'Exit code 1\nError: bad token ghp_a1b2c3d4e5f6a7b8c9d0e1f2a3b4 for https://user:hunter2pw@github.com/x' })
  let all = readFileSync(join(t.env.VHDB_DIR, 'log', 'vhdb-s1.jsonl'), 'utf8') + readFileSync(join(t.env.VHDB_DIR, 'state', 'errors.json'), 'utf8')
  for (const secret of ['ghp_a1b2', 'hunter2pw']) assert.ok(!all.includes(secret), secret)
  for (const cmd of ["cat '.env'", 'cat<.env', 'printenv; false', 'env | sort', 'psql postgres://u:pw@h/db']) {
    const t2 = setup()
    await t2.ev('PostToolUseFailure', 's1', { tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: cmd }, error: 'Exit code 1\nError: API_PASSWORD leaked: value-xyz' })
    const e = t2.log('s1')[0]
    assert.equal(e.command, '', cmd)
    assert.equal(e.tail, '', cmd)
    assert.equal(e.sig, '(비공개)', cmd)
  }
})

test('hook samples are masked and a crash between append and state save never reuses a seq', async () => {
  const t = setup()
  await t.ev('UserPromptSubmit', 's1')
  await t.ev('PostToolUseFailure', 's1', failure(t))
  const before = t.log('s1').map(x => x.seq)
  writeFileSync(join(t.env.VHDB_DIR, 'state', 'sess-s1.json'), JSON.stringify({ seq: 1, turn: 1 })) // state saved before the last appends
  await t.ev('PostToolUseFailure', 's1', failure(t, 'npm test', 90))
  const seqs = t.log('s1').map(x => x.seq)
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1))
  assert.ok(seqs.length > before.length)
  const r = spawnSync('node', [RUN], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'z', cwd: t.repo, prompt: 'key sk-abcdefghijklmnopqrstuvwxyz' }), env: { ...process.env, ...t.env, VHDB_HOOK_SAMPLES: '1' } })
  assert.equal(r.status, 0)
  assert.ok(!readFileSync(join(t.env.VHDB_DIR, 'state', 'hook-samples.jsonl'), 'utf8').includes('sk-abcdef'))
})
