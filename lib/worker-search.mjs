// Runs in a worker thread: open the engine (no ingest) and search, so the hook can give up on a slow answer.
import { parentPort, workerData } from 'node:worker_threads'
import { open } from '../engine/vhdb.mjs'

try {
  const { root, wasm, sessions, query, limit } = workerData
  if (workerData.delayMs) await new Promise(r => setTimeout(r, workerData.delayMs)) // tests only: simulate a slow search
  const engine = await open(root, wasm, { sessions })
  parentPort.postMessage(engine.call(`searchp ${workerData.now} ${limit} 1 3 ${query}`))
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e.message ?? e) })
}
