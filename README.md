# vhdb (Claude Code 플러그인)

smart-workbench 원장(`<git common dir>/swb-ledger`)을 읽어 VHDB 엔진(WASM)으로 색인·검색한다.
smart-workbench는 수정하지 않는다. 원장 `sessions/*.jsonl`은 읽기만 하고, 파생 파일은 같은 디렉터리의 `data/ index/ MANIFEST`에 둔다.

- `/vhdb:search <VQL>`, `/vhdb:history <file>`
- MCP 툴 `query_history`, `file_history` (Claude가 스스로 호출)
- `node bin/vhdb.mjs search|history|stat [--json]` (사람/테스트용)

요구: node 24+, smart-workbench에서 `/swb ledger on`.
엔진 갱신: `scripts/sync-engine.sh <vhdb repo> <vhdb.wasm>` (`engine/SOURCE`에 출처 해시 기록).
테스트: `npm test`. 환경 변수: `VHDB_LEDGER_DIR`, `VHDB_WASM`, `VHDB_PROJECT_DIR`.
설치(로컬): `claude --plugin-dir /home/projects/vhdb-plugin`
