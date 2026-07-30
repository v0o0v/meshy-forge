# meshy-forge

Meshy MCP 위에 얹는 **3일 만료 방어 + 로컬 모델 보관·검색** 플러그인.

Meshy 는 비-Enterprise 생성물을 **3일 뒤 서버에서 삭제**한다([asset retention](https://docs.meshy.ai/en/api/asset-retention)).
다운로드를 놓치면 20~30크레딧이 그대로 증발하고, `retexture`/`remesh` 가 받는 `input_task_id` 도 함께 죽는다.
이 플러그인은 ① 만료 전에 원본을 로컬로 옮기고 ② 프롬프트로 다시 찾아 쓰게 만든다.

## 무엇이 어디에 있나

| | 위치 | git |
|---|---|---|
| 플러그인 코드·스킬 | 이 리포 | ✅ 커밋 |
| GLB 원본·썸네일·원장 | `library/` (기본값) | ❌ **절대 커밋 안 함** — 모델 한 건이 10MB 대 |
| Meshy MCP 설정(API 키) | `.mcp.json` | ❌ gitignore(로컬 디렉터리 마켓플레이스가 설치 사본으로 복사) |

라이브러리 경로 해석 순서:
`MESHY_FORGE_LIBRARY` → `~/.claude/meshy-forge.json` 의 `"library"` → **마켓플레이스 소스 리포**`/library` → 플러그인 루트.

> 세 번째가 중요하다. 플러그인은 설치 시 `~/.claude/plugins/cache/...` 로 **복사**되므로,
> 라이브러리를 플러그인 루트에 두면 재설치 한 번에 유일본이 사라진다.
> (pixellab-forge 에서 실제로 밟은 함정이다.)

## 설치

```
claude plugin marketplace add D:\ClaudeCowork\meshy-forge
claude plugin install meshy-forge@meshy-forge
node scripts/meshy-cache.mjs setup
```

`setup` 은 검색 인덱스 백엔드(better-sqlite3 FTS5)를 설치·검증한다.
Node 메이저 버전을 올린 뒤 인덱스가 죽으면 같은 명령이 `npm rebuild` 로 복구한다.

## 명령

```
node scripts/meshy-cache.mjs pending                       미보관 task 와 남은 시간(🔥 = 24h 미만)
node scripts/meshy-cache.mjs find "<영문 설명>" [--style …]  보관본 조회(score ≥ 0.6 이면 후보 제시)
node scripts/meshy-cache.mjs store --id … --file … --task-id …   보관(GLB 실측 + 원장 등록)
node scripts/meshy-cache.mjs export --id … --to <경로>      소비 프로젝트로 복사
node scripts/meshy-cache.mjs list | get <id> | config | prune | rebuild | test
node scripts/gallery.mjs --open                            브라우저에서 실물 GLB 회전(검수용)
node scripts/plugin-sync-check.mjs                         설치 사본이 소스보다 낡았는지
```

## 훅 (둘 다 비차단)

- **PreToolUse** `reuse-guard.mjs` — 생성 직전에 ① 만료 임박 미보관 task ② 유사 보관본을 알린다.
  차단하지 않는다: 3D 는 미세한 형상 차이가 용도를 가르므로 재사용 강제는 해롭다.
- **PostToolUse** `pending-record.mjs` — 생성 호출을 pending 원장에 남긴다(응답에서 task id 추출).
  "만들었는데 안 받았다"를 다음 호출·다음 `pending` 에서 잡는다.

## 문서

- `CONTEXT.md` — 용어·관계(보관/변형 창/미보관/스타일 프리셋)
- `skills/meshy/SKILL.md` — 실제 작업 순서
- `skills/meshy/references/meshy-guide.md` — 파라미터·비용·함정(`should_remesh` 누락, 2k 텍스처 하한, 리깅 한계)
- `styles/README.md` — 세트 일관성용 프리셋 스키마

## 테스트

```
node scripts/meshy-cache.mjs test          13건
node scripts/plugin-sync-check.mjs test     6건
```
