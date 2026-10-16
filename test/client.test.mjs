import { createHash } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { history, search } from '../lib/client.mjs'
import { makeLedger } from './fixture.mjs'

test('first query ingests and answers; new lines are visible on the next query', async () => {
  const l = makeLedger()
  const r = await search('kind:edit', { limit: 100, env: l.env })
  assert.equal(r.answer.ok, true)
  assert.equal(r.answer.hits.length, 50)
  l.add({ v: 1, seq: 101, at: Date.parse('2026-10-02T00:00:00Z'), session: 'sess0001-abcd', turn: 11, kind: 'prompt', text: 'zebra새단어' })
  const r2 = await search('zebra새단어', { env: l.env })
  assert.equal(r2.answer.hits.length, 1)
})

test('history groups a file by turn; ./ paths work', async () => {
  const l = makeLedger()
  const h = await history('./src/a.ts', { env: l.env })
  assert.equal(h.answer.ok, true)
  assert.ok(h.answer.turns.length >= 1)
})

test('a live lock from another process adds a note and queries still work', async () => {
  const l = makeLedger()
  await search('토큰', { env: l.env })
  writeFileSync(join(l.root, 'LOCK'), `${process.pid}@${hostname()}`)
  try {
    const r = await search('토큰', { env: l.env })
    assert.equal(r.answer.ok, true)
    assert.ok(r.notes.some(n => n.includes('인제스트 중')), JSON.stringify(r.notes))
  } finally {
    rmSync(join(l.root, 'LOCK'), { force: true })
  }
})

test('sessions/ is only read: contents and mtimes unchanged, works when read-only', async () => {
  const l = makeLedger()
  const dir = l.sessionsDir
  const snap = () => readdirSync(dir).map(n => [n, createHash('sha256').update(readFileSync(join(dir, n))).digest('hex'), statSync(join(dir, n)).mtimeMs])
  const before = snap()
  chmodSync(l.log, 0o444)
  chmodSync(dir, 0o555)
  try {
    const r = await search('kind:edit', { limit: 5, env: l.env })
    assert.equal(r.answer.ok, true)
    assert.equal(r.notes.length, 0, JSON.stringify(r.notes))
  } finally {
    chmodSync(dir, 0o755)
    chmodSync(l.log, 0o644)
  }
  assert.deepEqual(snap(), before)
})

test('an unwritable ledger root (LOCK cannot be created) still answers, with a note', async () => {
  const l = makeLedger()
  await search('토큰', { env: l.env }) // index once so there is something to read
  chmodSync(l.root, 0o555)
  try {
    if (process.getuid?.() === 0) return // root ignores permissions; the case cannot be staged
    const r = await search('토큰', { env: l.env })
    assert.equal(r.answer.ok, true)
    assert.ok(r.answer.hits.length > 0)
    assert.ok(r.notes.some(n => n.includes('인제스트 실패')), JSON.stringify(r.notes))
  } finally {
    chmodSync(l.root, 0o755)
  }
})

test('a long-lived engine sees compaction done by another process', async () => {
  const l = makeLedger()
  const before = await search('kind:edit', { limit: 100, env: l.env })
  const { open, withLock } = await import('../engine/vhdb.mjs') // another process doing the same thing through its own instance
  const other = await open(l.root, l.env.VHDB_WASM, { sessions: [join(l.root, 'log'), l.sessionsDir] })
  const done = withLock(l.root, () => other.call('compact'))
  assert.equal(done.ok, true, JSON.stringify(done))
  l.add({ v: 1, seq: 101, at: Date.parse('2026-10-02T00:00:00Z'), session: 'sess0001-abcd', turn: 11, kind: 'edit', file: 'src/a.ts' })
  const after = await search('kind:edit', { limit: 100, env: l.env })
  assert.equal(after.answer.ok, true)
  assert.equal(after.answer.hits.length, before.answer.hits.length + 1)
})

test('nothing is created inside the swb ledger directory (only our own directory gets files)', async () => {
  const { readdirSync: ls } = await import('node:fs')
  const l = makeLedger()
  const tree = d => ls(d, { recursive: true }).sort()
  const before = tree(l.swb)
  await search('kind:edit', { env: l.env })
  assert.deepEqual(tree(l.swb), before)
  assert.ok(ls(l.root).includes('MANIFEST'))
})

test('our own log alone is enough when the swb ledger is off, and both are merged when on', async () => {
  const { appendFileSync, mkdirSync } = await import('node:fs')
  const l = makeLedger()
  mkdirSync(join(l.root, 'log'), { recursive: true })
  appendFileSync(join(l.root, 'log', 'vhdb-x.jsonl'), `${JSON.stringify({ v: 1, seq: 1, at: Date.parse('2026-10-03T00:00:00Z'), session: 'vhdb-x', turn: 1, kind: 'decision', topic: '자기로그결정' })}\n`)
  const both = await search('자기로그결정', { env: l.env })
  assert.equal(both.answer.hits.length, 1)
  assert.equal((await search('kind:edit', { limit: 100, env: l.env })).answer.hits.length, 50)
  const off = makeLedger()
  mkdirSync(join(off.root, 'log'), { recursive: true })
  appendFileSync(join(off.root, 'log', 'vhdb-y.jsonl'), `${JSON.stringify({ v: 1, seq: 1, at: 1, session: 'vhdb-y', turn: 1, kind: 'decision', topic: '단독로그' })}\n`)
  const only = await search('단독로그', { env: { ...off.env, VHDB_SWB_SESSIONS: join(off.swb, 'missing') } })
  assert.equal(only.answer.hits.length, 1)
})
