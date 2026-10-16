// The plugin's own append-only log: <vhdb dir>/log/vhdb-<claude session id>.jsonl, one JSON object per line.
// Every hook is a separate process, so seq/turn live in a small state file guarded by a per-session lock.
// The engine drops an event whose seq is not above the session's last one, so seq must grow in file order.
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { vhdbDir } from './locate.mjs'

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function safeId(id) {
  const s = String(id ?? '')
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : createHash('sha1').update(s).digest('hex').slice(0, 16)
}

function alive(held) {
  const [pid, host] = held.split('@')
  if (!pid || !host) return false
  if (host !== hostname()) return true
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

const STALE_MS = 15000 // hooks are killed after 10s, so a lock older than this is dead whatever its pid says

// Exclusive lock file holding pid@host. The content is written before the file appears (link of a temp file), so an
// empty lock never exists. A stale lock (dead pid, or older than STALE_MS) is moved aside with one atomic rename;
// whoever wins the rename retries the create. Gives up after ~3s.
export function lock(path) {
  const me = `${process.pid}@${hostname()}`
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, me)
  try {
    for (let i = 0; i < 300; i++) {
      try {
        linkSync(tmp, path)
        return () => {
          try {
            if (readFileSync(path, 'utf8') === me) rmSync(path, { force: true }) // never remove somebody else's lock
          } catch {
            // already gone
          }
        }
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
      let held = ''
      let age = 0
      try {
        held = readFileSync(path, 'utf8').trim()
        age = Date.now() - statSync(path).mtimeMs
      } catch {
        continue // released between the check and the read
      }
      if (!alive(held) || age > STALE_MS) {
        const aside = `${path}.stale-${process.pid}-${i}`
        try {
          renameSync(path, aside)
          // we may have moved a fresh lock somebody took in between: put it back if the name is still free
          if (readFileSync(aside, 'utf8').trim() !== held) {
            try {
              linkSync(aside, path)
            } catch {
              // lost the race; the other holder will notice nothing, the worst case is one skipped record
            }
          }
          rmSync(aside, { force: true })
        } catch {
          // somebody else moved it first
        }
      } else {
        sleep(10)
      }
    }
    throw new Error(`lock timeout: ${path}`)
  } finally {
    rmSync(tmp, { force: true })
  }
}

const logSizeOf = path => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

const paths = (env, sid) => {
  const dir = vhdbDir(env)
  const id = safeId(sid)
  return { id, log: join(dir, 'log', `vhdb-${id}.jsonl`), state: join(dir, 'state', `sess-${id}.json`), lock: join(dir, 'state', `sess-${id}.lock`) }
}

// Rebuild seq/turn from the last complete line of the log when the state file is missing or damaged.
function recover(logPath) {
  let seq = 0
  let turn = 0
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n')
    for (let i = lines.length - 2; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i])
        seq = ev.seq
        turn = ev.turn ?? 0
        break
      } catch {
        // skip a torn line
      }
    }
  } catch {
    // no log yet
  }
  return { seq, turn }
}

// fn({ state, emit }) runs under the session lock. state is {seq, turn, ...extra} and is saved afterwards.
export function withSession(env, sid, fn) {
  const p = paths(env, sid)
  mkdirSync(join(vhdbDir(env), 'log'), { recursive: true })
  mkdirSync(join(vhdbDir(env), 'state'), { recursive: true })
  const unlock = lock(p.lock)
  try {
    let state
    try {
      state = JSON.parse(readFileSync(p.state, 'utf8'))
      if (!Number.isInteger(state.seq) || !Number.isInteger(state.turn)) throw new Error('bad state')
    } catch {
      state = { ...recover(p.log) }
    }
    // A crash between appending a line and saving the state (or a removed state file) must never make seq go back:
    // the engine drops any event whose seq is not above the last one it saw.
    const size = logSizeOf(p.log)
    if (state.logSize !== size) {
      const rec = recover(p.log)
      state.seq = Math.max(state.seq, rec.seq)
      state.turn = Math.max(state.turn, rec.turn)
    }
    const emit = (kind, fields = {}) => {
      state.seq += 1
      const ev = { v: 1, seq: state.seq, at: Date.now(), session: `vhdb-${p.id}`, turn: state.turn, kind, cs: p.id, ...fields }
      const fd = openSync(p.log, 'a')
      try {
        writeSync(fd, `${JSON.stringify(ev)}\n`) // one write, so concurrent readers never see half a line
      } finally {
        closeSync(fd)
      }
      return ev
    }
    const result = fn({ state, emit })
    state.logSize = logSizeOf(p.log)
    const tmp = `${p.state}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, p.state)
    return result
  } finally {
    unlock()
  }
}

export const logSize = (env, sid) => {
  try {
    return statSync(paths(env, sid).log).size
  } catch {
    return 0
  }
}
