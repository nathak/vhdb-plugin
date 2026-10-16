// Per-project switches in <vhdb dir>/config.json. Everything is off until someone turns it on, and while the
// file is missing nothing is ever created.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vhdbDir } from './locate.mjs'

export const SWITCHES = ['record', 'inject', 'guard']
const DEFAULTS = { record: false, inject: false, guard: false, budgetTokens: 1200, deadlineMs: 250 }

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
  cfg.budgetTokens = num(raw.budgetTokens, 200, 4000, DEFAULTS.budgetTokens)
  cfg.deadlineMs = num(raw.deadlineMs, 50, 5000, DEFAULTS.deadlineMs)
  return cfg
}

// targets: 'all' (= record + inject) or any of SWITCHES.
export function setConfig(value, targets, env = process.env) {
  const names = targets.length === 0 || targets.includes('all') ? ['record', 'inject'] : targets
  for (const n of names) if (!SWITCHES.includes(n)) throw new Error(`모르는 스위치: ${n} (all|record|inject|guard)`)
  const dir = vhdbDir(env)
  const cfg = readConfig(env)
  for (const n of names) cfg[n] = value
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
  return `기록(record) ${on('record')}, 주입(inject) ${on('inject')}, 편집 전 확인(guard) ${on('guard')} — 예산 ${cfg.budgetTokens}토큰, 마감 ${cfg.deadlineMs}ms`
}
