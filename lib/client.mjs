// Thin client over the vendored engine: ingest the ledger tail, then answer. Only ingest/search/history/stat are sent.
// sessions/ is never written; the engine reads it and keeps its derived files in data/, index/ and MANIFEST.
import { open, withLock } from '../engine/vhdb.mjs'
import { LocateError, ledgerDir, normalizeFile, wasmPath } from './locate.mjs'

let cached = null // { root, wasm, engine }

async function engineFor(root, wasm) {
  if (!cached || cached.root !== root || cached.wasm !== wasm) {
    cached = { root, wasm, engine: await open(root, wasm) }
  }
  return cached.engine
}

const oneLine = s => String(s).replace(/[\r\n]+/g, ' ').trim()

// Ingest first so lines written a moment ago are visible. A held lock or a damaged store only adds a note.
async function prepared(env) {
  const root = ledgerDir(env)
  const wasm = wasmPath(env)
  const engine = await engineFor(root, wasm)
  const notes = []
  const ing = withLock(root, () => engine.call('ingest'))
  if (!ing.ok) {
    if (String(ing.error).startsWith('locked')) notes.push('다른 프로세스가 인제스트 중: 최근 기록이 빠질 수 있음')
    else notes.push(`인제스트 실패: ${ing.error}${ing.corrupt ? ' (vhdb rebuild 필요)' : ''}`)
  }
  return { root, engine, notes }
}

async function guarded(env, fn) {
  try {
    const ctx = await prepared(env)
    return { ...fn(ctx.engine), notes: ctx.notes, root: ctx.root }
  } catch (e) {
    if (e instanceof LocateError) throw e
    cached = null // a wasm trap leaves the instance unusable
    throw e
  }
}

export function search(query, { limit = 10, any = false, env = process.env } = {}) {
  return guarded(env, engine => ({ answer: engine.call(`search ${Date.now()} ${limit} ${any ? 1 : 0} ${oneLine(query)}`) }))
}

export function history(path, { limit = 5, env = process.env } = {}) {
  return guarded(env, engine => ({ answer: engine.call(`history ${limit} ${normalizeFile(oneLine(path), env)}`) }))
}

export function stat({ env = process.env } = {}) {
  return guarded(env, engine => ({ answer: engine.call('stat') }))
}
