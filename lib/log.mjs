// The plugin's own append-only log: <vhdb dir>/log/vhdb-<claude session id>.jsonl, one JSON object per line.
// Every hook is a separate process, so seq/turn live in a small state file guarded by a per-session lock.
// The engine drops an event whose seq is not above the session's last one, so seq must grow in file order.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
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
  if (host !== hostname()) return true
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// Exclusive lock file (pid@host); a lock left by a dead process on this host is taken over. Gives up after ~3s.
export function lock(path) {
  const me = `${process.pid}@${hostname()}`
  for (let i = 0; i < 300; i++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, me)
      closeSync(fd)
      return () => rmSync(path, { force: true })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let held = ''
      try {
        held = readFileSync(path, 'utf8').trim()
      } catch {
        continue // released between the check and the read
      }
      if (held && !alive(held)) rmSync(path, { force: true })
      else sleep(10)
    }
  }
  throw new Error(`lock timeout: ${path}`)
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
