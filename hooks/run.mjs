#!/usr/bin/env node
// Entry point for every Claude Code hook. Never blocks and never fails the session: any problem exits 0 quietly.
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { handle } from '../lib/hooks.mjs'
import { redact } from '../lib/redact.mjs'
import { vhdbDir } from '../lib/locate.mjs'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => (raw += c))
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw)
    if (process.env.VHDB_HOOK_SAMPLES) {
      const dir = join(vhdbDir({ ...process.env, VHDB_PROJECT_DIR: process.env.VHDB_PROJECT_DIR ?? input.cwd }), 'state')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'hook-samples.jsonl'), `${redact(raw.trim())}\n`)
    }
    const out = await handle(input)
    if (out?.permissionDecision) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: out.event, permissionDecision: out.permissionDecision, permissionDecisionReason: out.permissionDecisionReason } })}\n`)
    else if (out?.additionalContext) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: out.event, additionalContext: out.additionalContext } })}\n`)
  } catch (e) {
    if (process.env.VHDB_DEBUG) console.error(`vhdb hook: ${e.stack ?? e}`)
  }
  process.exit(0)
})
