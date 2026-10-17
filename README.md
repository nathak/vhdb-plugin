# vhdb (Claude Code 플러그인)

smart-workbench 원장(`<git common dir>/swb-ledger/sessions`)을 읽고 자기 로그와 함께 VHDB 엔진(WASM)으로 색인·검색한다.
smart-workbench는 수정하지 않는다. 원장은 읽기만 하고, 엔진 파일과 자기 로그는 `<git common dir>/vhdb/`에 둔다.

- `/vhdb:search <VQL>`, `/vhdb:history <file>`
- MCP 툴 `query_history`, `file_history` (Claude가 스스로 호출)
- `node bin/vhdb.mjs search|history|stat [--json]` (사람/테스트용)

요구: node 24+, smart-workbench에서 `/swb ledger on`.
엔진 갱신: `scripts/sync-engine.sh <vhdb repo> <vhdb.wasm>` (`engine/SOURCE`에 출처 해시 기록).
테스트: `npm test`. 환경 변수: `VHDB_DIR`(엔진 루트), `VHDB_SWB_SESSIONS`, `VHDB_WASM`, `VHDB_PROJECT_DIR`.
설치(로컬): `claude --plugin-dir /home/projects/vhdb-plugin`

## 구조: JS는 접착, 이력 로직은 Rust

이 플러그인의 JS(`hooks/`, `mcp/`, `lib/`)는 Claude Code와 맞닿는 부분만 맡습니다: 훅 입력, MCP 프로토콜, 파일·락·로그 쓰기, 경로 계산.
마스킹, 오류 지문, 검사 분류, 오류 캐시 전이, 결정 상태, 주입 선정·예산·렌더, 출력 포맷은 엔진 저장소의 `vhdb_core::history`(Rust)가
계산하고, `engine/vhdb.wasm`을 `lib/core.mjs`가 동기 방식으로 불러 `h.*` 명령으로 호출합니다. wasm이 없거나 프로토콜 번호가 다르면
훅은 조용히 아무것도 하지 않습니다. 엔진을 갱신하려면 `scripts/sync-engine.sh`(엔진 커밋 뒤에 실행해야 `engine/SOURCE`가 맞습니다).

## M1: 기록과 맥락 주입 (기본은 모두 꺼짐)

`/vhdb:on [all|record|inject|guard]`, `/vhdb:off ...`, `/vhdb:status` (MCP 툴 `vhdb_config`). 설정은 `<git common dir>/vhdb/config.json`,
파일이 없으면 아무것도 만들지 않는다.

- **record**: 훅이 `check`(test/build/typecheck/lint 명령과 결과), `error`(실패, 지문 포함), `turn.end`를 자기 로그
  `<git common dir>/vhdb/log/vhdb-<세션>.jsonl`에 남긴다. 같은 검사 명령이 이후 통과하면 열린 오류를 닫는다
  (같은 세션이면 observed, 다른 세션이면 inferred). 파이프·`;`·`&`·백그라운드로 종료 코드가 가려진 호출은 `unknown`으로만 남기고
  오류를 닫지 않는다. 합성 명령(`a && b`)은 명령 전체가 키이고, 작업 트리·하위 디렉터리가 다르면 다른 범위다.
- **inject**: 프롬프트 제출 시(T1)와 이미 본 오류가 다시 실패한 직후(T2) `<vhdb_history>` 블록을 맥락에 붙인다.
  유효 결정 → 미해결·반복 오류 → 해결 이력 → 대화 요약 순, 1,200토큰 예산, 임계치 미만이면 생략, 같은 항목은 3턴 안에 반복하지 않는다.
  마감(기본 250ms)을 넘기면 대화 요약 층만 빠진다. 단계별 시간은 `state/timing.jsonl`.
- **record_decision** 툴: 선택과 이유를 남기고 `supersedes`로 이전 결정을 대체한다.
  `query_history`는 `status:active|superseded|all`(기본 active), `error:<fp>`를 지원한다.
- smart-workbench의 `swb-ledger`에는 아무것도 쓰지 않는다. 엔진 파일과 자기 로그는 `<git common dir>/vhdb/`에 둔다.

실측(실제 Claude Code, 결정 1건·해결 오류 1건 저장소): T1 총 75~81ms(레이어 1~3 약 40ms), 주입 172토큰.
`errors.json`은 로그에서 다시 만들 수 있다: `node bin/vhdb.mjs rebuild-cache`. 훅은 로그에 먼저 쓰고 `errors.json`을 나중에 갱신하므로, 중간에 죽어도 로그가 앞서 있을 뿐이고 이 명령이 맞춘다. 알려진 한계: scope가 없던 옛 로그의 오류는 기존 `errors.json`에 같은 지문이 있을 때만 scope를 되살리고, 그렇지 않으면 통과로 닫히지 않는다. 서로 다른 세션이 같은 ms에 같은 오류를 실패/해결하면 재생 순서가 실제와 다를 수 있다.

## 규모별 측정 (합성 로그, 이 PC, 프로세스 시작 포함)

| 로그 이벤트 | 색인(최초 `stat`) | T1 주입 훅 | `rebuild-cache` |
|---|---|---|---|
| 1,000 | 76ms | 약 95ms | 0.16초 |
| 10,000 | 0.2초 | 약 120ms | 0.15초 |
| 100,000 | 1.4초 | 약 140ms | 1.3초 |

- 주입 비용은 로그 크기가 아니라 `errors.json` 항목 수에 비례한다(항목당 약 14µs). 그래서 `Stop`에서 캐시를 정리한다: 90일 넘게 못 본 항목을 지우고 최대 2,000개만 남긴다(열린 오류 우선, 그다음 최근 순). 로그에는 모두 남아 있고 `rebuild-cache`도 같은 규칙을 적용한다.
- 정리하지 않은 1만 항목 캐시에서는 100k 로그의 T1이 약 280ms로 마감(250ms)을 넘는다.
- 측정 스크립트는 저장소에 넣지 않았다(합성 데이터라 실제 작업 패턴과 다르다). 실제 사용 중 `state/timing.jsonl`의 `ms`·`skipped`를 보는 편이 정확하다.
