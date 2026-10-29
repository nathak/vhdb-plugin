// Per-project switches in <vhdb dir>/config.json. Everything is off until someone turns it on, and while the
// file is missing nothing is ever created.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vhdbDir } from './locate.mjs'

export const SWITCHES = ['record', 'inject', 'guard', 'upload']
const DEFAULTS = { record: false, inject: false, guard: false, upload: false, budgetTokens: 1200, deadlineMs: 250 }

export function readConfig(env = process.env) {
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(join(vhdbDir(env), 'config.json'), 'utf8'))
  } catch {
    // missing or unreadable: defaults (all off)
  }
  const cfg = { ...DEFAULTS }
  for (const k of SWITCHES) if (raw[k] === true) cfg[k] = true
  const num = (v, lo, hi, d) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : d)
  cfg.uploadTarget = typeof raw.uploadTarget === 'string' ? raw.uploadTarget : ''
  cfg.budgetTokens = num(raw.budgetTokens, 200, 2500, DEFAULTS.budgetTokens)
  cfg.deadlineMs = num(raw.deadlineMs, 50, 5000, DEFAULTS.deadlineMs)
  return cfg
}

// targets: 'all' (on: record + inject, never upload, which sends history off this machine; off: those and upload) or any of SWITCHES.
export function setConfig(value, targets, env = process.env, extra = {}) {
  // `all` turns record + inject on, and upload off as well (switching off is always safe, switching upload on never is implicit)
  const names = targets.length === 0 || targets.includes('all') ? (value ? ['record', 'inject'] : ['record', 'inject', 'upload']) : targets
  for (const n of names) if (!SWITCHES.includes(n)) throw new Error(`모르는 스위치: ${n} (all|record|inject|guard|upload)`)
  const dir = vhdbDir(env)
  const cfg = readConfig(env)
  for (const n of names) cfg[n] = value
  Object.assign(cfg, extra)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'config.json')
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`)
  renameSync(tmp, path)
  return cfg
}

export const configExists = (env = process.env) => existsSync(join(vhdbDir(env), 'config.json'))

export function describeConfig(cfg) {
  const on = k => (cfg[k] ? '켜짐' : '꺼짐')
  return `기록(record) ${on('record')}, 주입(inject) ${on('inject')}, 편집 전 확인(guard) ${on('guard')}, 업로드(upload) ${on('upload')} — 예산 ${cfg.budgetTokens}토큰, 마감 ${cfg.deadlineMs}ms`
}

// For /vhdb:status: how often a turn that searched the history had been shown nothing.
export function missStats(env) {
  let rows = []
  try {
    rows = readFileSync(join(vhdbDir(env), 'state', 'misses.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch {
    // none yet
  }
  const misses = rows.filter(r => r.shown === 0).length
  return { searched: rows.length, misses, rate: rows.length ? misses / rows.length : 0 }
}

export function describeMisses(env = process.env) {
  const m = missStats(env)
  if (!m.searched) return ''
  const note = m.searched >= 20 && m.rate > 0.1 ? ' — 10%를 넘음: 이 저장소는 임베딩 제공자를 켜 볼 만하다' : ''
  return `\n주입 미스: 이력을 조회한 ${m.searched}개 턴 중 ${m.misses}개(${Math.round(m.rate * 100)}%)는 직전에 아무것도 보여주지 못했다${note}`
}
