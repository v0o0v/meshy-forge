---
name: meshy
description: Meshy 로 3D 모델(GLB)을 생성·보관·재사용할 때 따르는 워크플로. meshy·3D 모델 생성·GLB·보스 모델·target_polycount·retexture·remesh·리깅·모델 보관/찾기 요청 시 발동. 생성물은 3일 뒤 서버에서 삭제되므로 완료 즉시 로컬 라이브러리에 보관하고, 새로 만들기 전에 보관본을 먼저 조회한다.
---

# Meshy Forge — 생성·보관·재사용 워크플로

**전제 하나로 전부 결정된다: Meshy 는 비-Enterprise 생성물을 3일 뒤 서버에서 삭제한다**
([asset retention](https://docs.meshy.ai/en/api/asset-retention), 서명 URL 도 3일 만료).
그래서 이 워크플로의 1순위는 품질도 비용도 아니고 **만료 전에 로컬로 옮기는 것**이다. 용어는
`${CLAUDE_PLUGIN_ROOT}/CONTEXT.md` 를 따른다. 파라미터·비용·함정 상세는
`${CLAUDE_PLUGIN_ROOT}/skills/meshy/references/meshy-guide.md`.

핵심 도구는 CLI 하나다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/meshy-cache.mjs" <명령>
```

- 최초 1회 `setup` 이 필요하다(better-sqlite3 FTS5 인덱스). **Node 메이저 버전을 올린 뒤**에는 패키지가
  그대로여도 네이티브 바인딩(ABI)이 안 맞는데, 이때 `npm install` 은 아무 일도 하지 않는다 —
  `setup` 이 감지해 `npm rebuild better-sqlite3` 로 복구한다.
- 훅(PreToolUse/PostToolUse)은 **비차단**이다. 백엔드가 없어도 생성을 막지 않는다.
- `${CLAUDE_PLUGIN_ROOT}` 가 안 잡히면 `${CLAUDE_SKILL_DIR}/../../scripts/meshy-cache.mjs` 로 대체한다.

## 0) 전제 확인 — 동기화 게이트 + MCP 연결

**설치 동기화 게이트(스킬 발동 시 1회)**:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-sync-check.mjs"
```

`DEV`/`SYNCED`/`UNKNOWN` → 진행. `STALE` → 출력된 두 명령(`claude plugin marketplace update meshy-forge` →
`claude plugin update meshy-forge@meshy-forge`)을 즉시 실행하고(로컬 스냅샷 갱신 — 사용자 확인 불필요),
"다음 세션부터 적용"을 알린 뒤 현재 작업은 계속한다.

⚠️ **`update` 는 `plugin.json` 의 `version` 이 같으면 "이미 최신"이라며 아무 일도 하지 않는다.**
STALE 인데 update 가 no-op 이면 소스 리포의 버전이 안 올라간 것이다 — 그때는 플러그인을 고친 쪽에서
버전을 올려야 한다(이 리포를 직접 고치는 중이라면 지금 올려라).

그다음 Meshy MCP 연결을 확인한다(`mcp__meshy__*` 가용 여부, 또는 `meshy_check_balance`).
**미연결이면** 연결을 안내하고 생성은 중단한다 — 보관·검색·갤러리는 연결 없이도 동작한다.

## 1) 미보관부터 건진다

새로 만들기 **전에** 이미 쓴 크레딧이 증발하려는 게 없는지 본다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/meshy-cache.mjs" pending
```

`🔥`(24시간 미만) 항목이 있으면 그것부터 다운로드·보관한다. 만료되면 되돌릴 방법이 없다.

## 2) 보관본 조회 — 생성 전 반드시 find

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/meshy-cache.mjs" find "<영문 설명>" [--tags a,b] [--style <프리셋>] [--polycount 8000] [--style-strict] [--top 5]
```

- score ≥ 0.6 이면 **후보 제시**다(강제 아님). 형상이 실제로 맞는지는 갤러리로 눈으로 확인한다.
- **형상은 맞는데 색·재질만 다르다** → 새로 만들지 말고 `meshy_retexture(input_task_id)` — 30크레딧이 10크레딧이 된다.
  단 **task 가 살아 있을 때만**(find 출력이 남은 시간을 알려준다). 만료됐으면 그 경로는 닫힌 것이다.
- 눈으로 봐야 하면 갤러리를 띄운다(브라우저에서 실물 GLB 회전):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gallery.mjs" --open
```

## 3) 스타일 프리셋 확인 — 세트는 같은 파라미터로

`${CLAUDE_PLUGIN_ROOT}/styles/<이름>.json`. 한 게임·한 세트의 생성물은 같은 프리셋으로 만든다
(`aiModel`·`topology`·`targetPolycount`·`removeLighting`·`texturePromptPrefix`).

- 세트인데 프리셋이 없으면 **먼저 만들자고 제안**한다(`styles/example-lowpoly-scifi.json` 복사).
- 프리셋이 있으면 그 값을 생성 호출에 그대로 싣고, 보관 시 `--style <이름>` 으로 원장에 남긴다.

## 4) 생성 — 크레딧 고지 후, 파라미터는 생성 시점에 확정

**크레딧을 쓰는 모든 호출은 예상 비용을 고지하고 사용자 동의를 받는다**(MCP 서버 지침). `meshy_check_balance` 로 잔액 먼저.

```
meshy_text_to_3d({
  prompt, ai_model: 'meshy-6',
  should_remesh: true,        // ★ 없으면 target_polycount 가 조용히 무시된다(meshy-6 기본 false)
  target_polycount: 8000,
  topology: 'triangle',
  target_formats: ['glb'],    // 필요한 것만 → 완료 시간 단축
  multi_view_thumbnails: true // 4방향 썸네일 — 공짜다. 나중에 목록에서 구분이 된다
})
```

그다음 `meshy_text_to_3d_refine({ preview_task_id, ai_model: 동일, texture_prompt, remove_lighting: true })`.

- 경량화는 **생성 시점**에 지정한다. 사후 `remesh` 는 5크레딧을 더 쓴다.
- `model_type: 'lowpoly'` 를 주면 `ai_model`·`topology`·`target_polycount`·`should_remesh` 가 **전부 무시**된다.
- `pose_mode: 't-pose'` 는 **리깅할 계획일 때만**. 차량·요새·기계형은 리깅 자체가 부적합하다(가이드 §3).
- 방향·용도·포맷을 임의로 정하지 않는다 — 명시되지 않았으면 물어본다.

## 5) 완료 즉시 다운로드 — 이것이 기본값이다

`meshy_get_task_status(wait: true)` 로 완료를 확인하면 **바로** 받는다. 나중으로 미루지 않는다.

```
meshy_download_model({ task_id, format: 'glb', save_to: '<절대경로>/<id>.glb' })
```

## 6) 보관 — 받았으면 즉시 store

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/meshy-cache.mjs" store \
  --id <id> --prompt "<영문 형상 설명>" --texture-prompt "<텍스처 문구>" \
  --file <다운로드한 glb> --thumb-url <thumbnail_url> \
  --task-id <refine task id> --preview-task-id <preview task id> --task-type text-to-3d \
  --style <프리셋> --ai-model meshy-6 --polycount 8000 --topology triangle --textured true \
  --credits 30 --tags boss,planet-blitz --project planet-blitz
```

- **`--task-id` 를 반드시 남긴다** — 만료 전까지 이것이 변형(retexture/remesh)의 유일한 열쇠다.
- **`--thumb-url` 도 만료된다.** GLB 와 같은 시점에 받아야 목록 미리보기를 잃지 않는다.
- store 는 GLB 를 열어 **삼각형 수와 텍스처 바이트를 실측해** 원장에 적는다. "왜 무거운가"는 지오메트리인지
  텍스처인지에 따라 처방이 갈리므로, 나중에 다시 재지 않아도 되게 지금 기록한다.
- 보관이 끝나면 pending 에서 자동으로 빠진다.

## 7) 반출 — 복사만, 축소는 소비 프로젝트 몫

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/meshy-cache.mjs" export --id <id> --to <대상 경로>
```

원본은 풀 텍스처 그대로 보관돼 있다. **웹/게임 반입 전 표시 해상도에 맞춘 텍스처 축소는 소비 프로젝트의
빌드 파이프라인이 한다**(실측 예: 12.91MB → 0.55MB). 이 플러그인은 원본을 잃지 않는 데까지만 책임진다.

## 주의

- **라이브러리는 유일본이다.** git 에도 서버에도 사본이 없다. `library/` 를 지우면 크레딧을 다시 써야 한다.
- **MCP 미연결 시 우아한 실패**: 생성 불가를 알리고 중단. 임의로 대체 모델을 만들지 않는다.
- **세션 마무리 체크리스트**: ① `pending` 이 비었는가 ② 생성분 전부 `store` 됐는가 ③ `--task-id` 가 원장에 있는가.
- 리깅·애니메이션은 **휴머노이드 전용 카탈로그**다. 게임 고유 연출은 엔진에서 트랜스폼·머티리얼로 저작하는 게 맞다.
