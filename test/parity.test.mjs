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
// JavaScript can end a cut string with half of a surrogate pair; it becomes U+FFFD as soon as it is encoded. Rust
// holds U+FFFD from the start, so expected values are made well-formed before comparing.
const wf = v => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' ? x.toWellFormed() : x)))
const same = (name, actual, expected, input) => assert.deepEqual(actual, wf(expected), `${name} differs for ${JSON.stringify(input)}`)

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
    same('tokens', [...fn('h.tokens', s)].sort(), [...oracleInject.tokens(s)].sort(), s)
    same('estimate', fn('h.estimate_tokens', s), oracleInject.estimateTokens(s), s)
  }
})

test(`safe: ${N} random strings and cut lengths`, () => {
  const next = rng(3)
  for (let i = 0; i < N; i++) {
    const s = sample(next)
    const max = 1 + Math.floor(next() * 80)
    const want = oracleInject.safe(s, max)
    const got = fn('h.safe', { s, max })
    same('safe', got, want, { s, max })
  }
})

test('sha1 equals node crypto', () => {
  const next = rng(4)
  for (let i = 0; i < 2000; i++) {
    const s = sample(next).repeat(1 + Math.floor(next() * 5))
    same('sha1', fn('h.sha1', s), createHash('sha1').update(s).digest('hex'), s)
  }
})

// ---- R2: command classification, sensitivity, error fingerprints ----
import * as oracleChecks from './oracle/checks.mjs'
import * as oracleFp from './oracle/fingerprint.mjs'
import { SENSITIVE as ORACLE_SENSITIVE } from './oracle/sensitive.mjs'

const CMD_FRAGMENTS = [
  'npm test', 'npm run test', 'pnpm run test', 'yarn test', 'cargo test', 'cargo build --release', 'cargo clippy', 'cargo fmt', 'tsc', 'tsc --noEmit', 'npx tsc',
  'pytest -x', 'jest', 'vitest run', 'go test ./...', 'go vet', 'make', 'make test', 'eslint .', 'node --test', 'node a.js', 'ls -la', 'echo ok', 'git status', 'cat .env',
  'npm i jest', 'pip install pytest', 'cd app', 'cd "my dir"', "cd 'x y'", ' && ', ' || ', ' ; ', ' | ', ' | tail -30', ' &', '\n', ' 2>&1', ' > out.txt', ' 2>/dev/null', ' < in.txt',
  '&>log', ' -- --watch=false', 'NODE_ENV=test ', 'CI=1 ', 'FOO=bar ', ' "a; b" ', " 'c | d' ", '"unterminated', 'printenv', 'env', 'set', 'export -p', ' postgres://u:pw@h/db ',
  'AWS_SECRET_ACCESS_KEY=x ', '.pem', 'id_rsa', 'secrets', 'password', 'API_KEY', '\r\n', '\u2028', '\u00a0', '\t', '  ', '가나다', '😀', 'mvn clean test', 'gradle test', 'dotnet test', 'bun test',
]
const OUT_FRAGMENTS = [
  'TypeError: ', 'Error: ', 'RangeError: ', 'AssertionError ', 'KeyError: ', 'NullPointerException', 'java.lang.IllegalStateException: ', "Cannot read properties of undefined (reading 'token')", 'boom',
  '\n', '\n', '\n', '    at ', 'refresh (', '/home/me/proj/src/a.js:41:13)', '/home/me/proj/', '/home/me/', 'src/b.ts(10,5): error TS2345: ', 'error[E0308]: ', 'error TS2304: ', 'error CS0103: ',
  'mismatched types', ' --> src/engine.rs:10:9', 'File "app/x.py", line 12, in f', 'E   ', 'FAIL ', 'PASS ', '● ', 'not ok 1 - ', '  ---', 'duration_ms: 1.2', 'type: ', 'name: ', 'code: ',
  'npm ERR! ', 'npm notice ', '> pkg@1.2.3 build', 'Exit code 1\n', 'Exit code 127', '\x1b[31m', '\x1b[0m', '\r', '123', 'deadbeef12', 'DEADBEEF12', '0xFF', '0x1a2b', 'abcdef12', 'abcdefg',
  '550e8400-e29b-41d4-a716-446655440000', '2026-10-01T10:00:01Z', '2026-10-01 10:00:01.123+09:00', '12ms', '1.5s', '3 sec', '2 seconds', '7µs', '/tmp/x/y', '/var/folders/zz/T/jest_x', '/private/tmp/a',
  'node_modules/x/index.js:9:1', '.cargo/registry/src/a.rs:5', 'site-packages/p.py:3', 'node:internal/modules:1:1', '<anonymous>', 'src/user.js:7', './lib/load.js:3:1', 'C:\\proj\\a.ts:3',
  '한글 오류', '😀', 'Ünï', 'panicked at ', "'src/lib.rs:1:1'", 'Uncaught ', 'Caused by: ', 'error: ', 'error: could not compile `x`', 'make: *** [all] Error 2', '=== short test summary info ===',
  ' ', '  ', '\t', '\u00a0', '\u2028', 'ECONNRESET', 'ENOENT: no such file', 'Test failed. See above for more details.', 'Expected: 2', 'Received: 1', 'x'.repeat(170), 'ERR_ASSERTION',
]

function build(next, fragments, max) {
  const n = 1 + Math.floor(next() * max)
  let s = ''
  for (let i = 0; i < n; i++) s += fragments[Math.floor(next() * fragments.length)]
  return s
}

const NF = 20000

