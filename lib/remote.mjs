// Where the team server is and who we are on it: <vhdb dir>/remote.json (mode 0600, inside .git so git never sees it),
// plus the upload state the status line reports. Nothing here talks to the network.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'
import { vhdbDir } from './locate.mjs'

export const remotePath = env => join(vhdbDir(env), 'remote.json')
export const stateDir = env => join(vhdbDir(env), 'state')
export const uploadStatePath = env => join(stateDir(env), 'upload.json')
export const uiApprovalPath = env => join(stateDir(env), 'ui-approval')

// smart-workbench writes this file after the person confirmed in its own dialog; `remote on --from-ui` takes it once.
// Same-user programs can write it too, so this is a deliberate step and not a barrier.
export function consumeUiApproval(env, now = Date.now()) {
  const path = uiApprovalPath(env)
  try {
    const age = now - statSync(path).mtimeMs
    rmSync(path, { force: true })
    return age >= -5000 && age < 120000
  } catch {
    return false
  }
}

const TOKEN_RE = /^vhdb_[\x21-\x7e]{8,512}$/

const isLoopbackHost = host => {
  const h = host.replace(/^\[|\]$/g, '')
  if (h === 'localhost') return true
  if (isIP(h) === 4) return h.startsWith('127.')
  return h === '::1'
}

// The server address: https, or plain http only to this machine. No credentials, query or fragment in it; a path is
// allowed (a reverse proxy may serve the server under a prefix). Returns { ok, url } with the trailing slash removed.
export function validateUrl(input) {
  let u
  try {
    u = new URL(String(input))
  } catch {
    return { ok: false, error: '주소 형식이 아님' }
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
    return { ok: false, error: 'https 주소만 쓸 수 있음 (http는 이 컴퓨터(localhost)로 보낼 때만)' }
  }
  if (u.username || u.password) return { ok: false, error: '주소에 사용자·비밀번호를 넣을 수 없음' }
  if (u.search || u.hash) return { ok: false, error: '주소에 ?query 나 #fragment 를 넣을 수 없음' }
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` }
}

export const validProject = p => typeof p === 'string' && p.length >= 1 && p.length <= 128 && !/[\x00-\x1f\x7f]/.test(p)
export const validToken = t => typeof t === 'string' && TOKEN_RE.test(t)

// What is configured, or why it cannot be used. The token is the file's, or VHDB_REMOTE_TOKEN when the file has none
// (a token belongs to one project, so an environment variable shared by several repositories must not override it).
export function readRemote(env = process.env) {
  const path = remotePath(env)
  if (!existsSync(path)) return { configured: false, ok: false, reason: '설정 없음: node bin/vhdb.mjs remote set --url <주소> --project <이름>' }
  let raw
  try {
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
      return { configured: true, ok: false, reason: 'remote.json 권한이 넓음: chmod 600 으로 바꾼 뒤 다시 시도' }
    }
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { configured: true, ok: false, reason: 'remote.json 을 읽을 수 없음' }
  }
  const u = validateUrl(raw.url)
  if (!u.ok) return { configured: true, ok: false, reason: `주소: ${u.error}` }
  if (!validProject(raw.project)) return { configured: true, ok: false, reason: 'project 가 올바르지 않음' }
  const fromFile = typeof raw.token === 'string' && raw.token !== ''
  const token = fromFile ? raw.token : env.VHDB_REMOTE_TOKEN
  if (!validToken(token)) return { configured: true, ok: false, reason: '토큰 없음: remote set 에서 표준입력으로 넣거나 VHDB_REMOTE_TOKEN 을 설정' }
  return { configured: true, ok: true, url: u.url, project: raw.project, token, tokenSource: fromFile ? 'file' : 'env', ledger: raw.ledger !== false }
}

// Writes remote.json (0600, replaced atomically). A missing token keeps the one already in the file.
export function writeRemote(env, { url, project, token, ledger }) {
  const u = validateUrl(url)
  if (!u.ok) throw new Error(u.error)
  if (!validProject(project)) throw new Error('project 는 1~128자, 제어문자 없음')
  let old = {}
  try {
    old = JSON.parse(readFileSync(remotePath(env), 'utf8'))
  } catch {
    // none yet
  }
  const keep = token === undefined || token === ''
  if (!keep && !validToken(token)) throw new Error('토큰 형식이 올바르지 않음 (vhdb_… 로 시작)')
  const doc = { v: 1, url: u.url, project, ...(keep ? (old.token ? { token: old.token } : {}) : { token }), ledger: ledger !== false }
  const dir = vhdbDir(env)
  mkdirSync(dir, { recursive: true })
  const tmp = `${remotePath(env)}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(tmp, 0o600)
  renameSync(tmp, remotePath(env))
  return doc
}

