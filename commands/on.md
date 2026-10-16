---
description: VHDB 스위치를 켠다 (record 기록 / inject 주입 / guard 편집 전 확인)
argument-hint: [all|record|inject|guard ...]
allowed-tools: mcp__plugin_vhdb_vhdb__vhdb_config
---

사용자 입력: $ARGUMENTS

`vhdb_config` 툴을 `action`: `on` 로 호출한다. 입력의 단어 중 `all`, `record`, `inject`, `guard` 만 `targets`에 넣고(없으면 빈 배열), 다른 단어는 무시한다. 툴 결과를 그대로 보여 준다.
