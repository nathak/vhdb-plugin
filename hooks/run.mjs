#!/usr/bin/env node
// Entry point for every Claude Code hook. Never blocks and never fails the session: any problem exits 0 quietly.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { handle } from '../lib/hooks.mjs'
import { vhdbDir } from '../lib/locate.mjs'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => (raw += c))
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw)
    if (process.env.VHDB_HOOK_SAMPLES) {
      const dir = join(vhdbDir({ ...process.env, VHDB_PROJECT_DIR: process.env.VHDB_PROJECT_DIR ?? input.cwd }), 'state')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'hook-samples.jsonl'), `${raw.trim()}\n`)
    }
    handle(input)
  } catch (e) {
    if (process.env.VHDB_DEBUG) console.error(`vhdb hook: ${e.stack ?? e}`)
  }
  process.exit(0)
})
