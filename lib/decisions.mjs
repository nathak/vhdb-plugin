// Decisions are events of kind "decision" in our own log. A decision is superseded when a later one names it in
// `supersedes`; status is computed when asked, never stored.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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

// Map id -> { ...decision, status: 'active' | 'superseded', supersededBy }
export function readDecisions(env = process.env) {
  const dir = logDir(env)
  let files = []
  try {
    files = readdirSync(dir).filter(n => n.startsWith('vhdb-') && n.endsWith('.jsonl')).map(n => join(dir, n))
  } catch {
    return new Map()
  }
  const all = files.flatMap(readLog).sort((a, b) => a.at - b.at || a.seq - b.seq)
  const out = new Map(all.map(d => [d.id, { ...d, status: 'active' }]))
  for (const d of all) {
    const target = d.supersedes && out.get(d.supersedes)
    if (target && target.status === 'active') Object.assign(target, { status: 'superseded', supersededBy: d.id })
  }
  return out
}

// Follow supersededBy to the decision that is in force now.
export function chainEnd(map, id) {
  let cur = map.get(id)
  const seen = new Set()
  while (cur?.supersededBy && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = map.get(cur.supersededBy)
  }
  return cur?.id ?? id
}
