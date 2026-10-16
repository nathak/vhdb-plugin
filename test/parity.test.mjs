// While the history logic moves from JavaScript to the Rust core, the old JavaScript lives in test/oracle/ and
// every function is compared with the Rust answer on the same input. Seeded, so a failure reproduces.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fn } from '../lib/core.mjs'
import * as oracleRedact from './oracle/redact.mjs'
import * as oracleInject from './oracle/inject.mjs'

export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FRAGMENTS = [
  'PASSWORD=', 'hunter2', ' ', '  ', '\n', '\t', '\r\n', ' ', '﻿', ' ', '　', 'sk-', 'abcdefghijklmnopqrstuvwx', 'ghp_', 'AKIA',
  'ABCDEFGHIJKLMNOP', 'Bearer ', 'eyJhbGciOiJI', '.', '_', '-', '/', 'https://', 'user:pw@host', 'Authorization: Basic ', 'xoxb-', '"', "'",
  '<', '>', '&', '가나다', '😀', '토큰', '갱신', '에서', '합니다', 'src/auth.js', 'TOKEN', 'api_key', 'API_KEY', 'AWS_SECRET_ACCESS_KEY', ':', '=', '--password ',
  'x'.repeat(30), '-----BEGIN RSA PRIVATE KEY-----', '-----END RSA PRIVATE KEY-----', '‮', '\u0085', '​', '＜', '‹', 'The', 'the', 'refreshToken',
  'snake_case_name', 'kebab-case-name', 'A1', 'Ünïcödé', 'İ', 'ſ', 'K', 'sk_live_', 'glpat-', 'npm_', 'AIza', '\u0000', '\u007f', 'a', 'Z', '0', '9',
]

function sample(next) {
  const n = 1 + Math.floor(next() * 24)
  let s = ''
  for (let i = 0; i < n; i++) s += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]
  return s
}

const N = 20000
const same = (name, actual, expected, input) => assert.deepEqual(actual, expected, `${name} differs for ${JSON.stringify(input)}`)

test(`redact: ${N} random strings give identical output`, () => {
  const next = rng(1)
  for (let i = 0; i < N; i++) {
    const s = sample(next)
    same('redact', fn('h.redact', s), oracleRedact.redact(s), s)
  }
})

test(`tokens / estimate_tokens: ${N} random strings`, () => {
  const next = rng(2)
  for (let i = 0; i < N; i++) {
    const s = sample(next)
    same('tokens', new Set(fn('h.tokens', s)), oracleInject.tokens(s), s)
    same('estimate', fn('h.estimate_tokens', s), oracleInject.estimateTokens(s), s)
  }
})

test(`safe: ${N} random strings and cut lengths (lone surrogates at a cut are the one documented difference)`, () => {
  const next = rng(3)
  for (let i = 0; i < N; i++) {
    const s = sample(next)
    const max = 1 + Math.floor(next() * 80)
    const want = oracleInject.safe(s, max)
    const got = fn('h.safe', { s, max })
    // JavaScript may cut through a surrogate pair and keep half of it; Rust drops the whole pair.
    const expected = /[\ud800-\udbff]…$/.test(want) ? want.replace(/[\ud800-\udbff]…$/, '…') : want
    same('safe', got, expected, { s, max })
  }
})

test('sha1 equals node crypto', () => {
  const next = rng(4)
  for (let i = 0; i < 2000; i++) {
    const s = sample(next).repeat(1 + Math.floor(next() * 5))
    same('sha1', fn('h.sha1', s), createHash('sha1').update(s).digest('hex'), s)
  }
})