test(`classify / is_sensitive: ${NF} random commands`, () => {
  const next = rng(11)
  for (let i = 0; i < NF; i++) {
    const c = build(next, CMD_FRAGMENTS, 8)
    same('classify', fn('h.classify', c), oracleChecks.classify(c), c)
    same('sensitive', fn('h.is_sensitive', c), ORACLE_SENSITIVE.test(c), c)
  }
})

test(`fingerprint: ${NF} random outputs (with and without repo/home prefixes)`, () => {
  const next = rng(12)
  let produced = 0
  for (let i = 0; i < NF; i++) {
    const out = build(next, OUT_FRAGMENTS, 30)
    const opts = next() < 0.8 ? { repoTop: '/home/me/proj', home: '/home/me' } : {}
    const want = oracleFp.fingerprint(out, opts)
    if (want) produced++
    same('fingerprint', fn('h.fingerprint', { output: out, repo_top: opts.repoTop ?? '', home: opts.home ?? '' }), want, { out, opts })
  }
  assert.ok(produced > NF / 2, `only ${produced} outputs produced a fingerprint; the generator is too weak`)
})

// ---- R3: analysis of failed/passing commands, error-cache transitions, decision state ----
import * as oracleEv from './oracle/events.mjs'

const ROOT = '/home/me/proj'
const optional = (next, v) => (next() < 0.7 ? v : undefined)

function randomFail(next) {
  return {
    command: build(next, CMD_FRAGMENTS, 8),
    error: build(next, OUT_FRAGMENTS, 25),
    tool_name: optional(next, 'Bash'),
    tool_use_id: optional(next, `tu${Math.floor(next() * 1000)}`),
    interrupt: next() < 0.05,
    root: next() < 0.9 ? ROOT : '',
    rel: next() < 0.5 ? '' : 'packages/b',
    home: next() < 0.8 ? '/home/me' : '',
  }
}

test(`analyze_fail: ${NF} random failures`, () => {
  const next = rng(21)
  let produced = 0
  for (let i = 0; i < NF; i++) {
    const input = randomFail(next)
    const want = oracleEv.analyzeFail(input)
    if (want) produced++
    same('analyze_fail', fn('h.analyze_fail', input), want, input)
  }
  assert.ok(produced > NF / 3, `only ${produced} produced an analysis`)
})

test(`analyze_pass: ${NF} random commands`, () => {
  const next = rng(22)
  for (let i = 0; i < NF; i++) {
    const input = { command: build(next, CMD_FRAGMENTS, 8), tool_use_id: optional(next, 'tu1'), run_in_background: next() < 0.1 ? true : undefined, root: ROOT, rel: next() < 0.5 ? '' : 'pkg' }
    same('analyze_pass', fn('h.analyze_pass', input), oracleEv.analyzePass(input), input)
  }
})

test('error cache: 5,000 random operation sequences give the same cache, prior, resolves and pruning', () => {
  const next = rng(23)
  const pick = a => a[Math.floor(next() * a.length)]
  const sortResolves = r => [...r].sort((a, b) => (a.fp < b.fp ? -1 : 1))
  for (let run = 0; run < 5000; run++) {
    let cache = {}
    let now = 1000
    const edits = []
    for (let step = 0; step < 12; step++) {
      now += 1 + Math.floor(next() * 50)
      const cs = pick(['s1', 's2', 's3'])
      if (next() < 0.3) edits.push({ file: pick(['a.js', 'b.js', 'c.js']), at: now - Math.floor(next() * 80) })
      if (next() < 0.6) {
        const input = { cache, fp: pick(['f1', 'f2', 'f3', 'f4']), etype: pick(['test', 'build', 'runtime']), sig: 'sig', key: pick(['npm test', 'cargo build']), scope: pick(['sc1', 'sc2']), files: [pick(['a.js', 'b.js'])], now, cs }
        const want = oracleEv.errorsFail(input)
        const got = fn('h.errors_fail', input)
        same('errors_fail', got, want, input)
        cache = want.cache
      } else {
        const input = { cache, key: pick(['npm test', 'cargo build']), scope: pick(['sc1', 'sc2']), now, cs, turn: Math.floor(next() * 5), edits }
        const want = oracleEv.errorsPass(input)
        const got = fn('h.errors_pass', input)
        same('errors_pass cache', got.cache, want.cache, input)
        same('errors_pass resolves', sortResolves(got.resolves), sortResolves(want.resolves), input) // order of closing is by fingerprint in Rust
        cache = want.cache
      }
      const open_fps = ['f1', 'f2', 'f3', 'f4', 'nope'].filter(() => next() < 0.6)
      same('errors_prune', fn('h.errors_prune', { cache, open_fps }), oracleEv.errorsPrune({ cache, open_fps }), open_fps)
    }
  }
})

test('decisions: random supersede graphs resolve and chain identically', () => {
  const next = rng(24)
  const ids = Array.from({ length: 8 }, (_, i) => `d-${i}`)
  for (let run = 0; run < 3000; run++) {
    const events = Array.from({ length: 1 + Math.floor(next() * 8) }, (_, i) => ({
      id: ids[Math.floor(next() * ids.length)], at: Math.floor(next() * 5), seq: i, topic: 't', ...(next() < 0.6 ? { supersedes: ids[Math.floor(next() * ids.length)] } : {}),
    }))
    const want = oracleEv.decisionsResolve(events)
    const got = fn('h.decisions_resolve', events)
    same('decisions_resolve', got, want, events)
    for (const id of [...ids, 'zz']) same('chain_end', fn('h.decisions_chain_end', { decisions: got, id }), oracleEv.chainEnd(want, id), { events, id })
  }
})
