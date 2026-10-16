import assert from 'node:assert/strict'
import test from 'node:test'
import { FOOTER, formatHistory, formatSearch, redact } from '../lib/format.mjs'

const ev = (over = {}) => ({ session: 'abcdef012345', turn: 3, at: Date.parse('2026-10-01T12:34:00Z'), kind: 'prompt', text: 'hello', ...over })

test('line shape, UTC time, footer', () => {
  const t = formatSearch({ root: '/l', answer: { ok: true, hits: [{ record: ev() }] }, notes: [] })
  assert.match(t, /\[prompt\] 2026-10-01 12:34 UTC s:abcdef01 t:3 hello/)
  assert.ok(t.endsWith(FOOTER))
})

test('tool.end output is never replayed', () => {
  const t = formatSearch({ root: '/l', answer: { ok: true, hits: [{ record: ev({ kind: 'tool.end', tool: 'Bash', output: 'TOP SECRET BODY', text: 'TOP SECRET BODY' }) }] }, notes: [] })
  assert.ok(!t.includes('TOP SECRET BODY'))
})

test('secrets are masked', () => {
  const t = redact('key sk-abcdefghijklmnopqrstuv and GITHUB_TOKEN=abc123 and Bearer abcdefghijklmnop')
  assert.ok(!t.includes('abcdefghijklmnopqrstuv') && !t.includes('abc123') && !t.includes('Bearer abcdefghijklmnop'))
})

test('budget cuts the tail and says how many were skipped', () => {
  const hits = Array.from({ length: 80 }, (_, i) => ({ record: ev({ text: `항목 ${i} ${'가'.repeat(200)}` }) }))
  const t = formatSearch({ root: '/l', answer: { ok: true, hits }, notes: [] })
  assert.ok(t.length <= 4300, String(t.length))
  assert.match(t, /… \d+건 생략/)
})

test('empty results and notes', () => {
  const t = formatSearch({ root: '/l', answer: { ok: true, hits: [] }, notes: ['잠김'] })
  assert.match(t, /결과 없음/)
  assert.match(t, /⚠ 잠김/)
  assert.match(formatHistory({ root: '/l', answer: { ok: true, turns: [] }, notes: [] }, 'x.ts'), /이력 없음/)
})

test('engine errors surface', () => {
  assert.throws(() => formatSearch({ answer: { ok: false, error: 'bad query' } }), /bad query/)
})
