// Host side of the VHDB local engine: node loads vhdb.wasm and gives it file access under one root directory.
// Usage from the smart-workbench mod (through $.process.run):
//   node vhdb.mjs <root> stat|ingest|compact|verify|rebuild
//   node vhdb.mjs <root> search [--any] [--limit N] <query...>
//   node vhdb.mjs <root> history [--limit N] <path>
// prints the engine's JSON answer on stdout; exit code 1 when the answer is { ok: false }.
// Commands that write take the LOCK file (pid@host) first, the same lock the native tools use.
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync, mkdirSync, fstatSync, readSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// `sessions` (optional): real directories shown together as the engine's virtual `sessions/` (read-only, first match wins).
// Everything else (data/, index/, MANIFEST, LOCK) lives under `root`. Without it, `root/sessions` is used as before.
// Synchronous, storage-less instance for the stateless `h.*` verbs (history logic). Every file import fails, so it
// can only compute. `fn(verb, value)` sends one JSON value and returns the answer's `value`; { ok: false } throws.
export function loadSync(wasmPath = join(dirname(fileURLToPath(import.meta.url)), 'vhdb.wasm')) {
  const no = () => -2n
  const imports = { vhdb_host: { host_read: no, host_size: no, host_list: no, host_take() {}, host_write_atomic: () => -2, host_remove: () => -2 } }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasmPath)), imports)
  const { memory, vhdb_alloc, vhdb_free, vhdb_call } = instance.exports
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  const call = command => {
    const bytes = enc.encode(command)
    const ptr = vhdb_alloc(bytes.length)
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes)
    const packed = BigInt.asUintN(64, vhdb_call(ptr, bytes.length))
    vhdb_free(ptr, bytes.length)
    const outPtr = Number(packed >> 32n)
    const outLen = Number(packed & 0xffffffffn)
    const answer = JSON.parse(dec.decode(new Uint8Array(memory.buffer, outPtr, outLen)))
    vhdb_free(outPtr, outLen)
    return answer
  }
  return {
    fn(verb, value) {
      // lone surrogates cannot be represented in JSON text the engine parses; JavaScript would send them as \udXXX
      const json = JSON.stringify(value, (_k, v) => (typeof v === 'string' ? v.toWellFormed() : v))
      const answer = call(`${verb} ${json}`)
      if (!answer.ok) throw new Error(answer.error ?? `${verb} failed`)
      return answer.value
    },
  }
}

