// Temporary ledger like smart-workbench writes it: <dir>/sessions/s1.jsonl.
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WASM = process.env.VHDB_WASM || fileURLToPath(new URL('../engine/vhdb.wasm', import.meta.url))

export function makeLedger() {
  const top = mkdtempSync(join(tmpdir(), 'vhdb-plugin-'))
  const swb = join(top, 'swb-ledger') // stands in for smart-workbench's ledger: the plugin only reads it
  const root = join(top, 'vhdb') // the plugin's own directory (engine files, our log)
  mkdirSync(join(swb, 'sessions'), { recursive: true })
  const log = join(swb, 'sessions', 's1.jsonl')
  for (let seq = 1; seq <= 100; seq++) {
    const edit = seq % 2 === 0
    appendFileSync(log, `${JSON.stringify({ v: 1, seq, at: Date.parse('2026-10-01T00:00:00Z') + seq * 1000, session: 'sess0001-abcd', turn: 1 + Math.floor(seq / 10), kind: edit ? 'edit' : 'prompt', ...(edit ? { file: seq % 4 ? 'src/a.ts' : 'src/b.ts' } : { text: `토큰 갱신 ${seq}` }) })}\n`)
  }
  return { root, swb, sessionsDir: join(swb, 'sessions'), log, env: { VHDB_DIR: root, VHDB_SWB_SESSIONS: join(swb, 'sessions'), VHDB_WASM: WASM }, add: ev => appendFileSync(log, `${JSON.stringify(ev)}\n`) }
}
