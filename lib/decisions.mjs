// Decisions are events of kind "decision" in our own log. A decision is superseded when a later one names it in
// `supersedes`; status is computed when asked, never stored.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fn } from './core.mjs'
import { logDir } from './locate.mjs'

const cache = new Map() // file -> { sig, events }

function readLog(file) {
  let st
  try {
    st = statSync(file)
  } catch {
    return [] // removed between readdir and stat
  }
  const sig = `${st.size}:${st.mtimeMs}`
  const hit = cache.get(file)
  if (hit?.sig === sig) return hit.events
  const events = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"decision"')) continue
    try {
      const ev = JSON.parse(line)
      if (ev.kind === 'decision' && typeof ev.id === 'string') events.push(ev)
    } catch {
      // torn line
    }
  }
  cache.set(file, { sig, events })
  return events
}

// Map id -> { ...decision, status: 'active' | 'superseded', supersededBy } (status is computed by the Rust core)
export function readDecisions(env = process.env) {
  const dir = logDir(env)
  let files = []
  try {
    files = readdirSync(dir).filter(n => n.startsWith('vhdb-') && n.endsWith('.jsonl')).map(n => join(dir, n))
  } catch {
    return new Map()
  }
  const resolved = fn('h.decisions_resolve', files.flatMap(readLog))
  return new Map(resolved.map(d => [d.id, d]))
}

// Follow supersededBy to the decision that is in force now.
export const chainEnd = (map, id) => fn('h.decisions_chain_end', { decisions: [...map.values()], id })
