# Meshy 실전 가이드 (파라미터·비용·함정)

`~/.claude/skills/omc-learned/meshy-3d-modeling-workflow.md`(2026-07-30 Planet Blitz 보스 작업에서 얻은
학습 스킬)를 이 플러그인으로 흡수한 문서다. **만료·보관 부분은 그 문서보다 이 문서가 옳다** —
학습 스킬은 "보관 단위는 task id" 라고 적었지만, task 는 3일이면 죽는다.

이 문서와 실제 도구 스키마가 충돌하면 **스키마가 이긴다**.

## 1. 비용 (크레딧)

| 도구 | 비용 | 비고 |
|---|---|---|
| `meshy_text_to_3d` | meshy-6 **20** / meshy-5 **5** | 프리뷰(무텍스처) |
| `meshy_text_to_3d_refine` | **10** | 텍스처 입힘 |
| `meshy_image_to_3d` | 5~30 | 이미지 경로. refine 단계가 따로 없다(`should_texture` 로 제어) |
| `meshy_multi_image_to_3d` | 5~30 | |
| `meshy_remesh` | **5** | ⚠️ 생성 시 지정하면 불필요 |
| `meshy_retexture` | **10** | 형상 유지, 텍스처만 교체 |
| `meshy_rig` | **5** | 걷기·달리기 무료 포함 |
| `meshy_animate` | **3**/개 | 정수 `action_id` 사전 정의 카탈로그 |
| `meshy_convert` / `meshy_resize` | 1 | |
| `meshy_uv_unwrap` | 5 | |
| `meshy_creative_lab` | 36 | prototype 6 + build 30 |
| `meshy_text_to_image` / `image_to_image` | nano-banana 3 / -2 6 / -pro 9 / gpt-image-2 9~12 | 레퍼런스 이미지 |

**크레딧을 쓰기 전 사용자 확인이 필수다**(MCP 서버 지침). `meshy_check_balance` 로 잔액 먼저.

## 2. 보관(retention) — 이 플러그인이 존재하는 이유

