import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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
  const ev = (name, sid, extra = {}) => handle({ hook_event_name: name, session_id: sid, cwd: repo, ...extra }, env)
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
