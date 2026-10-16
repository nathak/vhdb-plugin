// Same cause, same key: strip what changes between runs (paths, line numbers, times, ids, counts) and hash the rest.
// Returns { fp, type, sig, loc, file } or null when there is nothing to fingerprint. (Rust: history::fingerprint)
import { fn } from './core.mjs'

export const fingerprint = (output, { repoTop = '', home = '' } = {}) => fn('h.fingerprint', { output: String(output ?? ''), repo_top: repoTop, home })
