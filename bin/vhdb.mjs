#!/usr/bin/env node
// Human/test CLI: vhdb.mjs search <VQL...> | history <file> | stat   [--json] [--limit N] [--any]
import { history, search, stat } from '../lib/client.mjs'
import { formatHistory, formatSearch, redact } from '../lib/format.mjs'

const argv = process.argv.slice(2)
const take = (name, hasValue) => {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  return hasValue ? argv.splice(i, 2)[1] : (argv.splice(i, 1), true)
}
const json = take('--json')
const any = take('--any')
const limit = take('--limit', true)
const [verb, ...rest] = argv
const rest_ = rest.join(' ')

try {
  const opts = limit ? { limit: Number(limit) } : {}
  let result, text
  if (verb === 'search') {
    result = await search(rest_, { ...opts, any: Boolean(any) })
    text = () => formatSearch(result)
  } else if (verb === 'history') {
    result = await history(rest_, opts)
    text = () => formatHistory(result, rest_)
  } else if (verb === 'stat') {
    result = await stat()
    text = () => JSON.stringify(result.answer)
  } else {
    console.error('usage: vhdb.mjs search <VQL...> | history <file> | stat  [--json] [--limit N] [--any]')
    process.exit(2)
  }
  console.log(json ? JSON.stringify(result, (_k, v) => (typeof v === 'string' ? redact(v) : v)) : text())
  process.exit(result.answer.ok ? 0 : 1)
} catch (e) {
  console.error(`vhdb: ${e.message}`)
  process.exit(1)
}
