---
description: VHDB 스위치를 켠다 (record 기록 / inject 주입 / guard 편집 전 확인)
argument-hint: [all|record|inject|guard ...]
allowed-tools: mcp__plugin_vhdb_vhdb__vhdb_config
---

사용자 입력: $ARGUMENTS

`vhdb_config` 툴을 `action`: `on` 로 호출한다. 입력의 단어 중 `all`, `record`, `inject`, `guard` 만 `targets`에 넣고(없으면 빈 배열), 다른 단어는 무시한다. `upload`(팀 서버로 이력 업로드)는 여기서 켜지 않는다: 사용자가 `upload`를 말하면 호출하지 말고, 터미널에서 `node bin/vhdb.mjs remote set` 과 `remote on` 으로 직접 켜라고 안내한다. 툴 결과를 그대로 보여 준다.
