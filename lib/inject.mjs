// Picks what to show Claude from our own history and renders it: the Rust core does the work (history::inject);
// the same input gives the same bytes (a stable prefix keeps prompt caching intact).
import { fn } from './core.mjs'

export const THRESHOLD = 0.8
export const estimateTokens = s => fn('h.estimate_tokens', String(s))
export const tokens = text => new Set(fn('h.tokens', String(text ?? '')))
export const safe = (s, max = 200) => fn('h.safe', { s: String(s ?? ''), max })

// data: { decisions: Map id -> decision, errors: { fp: entry }, chat: [engine hits] }
// ctx: { prompt, focus: Set<string>, prevOpen: [], sessionId, turn, injected: { key: { turn, at } }, edits: [{ file, at }], force?: Set<fp> }
// Returns { text, keys, tokens } or null.
export function build(data, ctx, { budgetTokens = 1200, minScore = THRESHOLD } = {}) {
  return fn('h.inject', {
    decisions: [...data.decisions.values()],
    errors: data.errors,
    chat: data.chat ?? [],
    ctx: { ...ctx, focus: [...ctx.focus], force: [...(ctx.force ?? [])] },
    budgetTokens,
    minScore,
  })
}
