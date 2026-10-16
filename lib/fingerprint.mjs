// Same cause, same key: strip what changes between runs (paths, line numbers, times, ids, counts) and hash the rest.
import { createHash } from 'node:crypto'

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const NOISE = /^(?:npm (?:ERR!|error|notice)|make(?:\[\d+\])?: \*\*\*|test failed|error: test failed|error: could not compile|error: aborting|=+ ?(?:short test summary|FAILURES|ERRORS)|-{3,}|\s*at |\s*$|ℹ |# |✖ failing tests|failing tests:|command failed|exit code)/i
const OUTSIDE = /node_modules|\.cargo\/registry|site-packages|\/rustlib\/|\/usr\/lib|node:internal|<anonymous>/
// Error codes carry digits, so they are read from the text before numbers are blanked out.
const CODE = /\berror\[(E\d{4})\]|\berror (TS\d{4})\b|\berror (CS\d{4})\b/
const TYPE_RES = [/\b([A-Z][A-Za-z0-9]*(?:Error|Exception))\b/, /\b(E[A-Z]{3,12})\b/, /\bpanicked at\b/]
const LOC = /((?:\/|\.\/|[A-Za-z]:\\)?[\w@.\-/\\]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|c|cc|cpp|h|hpp|rb|php|swift|lua|gd)):(\d+)(?::(\d+))?/g

export function normalizeText(text, { repoTop = '', home = '' } = {}) {
  let t = String(text ?? '').replace(ANSI, '').replace(/\r/g, '')
  t = t.replace(/^Exit code \d+\n?/, '')
  if (repoTop) t = t.split(repoTop.replace(/\/$/, '') + '/').join('')
  if (home) t = t.split(home.replace(/\/$/, '') + '/').join('~/')
  t = t.replace(/(?:\/private)?\/(?:tmp|var\/folders\/[^\s:)]+|var\/tmp)\/[^\s:)'"]*/g, '<TMP>')
  return t
}

// Returns null when there is nothing to fingerprint.
export function fingerprint(output, opts = {}) {
  const text = normalizeText(output, opts)
  if (!text.trim()) return null
  const loc = []
  for (const m of text.matchAll(LOC)) {
    const where = `${m[1].replace(/^\.\//, '')}:${m[2]}`
    if (!loc.includes(where)) loc.push(where)
  }
  const top = loc.find(w => !OUTSIDE.test(w))?.replace(/:\d+$/, '') ?? ''
  const code = CODE.exec(text)
  const stripped = text
    .replace(LOC, (_m, f) => f)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<ID>')
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, '<TIME>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<HEX>')
    .replace(/\b[0-9a-f]{7,}\b/gi, m => (/\d/.test(m) && /[a-f]/i.test(m) ? '<HEX>' : m))
    .replace(/\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|µs|us|ns)\b/g, '<DUR>')
    .replace(/\d+/g, '<N>')
  const lines = stripped.split('\n').map(l => l.trim()).filter(l => !NOISE.test(l))
  let type = code ? (code[1] ?? code[2] ?? code[3]) : ''
  let msg = ''
  for (const re of TYPE_RES) {
    if (type) break
    const hit = lines.find(l => re.test(l))
    if (hit) {
      type = re.exec(hit)?.[1] ?? 'panic'
      msg = hit
      break
    }
  }
  if (code) msg = lines.find(l => /\berror\b/i.test(l)) || lines[0] || ''
  else if (!msg) msg = lines[0] ?? ''
  if (!msg) return null
  msg = msg.replace(/\s+/g, ' ').slice(0, 160)
  const fp = createHash('sha1').update(`${type}|${msg}|${top}`).digest('hex').slice(0, 16)
  return { fp, type, sig: msg, loc: loc.slice(0, 5), file: top }
}
