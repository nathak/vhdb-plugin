#!/usr/bin/env node
// Human/test CLI: vhdb.mjs search <VQL...> | history <file> | stat | rebuild-cache   [--json] [--limit N] [--any]
//   upload [--all] [--dry-run]        send the history to the team server (the Stop hook runs it with --bg)
//   remote set|show|check|on|off|clear|reset   the team server this repository uploads to (see README)
import { history, search, stat } from '../lib/client.mjs'
import { rebuildErrors } from '../lib/hooks.mjs'
import { formatHistory, formatSearch, redact } from '../lib/format.mjs'
import { readFileSync } from 'node:fs'
import { readConfig, setConfig } from '../lib/config.mjs'
import { approvalKey, clearRemote, consumeUiApproval, describeUpload, readRemote, readUploadState, remotePath, statusJson, uploadStatePath, writeRemote } from '../lib/remote.mjs'
import { dryRun, enableUpload, runUpload, withUploadLock } from '../lib/upload.mjs'
import { rmSync } from 'node:fs'

const argv = process.argv.slice(2)
const take = (name, hasValue) => {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  return hasValue ? argv.splice(i, 2)[1] : (argv.splice(i, 1), true)
}
const json = take('--json')
const any = take('--any')
const limit = take('--limit', true)
const bg = take('--bg')
const all = take('--all')
const dry = take('--dry-run')
const noLedger = take('--no-ledger')
const fromNow = take('--from-now')
const fromUi = take('--from-ui')
const jsonOut = json
const url = take('--url', true)
const project = take('--project', true)
const tokenArg = take('--token', true)
const [verb, ...rest] = argv
const rest_ = rest.join(' ')

const say = text => console.log(text)

if (verb === 'upload') {
  if (dry) {
    const d = dryRun()
    if (!d.ok) {
      console.error(`vhdb: ${d.skipped}`)
      process.exit(1)
    }
    say(`보낼 수 있는 이벤트 ${d.sendable}개 (세션 ${d.sessions}개, 파일 ${d.files}개, 전체 ${d.events}줄)`)
    say(`보내지 않는 줄: ${Object.keys(d.refused).length ? Object.entries(d.refused).map(([k, v]) => `${k} ${v}`).join(', ') : '없음'}`)
    process.exit(0)
  }
  const r = await runUpload(process.env, { bg: Boolean(bg), all: Boolean(all) })
  if (bg) process.exit(0)
  if (r.skipped) {
    console.error(`vhdb: 업로드 안 함 — ${r.skipped}`)
    process.exit(1)
  }
  if (r.busy) say('다른 업로드가 진행 중입니다.')
  else if (r.waiting) say(`오류 뒤 대기 중입니다. 다음 시도 ${new Date(r.waiting).toISOString()}`)
  else say(`보낸 이벤트 ${r.sent}개 (요청 ${r.requests}회)${r.stopped ? ` — 멈춤: ${r.stopped.status ?? '네트워크'} ${r.stopped.text}` : ''}`)
  process.exit(r.stopped ? 1 : 0)
}

