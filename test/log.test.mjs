import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { open, withLock } from '../engine/vhdb.mjs'
import { safeId, withSession } from '../lib/log.mjs'
import { WASM } from './fixture.mjs'

const WORKER = fileURLToPath(new URL('./log-worker.mjs', import.meta.url))
const tmp = () => mkdtempSync(join(tmpdir(), 'vhdb-log-'))

test('20 processes appending to one session: seq strictly increases in file order, no torn lines, engine drops nothing', async () => {
  const dir = tmp()
  const env = { ...process.env, VHDB_DIR: dir }
  await Promise.all(Array.from({ length: 20 }, () => new Promise((res, rej) => {
    const c = spawn('node', [WORKER, 'sess1', '5'], { env })
    c.on('exit', code => (code === 0 ? res() : rej(new Error(`worker exit ${code}`))))
  })))
  const lines = readFileSync(join(dir, 'log', 'vhdb-sess1.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 100)
  const seqs = lines.map(l => JSON.parse(l).seq)
  assert.deepEqual(seqs, Array.from({ length: 100 }, (_, i) => i + 1))
  const engine = await open(dir, WASM, { sessions: [join(dir, 'log')] })
  const rep = withLock(dir, () => engine.call('ingest'))
  assert.equal(rep.report.events, 100, JSON.stringify(rep))
  assert.equal(rep.report.duplicates ?? 0, 0)
})

test('state recovery from the log; session ids are made safe; turn survives between processes', () => {
  const dir = tmp()
  const env = { VHDB_DIR: dir }
  withSession(env, 'abc', ({ state, emit }) => {
    state.turn += 1
    emit('turn.start')
    emit('x')
  })
  writeFileSync(join(dir, 'state', 'sess-abc.json'), '{broken') // damaged state file
  withSession(env, 'abc', ({ state, emit }) => {
    assert.equal(state.seq, 2)
    assert.equal(state.turn, 1)
    assert.equal(emit('y').seq, 3)
  })
  appendFileSync(join(dir, 'log', 'vhdb-abc.jsonl'), '{"torn') // crash mid-line, no newline
  writeFileSync(join(dir, 'state', 'sess-abc.json'), 'x')
  withSession(env, 'abc', ({ state }) => assert.equal(state.seq, 3))
  assert.match(safeId('../../etc/passwd'), /^[0-9a-f]{16}$/)
  assert.equal(safeId('0a1b-2c_3'), '0a1b-2c_3')
})

test('a lock left by a dead process is taken over', () => {
  const dir = tmp()
  mkdirSync(join(dir, 'state'), { recursive: true })
  writeFileSync(join(dir, 'state', 'sess-dead.lock'), `2147483646@${hostname()}`)
  withSession({ VHDB_DIR: dir }, 'dead', ({ emit }) => assert.equal(emit('x').seq, 1))
})
