import assert from 'node:assert/strict'
import test from 'node:test'
import { classify } from '../lib/checks.mjs'
import { fingerprint } from '../lib/fingerprint.mjs'

const opts = { repoTop: '/home/me/proj', home: '/home/me' }
const same = (a, b) => assert.equal(fingerprint(a, opts).fp, fingerprint(b, opts).fp)
const differ = (a, b) => assert.notEqual(fingerprint(a, opts).fp, fingerprint(b, opts).fp)

test('node stack: run-specific noise does not change the key, a different cause does', () => {
  const a = `Exit code 1\nTypeError: Cannot read properties of undefined (reading 'token')\n    at refresh (/home/me/proj/src/auth.js:41:13)\n    at /home/me/proj/node_modules/x/index.js:9:1\n    at 2026-10-01T10:00:01Z took 12ms`
  const b = `Exit code 1\nTypeError: Cannot read properties of undefined (reading 'token')\n    at refresh (/home/me/proj/src/auth.js:57:9)\n    at /home/me/proj/node_modules/x/index.js:77:3\n    at 2026-10-09T23:59:59Z took 340ms`
  same(a, b)
  const f = fingerprint(a, opts)
  assert.equal(f.type, 'TypeError')
  assert.equal(f.file, 'src/auth.js')
  assert.deepEqual(f.loc.slice(0, 1), ['src/auth.js:41'])
  differ(a, a.replace("reading 'token'", "reading 'expires'"))
  differ(a, a.replaceAll('src/auth.js', 'src/user.js'))
})

test('absolute, tmp and home paths and ids are normalised', () => {
  const mk = (tmp, id) => `Error: ENOENT: no such file or directory, open '${tmp}/fixture-${id}/data.json'\n    at load (/home/me/proj/lib/load.js:3:1)`
  same(mk('/tmp/jest_abc', 'a1b2c3d4'), mk('/var/folders/zz/T/jest_xyz', '99887766'))
  same(`Error: boom at /home/me/proj/src/a.ts:1`, `Error: boom at src/a.ts:99`)
})

test('cargo, tsc, pytest and jest output', () => {
  const cargo = n => `error[E0308]: mismatched types\n --> src/engine.rs:${n}:9\n  |\n${n} |     let x: u32 = "a";\nerror: could not compile \`vhdb-core\` (lib) due to 1 previous error`
  same(cargo(10), cargo(250))
  assert.equal(fingerprint(cargo(10), opts).type, 'E0308')
  differ(cargo(10), cargo(10).replace('E0308', 'E0599').replace('mismatched types', 'no method named foo'))
  const tsc = n => `src/a.ts(${n},5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`
  assert.equal(fingerprint(tsc(3), opts).type, 'TS2345')
  const py = n => `E   AssertionError: assert 1 == 2\ntests/test_a.py:${n}: AssertionError\n=== short test summary info ===\nFAILED tests/test_a.py::test_x - AssertionError`
  same(py(12), py(30))
  const jest = d => `● auth › refresh\n\n  expect(received).toBe(expected)\n\n  Expected: 2\n  Received: 1\n\n    at Object.<anonymous> (src/auth.test.js:14:21)\nTests: 1 failed in ${d}s`
  same(jest(1.2), jest(9.8))
})

test('nothing to fingerprint -> null; noise lines alone are skipped', () => {
  assert.equal(fingerprint('', opts), null)
  assert.equal(fingerprint('Exit code 1\n', opts), null)
  assert.match(fingerprint('npm ERR! code ELIFECYCLE\nSyntaxError: Unexpected token }', opts).sig, /SyntaxError/)
})

test('check classification and keys', () => {
  assert.deepEqual(classify('npm test'), { check: 'test', key: 'npm test', masked: false })
  assert.equal(classify('cd app && NODE_ENV=test pnpm run test -- --watch=false').check, 'test')
  assert.equal(classify('cd app && NODE_ENV=test pnpm run test -- --watch=false').key, 'pnpm run test -- --watch=false')
  assert.equal(classify('cargo clippy --all-targets').check, 'lint')
  assert.equal(classify('npx tsc --noEmit').check, 'typecheck')
  assert.equal(classify('cargo build --release').check, 'build')
  assert.equal(classify('pytest -x tests/').check, 'test')
  assert.equal(classify('git commit -m "run npm test"'), null)
  assert.equal(classify('echo vitest'), null)
  assert.equal(classify('ls -la'), null)
})

test('pipelines and redirections: same key, but the exit status is flagged as hidden', () => {
  const piped = classify('npm test 2>&1 | tail -30')
  assert.equal(piped.key, 'npm test')
  assert.equal(piped.masked, true)
  assert.equal(classify('npm test 2>&1').masked, false)
  assert.equal(classify('npm test 2>&1').key, 'npm test')
  assert.equal(classify('cargo test > out.txt').key, 'cargo test')
  assert.equal(classify('npm test || true').masked, true)
  assert.equal(classify('npm test; true').masked, true)
  assert.equal(classify('npm run build && npm test').masked, false)
})