if (verb === 'remote') {
  const [sub] = rest
  try {
    if (tokenArg !== undefined) throw new Error('--token 은 쓰지 않습니다(프로세스 목록과 셸 기록에 남음): 토큰은 표준입력으로 넣으세요  예) pbpaste | node bin/vhdb.mjs remote set --url … --project …')
    if (sub === 'set') {
      if (!url || !project) throw new Error('사용법: node bin/vhdb.mjs remote set --url <https://서버> --project <프로젝트> [--no-ledger]   (토큰은 표준입력)')
      if (process.stdin.isTTY) console.error('토큰(vhdb_…)을 붙여넣고 Enter, 이어서 Ctrl-D. 이미 저장된 토큰을 그대로 두려면 바로 Ctrl-D.')
      const token = readFileSync(0, 'utf8').trim()
      writeRemote(process.env, { url, project, token, ledger: !noLedger })
      const now = readRemote()
      say(`저장했습니다 (${remotePath(process.env)}, 권한 600). ${now.ok ? '다음: remote check, 그다음 remote on' : now.reason}`)
      // Another server, project or ledger setting is another decision: the upload goes off until a person turns it on again.
      const cfg = readConfig()
      if (cfg.upload && (!now.ok || cfg.uploadTarget !== approvalKey(now))) {
        setConfig(false, ['upload'])
        say(now.ok ? '서버·프로젝트·원장 포함 여부가 바뀌어 업로드를 껐습니다. 확인한 뒤 `remote on` 으로 다시 켜세요. (--no-ledger 를 빼면 원장 포함으로 저장됩니다)' : `설정을 쓸 수 없어 업로드를 껐습니다: ${now.reason}`)
      }
    } else if (sub === 'show') {
      if (jsonOut) say(JSON.stringify(statusJson(process.env, readConfig())))
      else say(describeUpload(process.env, readConfig()).trim())
    } else if (sub === 'check') {
      const r = readRemote()
      if (!r.ok) throw new Error(r.reason)
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 이면 토큰을 보내지 않습니다')
      const res = await fetch(`${r.url}/v1/ingest?project=${encodeURIComponent(r.project)}&session=vhdb-probe`, { headers: { Authorization: `Bearer ${r.token}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) })
      const body = await res.json().catch(() => null)
      if (res.status === 200 && !Number.isSafeInteger(body?.high_seq)) throw new Error('200 이지만 vhdb-server 의 응답 형식이 아닙니다: 주소(경로)를 확인하세요')
      const meaning = { 200: '확인됨: 토큰·프로젝트·쓰기 권한이 맞습니다', 400: '프로젝트 이름이 토큰과 다릅니다', 401: '토큰이 없거나 만료·폐기됐거나 프로젝트에 묶이지 않았습니다', 404: '쓰기 권한이 없거나 프로젝트가 없거나 서버가 계정 모드가 아닙니다' }[res.status]
      say(`${res.status} ${meaning ?? '예상하지 못한 응답'}`)
      process.exit(res.status === 200 ? 0 : 1)
    } else if (sub === 'on') {
      // Sending history off this machine is switched on by a person at a terminal, not by a script or a model's command.
      // --from-ui: smart-workbench asked the person in its own dialog and left an approval (see consumeUiApproval)
      if (fromUi ? !consumeUiApproval(process.env) : !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('업로드는 사람이 터미널에서 직접 켜야 합니다 (명령 결과를 파이프로 받는 실행에서는 켜지지 않음)')
      const r = enableUpload(process.env, { fromNow: Boolean(fromNow) })
      say(`업로드를 켰습니다. ${r.url} 의 프로젝트 ${r.project} 로 보냅니다:`)
      say(`  - 이 플러그인의 기록(오류·검사·결정·턴 종료)${r.ledger ? '\n  - smart-workbench 원장: 프롬프트·응답·도구 입출력·편집·커밋' : ''}`)
      say(fromNow ? '지금까지 쌓인 이력은 보내지 않고 이후 것만 보냅니다.' : '지금까지 쌓인 이력도 보냅니다(첫 전송에 시간이 걸릴 수 있음).')
      say('끄면 이후 전송만 멈춥니다. 이미 서버에 올라간 데이터는 서버 관리자가 지워야 합니다. 끄기: /vhdb:off upload')
      say('먼저 `node bin/vhdb.mjs upload --dry-run` 으로 보낼 양을 볼 수 있고, `node bin/vhdb.mjs upload` 로 지금 보낼 수 있습니다.')
    } else if (sub === 'off') {
      setConfig(false, ['upload'])
      say('업로드를 껐습니다. 이미 올라간 데이터는 서버에 남습니다.')
    } else if (sub === 'clear') {
      setConfig(false, ['upload'])
      withUploadLock(process.env, () => clearRemote(process.env))
      say('서버 설정과 업로드 기록을 지우고 업로드를 껐습니다.')
    } else if (sub === 'reset') {
      withUploadLock(process.env, () => rmSync(uploadStatePath(process.env), { force: true }))
      say(readUploadState(process.env) ? '지우지 못했습니다.' : '업로드 위치 기록을 지웠습니다. 다음 업로드는 처음부터 보내며 서버가 중복은 걷어냅니다.')
    } else {
      throw new Error('사용법: remote set|show|check|on|off|clear|reset')
    }
  } catch (e) {
    console.error(`vhdb: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}

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
  } else if (verb === 'rebuild-cache') {
    console.log(`errors.json rebuilt from the log: ${JSON.stringify(rebuildErrors(process.env))}`)
    process.exit(0)
  } else {
    console.error('usage: vhdb.mjs search <VQL...> | history <file> | stat | rebuild-cache  [--json] [--limit N] [--any]')
    process.exit(2)
  }
  console.log(json ? JSON.stringify(result, (_k, v) => (typeof v === 'string' ? redact(v) : v)) : text())
  process.exit(result.answer.ok ? 0 : 1)
} catch (e) {
  console.error(`vhdb: ${e.message}`)
  process.exit(1)
}