- 비-Enterprise 생성물은 **3일 뒤 서버에서 삭제**되고 다운로드 서명 URL 도 3일에 만료된다.
  (https://docs.meshy.ai/en/api/asset-retention)
- **`thumbnail_url` 도 같은 서명 URL 계열이라 함께 만료된다** → GLB 와 같은 시점에 받아야 한다.
- `meshy_retexture` / `meshy_remesh` 는 `input_task_id` **또는 공개 `model_url`** 만 받는다.
  로컬 보관본에는 공개 URL 이 없으므로, **task 가 만료되면 변형 경로가 통째로 닫힌다.**
  → "색만 바꾸기"가 10크레딧에서 30크레딧(재생성)으로 뛴다. 변형 계획이 있으면 3일 안에 실행하라.
- `meshy_list_models` 로 워크스페이스에 **아직 살아 있는** 모델을 조회할 수 있다(task id 분실 시 복구 경로).
  단 만료된 것은 여기에도 없다.

## 3. 생성 — 폴리곤은 생성 시점에 정한다

```
meshy_text_to_3d({
  prompt, ai_model: 'meshy-6',
  should_remesh: true,        // ★ 이게 없으면 target_polycount 가 조용히 무시된다
  target_polycount: 8000,     // 100~300,000, 기본 30,000
  topology: 'triangle',
  target_formats: ['glb'],
  multi_view_thumbnails: true,
})
```

**함정**: `target_polycount` 는 remesh 가 켜졌을 때만 적용되는데 **meshy-6 는 `should_remesh` 기본값이
false** 다(meshy-5 는 true). 그것만 빠지면 지정값이 무시되고 **삼각형 1,016,472개 / 32.7MB** 가 나온다.
예외도 경고도 없다.

다른 축:
- `model_type: 'lowpoly'` → `ai_model`·`topology`·`target_polycount`·`should_remesh` **전부 무시**
- `decimation_mode`(1~4) → `target_polycount` 무시(적응형 감폴리)
- `pose_mode: 't-pose'` → **리깅할 계획일 때만**
- `alpha_thumbnail` → 투명 배경 미리보기, `multi_view_thumbnails` → 4방향(front/back/left/right). 둘 다 공짜다.

## 4. 텍스처(refine) — 2k 가 하한임을 전제로 설계

```
meshy_text_to_3d_refine({
  preview_task_id, ai_model: 'meshy-6',   // 프리뷰와 같은 모델
  texture_prompt: '...',
  remove_lighting: true,   // 엔진에서 직접 조명할 거면 true (하이라이트가 구워지지 않는다)
  enable_pbr: false,       // 필요할 때만 — 맵이 늘어 용량이 커진다
})
```

- `texture_resolution`: `2k`(기본)/`4k`/`8k` — **그 아래가 없다**.
  MCP 스키마에는 이 인자가 아예 없고 `hd_texture`(=4k) 뿐이다 → **MCP 경유로는 2k 가 최선**이고,
  더 작게 하려면 로컬 축소밖에 없다(소비 프로젝트 몫).
- `remove_lighting: true` 로 뽑은 베이스컬러는 **emissiveMap 으로 재사용**하기 좋다 — 발광 세기만 올려도
  균열·코어가 달아오르는 연출이 된다.

## 5. 리깅은 휴머노이드 전용이다

`meshy_rig` 는 t-pose 휴머노이드 전제(`height_meters` 기본 1.7), `meshy_animate` 는 정수 `action_id` 로 고르는
**사전 정의 카탈로그**(dancing/jumping/fighting…)다. 텍스트로 임의 동작을 만드는 게 아니다.

→ 우주선·전차·요새형 보스는 스켈레톤이 의미가 없고, 게임 고유 연출(페이즈 전환·과열·부스터)은 애초에
카탈로그에 없다. **Meshy 는 메시만 주고, 연출은 엔진에서 트랜스폼 + 머티리얼로 저작한다.** 게임 상태와
1:1로 붙고 크레딧도 안 든다.

## 6. 반입 전 실측 — 무엇이 무거운지부터 가른다

다운로드 크기만 보지 마라. 지오메트리인지 텍스처인지에 따라 처방이 다르다.
`meshy-cache.mjs store` 가 이 실측을 자동으로 해서 원장에 적는다(`geometry.triangles`/`textureBytes`).

실측 예: 리메시 후 13.5MB 중 지오메트리는 0.4MB, **나머지 13.1MB 가 2K PNG 두 장**(베이스컬러 6.0 + 노멀맵 7.1).

로컬 축소(소비 프로젝트에서):
- 내장 이미지 bufferView 만 디코드 → **면적평균(box) 축소** → 재인코드 → BIN 재조립(bufferView 오프셋 재계산).
  지오메트리 accessor 는 bufferView 내 상대 오프셋을 쓰므로 내용을 그대로 옮기면 유효하다.
- **nearest 가 아니라 면적평균**이어야 균열·발광의 밝기 분포가 보존된다.
- 목표 크기는 **화면 표시 해상도 기준**: 베이스컬러는 표시 폭의 1.5~2배, 노멀맵은 그 절반.
  실측 **12.91MB → 0.55MB (95.7% 감소)**.

## 7. Recognition Pattern

| 증상 | 처방 |
|---|---|
| `target_polycount` 를 줬는데 안 먹었다 | `should_remesh: true` 누락 |
| GLB 가 수 MB~수십 MB | §6 으로 원인부터 가른다(지오메트리 vs 텍스처) |
| "색만 다른 변형이 필요하다" | 재생성이 아니라 `retexture` — **단 3일 안** |
| "애니메이션을 붙이고 싶다" | 대상이 휴머노이드인지 먼저 확인. 아니면 엔진에서 저작 |
| 생성했는데 며칠 지났다 | `meshy_list_models` 로 생존 확인. 없으면 재생성뿐 |

## 8. 최소 경로 (보스 하나, 30크레딧)

```
1. meshy_check_balance
2. meshy-cache.mjs pending          — 증발 직전인 것부터 건진다
3. meshy-cache.mjs find "..."       — 이미 있는지, 변형으로 될 일인지
4. meshy_text_to_3d({ should_remesh:true, target_polycount:8000, target_formats:['glb'],
                      multi_view_thumbnails:true })                       // 20
5. meshy_get_task_status(wait:true)
6. meshy_text_to_3d_refine({ preview_task_id, texture_prompt, remove_lighting:true })  // 10
7. meshy_download_model(refine_task_id, 'glb', save_to)                   — 즉시
8. meshy-cache.mjs store --task-id ... --thumb-url ...                    — 즉시
```