export function clearRemote(env) {
  rmSync(remotePath(env), { force: true })
  rmSync(uploadStatePath(env), { force: true })
}

// Identifies the target + credentials without keeping the token: a change resets the back-off, a new address or project
// also forgets what was sent where.
export const targetKey = r => createHash('sha256').update(`${r.url}|${r.project}`).digest('hex').slice(0, 12)
// What the person approved when turning the upload on: where it goes and whether prompts and answers (the ledger) go.
// The token is left out on purpose (the server ties it to the project, and replacing it needs no new decision). Like the
// ui-approval file this guards against a setting drifting, not against a program running as the same user.
export const approvalKey = r => createHash('sha256').update(JSON.stringify([r.url, r.project, r.ledger])).digest('hex').slice(0, 12)
export const credKey = r => createHash('sha256').update(`${r.url}|${r.project}|${r.token}`).digest('hex').slice(0, 12)

export function readUploadState(env) {
  try {
    const s = JSON.parse(readFileSync(uploadStatePath(env), 'utf8'))
    return s && s.v === 1 ? s : null
  } catch {
    return null
  }
}

export function saveUploadState(env, state) {
  mkdirSync(stateDir(env), { recursive: true })
  const tmp = `${uploadStatePath(env)}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, uploadStatePath(env))
}

// For a program (smart-workbench) that shows the switch: one object, never the token.
export function statusJson(env = process.env, cfg = {}) {
  const r = readRemote(env)
  const st = readUploadState(env)
  const approved = r.ok && cfg.uploadTarget === approvalKey(r)
  return {
    upload: Boolean(cfg.upload),
    approvalPath: resolve(uiApprovalPath(env)), // always given: the caller writes the approval before `remote on`
    configured: r.configured,
    ready: r.ok,
    approved,
    reason: r.ok ? (cfg.upload && !approved ? '서버·프로젝트·원장 설정이 켤 때 확인한 것과 다름: 다시 켜야 함' : null) : r.reason,
    url: r.ok ? r.url : null,
    project: r.ok ? r.project : null,
    ledger: r.ok ? r.ledger : null,
    tokenSource: r.ok ? r.tokenSource : null,
    lastSentAt: st?.last?.at ?? null,
    sent: st?.totals?.sent ?? 0,
    error: st?.error ? { status: st.error.status ?? null, text: st.error.text, at: st.error.at } : null,
    backoffUntil: st?.backoff?.until ?? null,
  }
}

const when = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

// For /vhdb:status. Never prints the token, not even a prefix.
export function describeUpload(env = process.env, cfg = {}) {
  let r
  try {
    r = readRemote(env)
  } catch (e) {
    return `\n업로드(upload) ${cfg.upload ? '켜짐' : '꺼짐'} — 위치를 찾을 수 없음: ${e.message}`
  }
  const lines = [`업로드(upload) ${cfg.upload ? '켜짐' : '꺼짐'}`]
  if (!r.ok) {
    lines[0] += ` — ${r.reason}`
    return `\n${lines.join('\n')}`
  }
  lines[0] += ` — ${r.url} · 프로젝트 ${r.project} · 토큰 설정됨(${r.tokenSource === 'file' ? 'remote.json 0600' : '환경변수'}) · 원장 ${r.ledger ? '포함' : '제외'}`
  const st = readUploadState(env)
  if (st) {
    const t = st.totals ?? {}
    if (st.last?.at) lines.push(`  마지막 성공 ${when(st.last.at)} · 보낸 이벤트 ${t.sent ?? 0}개`)
    const extra = []
    if (t.refused_local) extra.push(`로컬에서 거른 줄 ${t.refused_local}`)
    if (t.quarantined) extra.push(`서버가 거부해 격리한 줄 ${t.quarantined}`)
    const taken = Object.values(st.sessions ?? {}).filter(s => s.status === 'taken').length
    if (taken) extra.push(`이미 남이 쓰는 세션 ${taken}`)
    if (extra.length) lines.push(`  ${extra.join(' · ')}`)
    if (st.error) lines.push(`  마지막 오류 ${st.error.status ?? '네트워크'}: ${st.error.text} (${when(st.error.at)})${st.backoff?.until > Date.now() ? ` · 다음 시도 ${when(st.backoff.until)}` : ''}`)
  }
  lines.push('  서버 검색에 보이기까지는 서버의 수집 주기(수 초)가 더 걸립니다.')
  return `\n${lines.join('\n')}`
}
