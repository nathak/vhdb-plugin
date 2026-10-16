// Masks obvious secrets. Applied before anything is stored and again before anything is shown. (Rust: history::redact)
import { fn } from './core.mjs'

export const redact = text => fn('h.redact', String(text))