export async function open(root, wasmPath = join(dirname(fileURLToPath(import.meta.url)), 'vhdb.wasm'), { sessions } = {}) {
  const base = resolve(root)
  const overlay = sessions ? sessions.map(d => resolve(d)) : null
  let memory
  let staged = new Uint8Array(0)
  const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
  // Engine paths are relative and '/'-separated; anything that would leave the root is refused.
  const at = (ptr, len) => {
    const rel = text(ptr, len)
    if (rel.startsWith('/') || rel.split('/').some(part => part === '..' || part === '')) throw new Error(`bad path ${rel}`)
    const full = resolve(base, ...rel.split('/'))
    if (full !== base && !full.startsWith(base + sep)) throw new Error(`bad path ${rel}`)
    if (overlay && rel.startsWith('sessions/')) {
      const name = rel.slice('sessions/'.length)
      for (const dir of overlay) {
        const candidate = join(dir, name)
        try {
          statSync(candidate)
          return candidate
        } catch {
          // try the next directory
        }
      }
      return join(overlay[0] ?? base, name) // absent everywhere: the caller sees ENOENT
    }
    return full
  }

  const host = {
    host_read(pathPtr, pathLen, offset, len) {
      try {
        const fd = openSync(at(pathPtr, pathLen), 'r')
        try {
          const size = fstatSync(fd).size
          const from = Number(offset)
          const rest = Math.max(0, size - from)
          const n = len < 0n ? rest : Math.min(rest, Number(len))
          staged = new Uint8Array(n)
          if (n > 0) readSync(fd, staged, 0, n, from)
          return BigInt(n)
        } finally {
          closeSync(fd)
        }
      } catch (e) {
        return e.code === 'ENOENT' ? -1n : -2n
      }
    },
    host_size(pathPtr, pathLen) {
      try {
        return BigInt(statSync(at(pathPtr, pathLen)).size)
      } catch (e) {
        return e.code === 'ENOENT' ? -1n : -2n
      }
    },
    host_list(dirPtr, dirLen) {
      try {
        if (overlay && text(dirPtr, dirLen) === 'sessions') {
          const names = new Set()
          for (const dir of overlay) {
            try {
              for (const d of readdirSync(dir, { withFileTypes: true })) if (d.isFile() && !d.name.startsWith('.')) names.add(d.name)
            } catch (e) {
              if (e.code !== 'ENOENT') throw e
            }
          }
          staged = new TextEncoder().encode([...names].sort().join('\n'))
          return BigInt(staged.length)
        }
        const names = readdirSync(at(dirPtr, dirLen), { withFileTypes: true }).filter(d => d.isFile() && !d.name.startsWith('.')).map(d => d.name)
        staged = new TextEncoder().encode(names.join('\n'))
        return BigInt(staged.length)
      } catch (e) {
        staged = new Uint8Array(0)
        return e.code === 'ENOENT' ? 0n : -2n
      }
    },
    host_take(dst) {
      new Uint8Array(memory.buffer, dst, staged.length).set(staged)
      staged = new Uint8Array(0)
    },
    host_write_atomic(pathPtr, pathLen, dataPtr, dataLen) {
      try {
        if (overlay && text(pathPtr, pathLen).startsWith('sessions/')) return -2 // the overlay directories are read only
        const target = at(pathPtr, pathLen)
        mkdirSync(dirname(target), { recursive: true })
        const tmp = join(dirname(target), `.${target.split(sep).pop()}.tmp-${process.pid}`)
        const fd = openSync(tmp, 'w')
        try {
          writeSync(fd, new Uint8Array(memory.buffer, dataPtr, dataLen))
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        renameSync(tmp, target)
        try {
          const dfd = openSync(dirname(target), 'r')
          fsyncSync(dfd)
          closeSync(dfd)
        } catch {
          // Directory fsync is not available everywhere (Windows); the rename is still atomic.
        }
        return 0
      } catch {
        return -2
      }
    },
    host_remove(pathPtr, pathLen) {
      try {
        if (overlay && text(pathPtr, pathLen).startsWith('sessions/')) return -2
        rmSync(at(pathPtr, pathLen), { force: true })
        return 0
      } catch {
        return -2
      }
    },
  }

  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), { vhdb_host: host })
  memory = instance.exports.memory
  const { vhdb_alloc, vhdb_free, vhdb_call } = instance.exports

  return {
    root: base,
    call(command) {
      const bytes = new TextEncoder().encode(command)
      const ptr = vhdb_alloc(bytes.length)
      new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes)
      const packed = BigInt.asUintN(64, vhdb_call(ptr, bytes.length))
      vhdb_free(ptr, bytes.length)
      const outPtr = Number(packed >> 32n)
      const outLen = Number(packed & 0xffffffffn)
      const answer = JSON.parse(text(outPtr, outLen))
      vhdb_free(outPtr, outLen)
      return answer
    },
  }
}

// The writer lock: create LOCK exclusively; a lock left by a dead process on this host is taken over.
export function withLock(root, fn) {
  const path = join(resolve(root), 'LOCK')
  const me = `${process.pid}@${hostname()}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, me)
      closeSync(fd)
      try {
        return fn()
      } finally {
        rmSync(path, { force: true })
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const held = readFileSync(path, 'utf8').trim()
      const [pid, host] = held.split('@')
      let alive = host !== hostname()
      if (!alive) {
        try {
          process.kill(Number(pid), 0)
          alive = true
        } catch (err) {
          alive = err.code === 'EPERM'
        }
      }
      if (alive) return { ok: false, error: `locked: ${path} is held by ${held}` }
      rmSync(path, { force: true })
    }
  }
  return { ok: false, error: `locked: could not take ${path}` }
}

const WRITES = new Set(['ingest', 'compact', 'rebuild'])

export function run(engine, argv) {
  const [verb = 'stat', ...rest] = argv
  const flag = name => {
    const i = rest.indexOf(name)
    if (i < 0) return undefined
    const [, value] = rest.splice(i, 2)
    return value
  }
  if (verb === 'search') {
    const any = rest.includes('--any')
    if (any) rest.splice(rest.indexOf('--any'), 1)
    const limit = Number(flag('--limit') ?? 20)
    return engine.call(`search ${Date.now()} ${limit} ${any ? 1 : 0} ${rest.join(' ')}`)
  }
  if (verb === 'history') {
    const limit = Number(flag('--limit') ?? 5)
    return engine.call(`history ${limit} ${rest.join(' ')}`)
  }
  return WRITES.has(verb) ? withLock(engine.root, () => engine.call(verb === 'ingest' && process.env.VHDB_TIER === '1' ? `ingest ${Date.now()}` : verb)) : engine.call(verb)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...argv] = process.argv.slice(2)
  if (!root) {
    console.error('usage: node vhdb.mjs <root> stat|ingest|compact|verify|rebuild | search [--any] [--limit N] <query> | history [--limit N] <path>')
    process.exit(2)
  }
  try {
    statSync(root)
  } catch {
    console.error(`vhdb: ${root} does not exist`)
    process.exit(2)
  }
  const answer = run(await open(root), argv)
  process.stdout.write(`${JSON.stringify(answer)}\n`)
  process.exit(answer.ok ? 0 : 1)
}
