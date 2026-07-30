# 스타일 프리셋

한 게임·한 세트의 생성물이 공유하는 **생성 파라미터 묶음**이다. pixellab-forge 의 "스타일 앵커"에 대응하지만
Meshy 에는 `style_images` 가 없으므로, 대응물은 **텍스처 프롬프트 조각 + 모델/토폴로지/폴리곤 + (선택) 참조 이미지**다.

- 파일: `styles/<이름>.json`
- 생성 시 이 값들을 그대로 호출에 싣고, 보관 시 `--style <이름>` 으로 원장에 이름을 남긴다.
- `find --style <이름>` 으로 같은 세트만 추려 세트 일관성을 지킨다(`--style-strict` 면 다른 세트는 배제).

## 스키마

| 키 | 뜻 |
|---|---|
| `name` | 프리셋 이름(파일명과 동일) |
| `description` | 이 세트가 무엇인지(사람용) |
| `aiModel` | `meshy-6` \| `meshy-5` \| `latest` |
| `topology` | `triangle` \| `quad` |
| `targetPolycount` | 목표 폴리곤 수 — **`shouldRemesh: true` 와 같이 줘야 적용된다** |
| `shouldRemesh` | meshy-6 는 기본 false 라 명시하지 않으면 폴리곤 지정이 조용히 무시된다 |
| `removeLighting` | 베이스컬러에서 하이라이트·그림자 제거(엔진에서 직접 조명할 때 true) |
| `enablePbr` | PBR 맵 생성(맵이 늘어 용량이 커진다 — 필요할 때만) |
| `texturePromptPrefix` | 모든 텍스처 프롬프트 앞에 붙이는 공통 문구(세트 톤을 고정) |
| `promptSuffix` | 형상 프롬프트 뒤에 붙이는 공통 문구 |
| `targetFormats` | 생성할 포맷(필요한 것만 — 완료 시간이 짧아진다) |

`example-lowpoly-scifi.json` 을 복사해 새 세트를 만든다.
