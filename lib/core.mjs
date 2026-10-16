// The Rust core (history logic) as a synchronous, storage-less WASM instance, one per process.
// Every function here is a thin call: `fn('h.verb', jsonValue)` returns the verb's JSON value.
import { loadSync } from '../engine/vhdb.mjs'
import { wasmPath } from './locate.mjs'

const PROTOCOL = 1
let inst = null

function instance() {
  if (!inst) {
    const loaded = loadSync(wasmPath())
    const version = loaded.fn('h.version', null)
    if (version !== PROTOCOL) throw new Error(`vhdb core protocol ${version}, plugin expects ${PROTOCOL}: sync the engine`)
    inst = loaded
  }
  return inst
}

export function fn(verb, value) {
  try {
    return instance().fn(verb, value)
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) inst = null // a trap leaves the instance unusable (panic = abort)
    throw e
  }
}
