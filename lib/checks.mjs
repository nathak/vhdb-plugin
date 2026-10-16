// Which Bash commands are "checks" (test/build/typecheck/lint), and a stable key per command so a later pass can
// close the errors an earlier failure of the same command opened. (Rust: history::checks)
import { fn } from './core.mjs'

export const classify = command => fn('h.classify', String(command ?? ''))
export const isSensitive = command => fn('h.is_sensitive', String(command ?? ''))
