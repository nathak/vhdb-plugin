// ORACLE (pre-Rust JavaScript, kept only to prove the Rust port gives identical results; deleted in R5)
// The pure parts of hooks.mjs / decisions.mjs as they were before the move, with the I/O taken out.
import { createHash } from 'node:crypto'
import { classify } from './checks.mjs'
import { fingerprint } from './fingerprint.mjs'
import { redact } from './redact.mjs'
import { SENSITIVE } from './sensitive.mjs'

const TAIL = 4096
const scopeOf = (root, rel, check) => createHash('sha1').update(`${root}|${rel}|${check?.cwd ?? ''}`).digest('hex').slice(0, 8)

export function analyzeFail({ command, error, tool_name, tool_use_id, interrupt, root, rel, home }) {
  if (interrupt) return null
  const raw = String(error ?? '')
  const exit = /^Exit code (\d+)/.exec(raw)?.[1]
  const check = classify(command)
  const sensitive = SENSITIVE.test(command)
  const fpr = fingerprint(redact(raw), { repoTop: root, home })
  if (!fpr) return null
  if (sensitive) Object.assign(fpr, { sig: '(비공개)', loc: [], file: '' })
  const etype = check && !check.compound ? check.check : 'runtime'
  const key = sensitive ? '(비공개)' : redact(check?.key ?? command).replace(/\s+/g, ' ').slice(0, 200)
  const scope = scopeOf(root, rel, check ?? {})
  const candidates = [...new Set(fpr.loc.map(w => w.replace(/:\d+$/, '')))]
  const shown = sensitive ? '' : redact(command).slice(0, 300)
  const sig = redact(fpr.sig)
  return {
    fp: fpr.fp, etype, key, scope, sig, candidates,
    error_event: { tool: tool_name, etype, exit: exit === undefined ? null : Number(exit), fp: fpr.fp, sig, loc: fpr.loc, key, command: shown, tail: sensitive ? '' : redact(raw.slice(-TAIL)), tool_use_id },
    check_event: check ? { check: check.check, key, command: shown, outcome: 'fail', fps: [fpr.fp], tool_use_id } : null,
  }
}

export function analyzePass({ command, tool_use_id, run_in_background, root, rel }) {
  const check = classify(command)
  if (!check) return null
  const shown = SENSITIVE.test(command) ? '' : redact(command).slice(0, 300)
  const hidden = check.masked || run_in_background
  const key = redact(check.key)
  return { event: { check: check.check, key, command: shown, outcome: hidden ? 'unknown' : 'pass', tool_use_id }, close: !hidden, key, scope: scopeOf(root, rel, check) }
}

export function errorsFail({ cache, fp, etype, sig, key, scope, files, now, cs }) {
  const all = structuredClone(cache)
  const prior = all[fp] ? { ...all[fp] } : null
  const e = all[fp] ?? { seen: 0, first: now, sessions: [] }
  Object.assign(e, { etype, sig, key, scope, files, last: now, lastCs: cs, open: true, seen: e.seen + 1, sessions: [...new Set([...e.sessions, cs])].slice(-10) })
  delete e.resolved
  all[fp] = e
  return { cache: all, prior }
}

export function errorsPass({ cache, key, scope, now, cs, turn, edits }) {
  const all = structuredClone(cache)
  const out = []
  for (const [fp, e] of Object.entries(all)) {
    if (!e.open || e.key !== key || e.scope !== scope) continue
    const same = e.lastCs === cs
    const files = same ? [...new Set(edits.filter(x => x.at >= (e.last ?? 0)).map(x => x.file))].slice(0, 20) : []
    e.open = false
    e.resolved = { at: now, cs, turn, files, confidence: same ? 'observed' : 'inferred' }
    out.push({ fp, confidence: e.resolved.confidence, files })
  }
  return { cache: all, resolves: out }
}

export const errorsPrune = ({ cache, open_fps }) => open_fps.filter(fp => cache[fp]?.open && cache[fp].etype !== 'runtime')

export function decisionsResolve(events) {
  const all = events.filter(d => typeof d.id === 'string').sort((a, b) => a.at - b.at || a.seq - b.seq)
  const out = new Map(all.map(d => [d.id, { ...d, status: 'active' }]))
  for (const d of all) {
    const target = d.supersedes && out.get(d.supersedes)
    if (target && target.status === 'active') Object.assign(target, { status: 'superseded', supersededBy: d.id })
  }
  return [...out.values()]
}

export function chainEnd(list, id) {
  const map = new Map(list.map(d => [d.id, d]))
  let cur = map.get(id)
  const seen = new Set()
  while (cur?.supersededBy && !seen.has(cur.id)) {
    seen.add(cur.id)
    cur = map.get(cur.supersededBy)
  }
  return cur?.id ?? id
}
