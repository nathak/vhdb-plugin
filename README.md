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
알려진 한계: `errors.json`은 로그에서 다시 만드는 명령(`rebuild-cache`)이 아직 없다. 훅이 `errors.json`을 갱신한 직후 로그 기록 전에 죽으면 둘이 어긋날 수 있다.
