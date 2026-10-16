import { withSession } from '../lib/log.mjs'
const [sid, n] = process.argv.slice(2)
for (let i = 0; i < Number(n); i++) withSession(process.env, sid, ({ emit }) => emit('tick', { i }))
