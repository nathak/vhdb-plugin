// Which Bash commands are "checks" (test/build/typecheck/lint), and a stable key per command so a later pass can
// close the errors an earlier failure of the same command opened.
const RULES = [
  ['typecheck', /\b(?:tsc|vue-tsc|mypy|pyright)\b/],
  ['lint', /\b(?:eslint|ruff|flake8|pylint|biome|prettier\s+--check)\b|\bcargo\s+(?:clippy|fmt)\b|\bgo\s+vet\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b/],
  ['test', /\b(?:vitest|jest|pytest|mocha|ava|phpunit|rspec)\b|\bcargo\s+(?:test|nextest)\b|\bgo\s+test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bctest\b|\bdotnet\s+test\b|\bmvn\s+(?:\S+\s+)*test\b|\bgradle(?:w)?\s+(?:\S+\s+)*test\b/],
  ['build', /\bcargo\s+(?:build|check)\b|\bgo\s+build\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bmake\b|\bcmake\s+--build\b|\bdotnet\s+build\b|\bwebpack\b|\bvite\s+build\b|\bnext\s+build\b|\bmvn\s+(?:\S+\s+)*(?:package|compile)\b/],
]

const SKIP = /^(?:echo|cat|grep|rg|ls|git|which|man|printf|apt|brew|pip3?\s|npm\s+(?:i|install|add|ci)\b|pnpm\s+(?:i|install|add)\b|yarn\s+(?:add|install)\b)/
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/
const REDIRECT = /\s*\d*>>?\s*(?:&\d+|[^\s;&|<>]+)|\s*&>\s*[^\s;&|<>]+|\s*<\s*[^\s;&|<>]+/g
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g

// The exit status is only trustworthy when the check is the last thing that runs. A pipe, ";", a newline or a
// single "&" (background) afterwards can hide a failure, so such a call proves nothing.
const hidesStatus = cmd => /[;\n|]|(?<!&)&(?!&)/.test(cmd.replace(QUOTED, '""').replace(REDIRECT, ' '))

export function classify(command) {
  const cmd = String(command ?? '')
  let cwd = ''
  const found = []
  // redirections go first: the "&" in 2>&1 is not a separator
  for (const raw of cmd.replace(REDIRECT, ' ').split(/&&?|\|\|?|;|\n/)) {
    const full = raw.trim().replace(/\s+/g, ' ')
    const seg = full.replace(ENV_PREFIX, '').trim()
    const cd = /^cd\s+(\S+)/.exec(seg)
    if (cd) {
      cwd = cd[1].replace(/^["']|["']$/g, '')
      continue
    }
    if (!seg || SKIP.test(seg)) continue
    for (const [check, re] of RULES) {
      if (re.test(seg)) {
        found.push({ check, key: full.slice(0, 200), cwd }) // env vars stay in the key: ONLY=x npm test is not npm test
        break
      }
    }
  }
  if (!found.length) return null
  const masked = hidesStatus(cmd)
  // Several checks in one command: a failure cannot be pinned on one of them, so only the identical command may close it.
  if (found.length > 1) return { check: found[0].check, key: found.map(f => f.key).join(' && ').slice(0, 200), masked, compound: true, cwd: found[0].cwd }
  return { ...found[0], masked, compound: false }
}
