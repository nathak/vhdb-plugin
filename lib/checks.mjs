// Which Bash commands are "checks" (test/build/typecheck/lint), and a stable key per command so a later pass can
// close the errors an earlier failure of the same command opened.
const RULES = [
  ['typecheck', /\b(?:tsc|vue-tsc|mypy|pyright)\b/],
  ['lint', /\b(?:eslint|ruff|flake8|pylint|biome|prettier\s+--check)\b|\bcargo\s+(?:clippy|fmt)\b|\bgo\s+vet\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?lint\b/],
  ['test', /\b(?:vitest|jest|pytest|mocha|ava|phpunit|rspec)\b|\bcargo\s+(?:test|nextest)\b|\bgo\s+test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnode\s+--test\b|\bctest\b|\bdotnet\s+test\b|\bmvn\s+(?:\S+\s+)*test\b|\bgradle(?:w)?\s+(?:\S+\s+)*test\b/],
  ['build', /\bcargo\s+(?:build|check)\b|\bgo\s+build\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bmake\b|\bcmake\s+--build\b|\bdotnet\s+build\b|\bwebpack\b|\bvite\s+build\b|\bnext\s+build\b|\bmvn\s+(?:\S+\s+)*(?:package|compile)\b/],
]

// A pipeline or "|| true" hides the command's own exit status, so a "successful" hook call proves nothing.
const MASKED = /\|(?!\|)|\|\|\s*(?:true|:|exit\s+0)\b|;\s*(?:true|exit\s+0)\s*$/
const REDIRECT = /\s*\d*>>?\s*(?:&\d+|\/dev\/null|\S+)|\s*&>\s*\S+/g

const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/

export function classify(command) {
  const segments = String(command ?? '').split(/&&|\|\||;|\n|\|/)
  for (const raw of segments) {
    const seg = raw.trim().replace(ENV_PREFIX, '').replace(REDIRECT, '').replace(/\s+/g, ' ').trim()
    if (!seg || /^(?:echo|cat|grep|rg|ls|git|cd|which|man|printf)\b/.test(seg)) continue
    for (const [check, re] of RULES) if (re.test(seg)) return { check, key: seg.slice(0, 200), masked: MASKED.test(String(command)) }
  }
  return null
}
