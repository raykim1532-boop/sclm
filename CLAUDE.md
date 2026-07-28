# SCLM — 프로젝트 안내 (Claude Code용)

## 개요
**SCLM (스케줄 관리)** — 개인 업무용 일정/할일 관리 웹앱. 유통사업팀 실제 업무 데이터(할일 40여 건, 세부채널 등)를 관리한다.
- **단일 HTML 앱**: `MySchedulerApp.html` (루트) 하나에 CSS·JS·FullCalendar 번들이 모두 인라인.
- **클라우드 배포**: Cloudflare Pages + D1(SQLite). 여러 기기에서 같은 데이터 공유.
- **라이브 주소**: https://sclm.pages.dev (Pages 프로젝트명 `sclm`).

## 문서
`docs/TECH-SPEC.md`(기술 스펙·IA — 시스템 구성/API 명세/데이터 모델/보안), `docs/USER-GUIDE.md`(사용자 가이드). **구조·API·화면을 바꾸면 해당 문서도 갱신할 것.**

## 소스/작업 규칙
- 앱 로직은 **오직 `MySchedulerApp.html`만 수정**한다. `web/public/index.html`은 빌드 산출물(`web/build.js`가 복사)이라 직접 수정 금지 — gitignore됨.
- **FullCalendar 임베드 번들(HTML 내 대용량 `<script>`/`<style>` 블록)은 수정하지 말 것.**
- 배포 절차: `cd web && npm run deploy` = `node build.js && wrangler pages deploy public --project-name sclm --branch=main`. **`--branch=main` 필수**(production 브랜치). package.json에 반영돼 있음.

## 배포물이 2개다 (중요)
1. **Pages `sclm`** — 앱 + Functions(`web/functions/api/**`). 배포: `cd web && npm run deploy`.
2. **별도 Worker `sclm-push-cron`** (`web/push-cron/`) — 매일 08:00·08:10 KST에 **두 엔드포인트를 각각** `X-Cron-Secret`으로 호출. 배포: `cd web/push-cron && npx wrangler deploy`.
   - ⚠️ **이 계정의 Cloudflare 크론은 이벤트를 발사하지 않는 문제가 있음**(2026-07-28 `wrangler tail`로 확정 — 워커 재생성·시크릿 회전에도 재현). 그래서 **주 스케줄러는 GitHub Actions**(`.github/workflows/daily-alarm.yml`, 07:57·08:12 KST)이고 이 워커는 백업. `run-daily`의 하루 1회 가드(documents id='daily')가 양쪽 중복 발송을 막는다.
   - GitHub 저장소 시크릿 `CRON_SECRET`(Pages와 동일 값) 필요 — Settings → Secrets → Actions.
   - `/api/push/run-daily` — 시트 동기화 + 마감/지연 요약 푸시·카카오 발송
   - `/api/google/sync` — 캘린더 양방향 동기화(`truncated`면 최대 3회 이어서). URL은 `CAL_URL` 또는 `TARGET_URL`에서 자동 유추.
   - ⚠️ 요청을 나눈 이유: Cloudflare **서브리퀘스트 한도(요청당 50)**를 각각 따로 쓰기 위해. 한 요청에 합치지 말 것.
   - 클라이언트의 15분 주기 폴링은 **제거**됨(앱 열 때 1회 + 수동 버튼만). 정기 갱신은 이 크론이 담당하므로, 탭을 안 켜도 캘린더가 최신 유지된다.

## 주요 구조
- `web/functions/api/` — Pages Functions(파일 기반 라우팅). 앱 비밀번호(Bearer) 인증.
  - `_auth.js`(공용 인증), `health.js`(클라우드 감지 핑), `data.js`(상태 load/save), `snapshots.js`(D1 백업/복원)
  - `google/*` — 구글 OAuth(`_util.js`, 스코프 `calendar`+`spreadsheets`) + 캘린더 양방향 동기화(`sync.js`, 전용 "SCLM" 캘린더) + **시트 읽기 전용 가져오기**(`_sheets.js`, `sheet-config.js` 대상시트 저장, `sheet-sync.js`). 시트 동기화는 **시트에 쓰지 않고**(수식·구조 보존) 고정 열 위치로 파싱, 헤더 구조 가드 후 `todos`를 시트 기준으로 교체(id=등록일+업무내용 해시로 안정, `googleId` 보존). 공용 `runSheetSync(env)`를 엔드포인트와 `push/run-daily`가 함께 사용. ⚠️ 과거 양방향(full-rewrite)이 실사용 시트를 훼손해 읽기 전용으로 전환함.
  - `push/*` — 웹푸시(aes128gcm+VAPID) + 카카오 '나에게 보내기': `subscribe`, `test`, `run-daily`(알림 전 `runSheetSync`로 시트 먼저 동기화), `kakao-test`, `_webpush.js`, `_send.js`, `_kakao.js`. `public/sw.js`=서비스워커.
  - `files/[[path]].js` — **파일 첨부**(R2 버킷 `sclm-files`, 바인딩 `FILES`). POST 업로드(multipart, 25MB) / GET 다운로드(`?t=<APP_PASSWORD>` 쿼리도 허용 — `<a href>`용) / DELETE. 키는 서버 생성 + 형식 검증. 할일의 `files:[{key,name,size}]`에 저장, 표에 📎N 배지. ⚠️ `wrangler r2 bucket info`의 object_count는 반영이 지연되니, 검증은 `wrangler r2 object get`으로.
  - `assistant.js` — **AI 일정 비서**(자연어 채팅). **무료 Google Gemini**(`gemini-2.5-flash`) function-calling으로 D1 직접 조회·생성. 도구: list_schedule/find_free_slots/add_event/add_todo/complete_todo. 프론트는 우하단 🤖 위젯(`setupAssistant`, 클라우드 전용), 실행 시 상태 자동 새로고침. `GEMINI_API_KEY` 필요. (유료 Claude로 바꾸려면 이 파일의 API 호출부만 교체.)
- `web/wrangler.toml` — D1 바인딩(`DB` = scheduler-db) + R2 바인딩(`FILES` = sclm-files). `web/schema.sql`, `web/seed.sql`.
- `web/static/` — **배포용 정적 자산(추적됨)**: `manifest.webmanifest`, `icon-192/512/180.png`, `sw.js`. `build.js`가 `static/* → public/`으로 복사한다. `web/public/`은 gitignore이므로 **배포에 필요한 파일은 반드시 static/에 두고 커밋**할 것.
- **PWA**: manifest + apple-touch-icon + standalone 메타로 홈 화면 설치 지원(아이폰은 설치해야 푸시 가능).
- **오프라인**(`web/static/sw.js`): 문서=네트워크 우선→캐시 셸, 정적자산=캐시 우선+백그라운드 갱신, `GET /api/data`=네트워크 우선+캐싱(오프라인이면 마지막 응답에 `X-SCLM-Offline: 1` 붙여 반환), `GET /api/health`=오프라인이면 **데이터 캐시가 있을 때만** `{cloud:true,offline:true}` 합성(없으면 그대로 실패시켜 로컬 모드로). 비-GET·나머지 `/api/*`는 개입하지 않음. 앱 쪽: `setupServiceWorker`/`setupOfflineBar`/`reconcileOffline`. 오프라인 저장 실패분은 `myscheduler:offline:pending`에 보관했다가 온라인 복귀 시 **사용자 확인 후** 업로드/폐기(자동 덮어쓰기 금지 — 다른 기기 작업이 날아감). `verify()`는 `true|false|'offline'` 3값이며 캐시 응답(`X-SCLM-Offline`)으로는 비밀번호를 통과시키지 않는다. 캐시 스키마 바꾸면 `sw.js`의 `VERSION` 올릴 것.
- 데이터 스키마(D1 documents id='main' JSON): `{ settings, projects, events, todos, channels, tasks }`. 실제 업무는 `todos`. `tasks`는 미사용(칸반이 todos 기반).

## 시크릿 (저장소에 없음 — Cloudflare에만)
Pages `sclm`: `APP_PASSWORD`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `KAKAO_REST_API_KEY`, `KAKAO_REFRESH_TOKEN`(선택 `KAKAO_CLIENT_SECRET`), `GEMINI_API_KEY`(AI 비서, aistudio.google.com 무료 키).
Worker `sclm-push-cron`: `CRON_SECRET`(Pages와 동일 값).
- 카카오 '나에게 보내기' 매일 알림: `run-daily`가 웹푸시와 함께 카카오 메모를 발송한다(`push/_kakao.js`). `KAKAO_REFRESH_TOKEN`으로 access token을 매 호출 재발급. 설정 안 돼 있으면 카카오만 건너뜀(푸시는 정상). 토큰 발급 절차는 `web/PUSH-SETUP.md` 참고. 검증: `POST /api/push/kakao-test`(Bearer=APP_PASSWORD).
- 시크릿 등록: `npx wrangler pages secret put <NAME> --project-name sclm` (워커는 `npx wrangler secret put <NAME>`).
- 시크릿 변경 후엔 **Pages 재배포**해야 반영됨.
- **어시스턴트는 비밀번호/키를 직접 입력하지 않는다** — 값은 사용자가 등록. 공개값(client_id 등)만 예외.
- 로컬 미리보기: `web/.dev.vars`에 `APP_PASSWORD=...` (gitignore됨) 후 `npm run dev`.

## 테스트
`cd web && npm test` — `web/tests/*.test.mjs`를 모두 실행(외부 의존성 없음, D1/fetch 모의). **코드 수정 후 반드시 실행할 것.**
- `data-vault` 금고 보존 규칙(저장 요청에 vault 없으면 기존 암호문 유지) · `sheet-sync` 비파괴/구조가드/앱항목 보존/id 안정성
- `calendar-sync` 공용 함수·크론 인증 · `kakao` refresh_token 회전 저장·200자 분할 · `vault-crypto` 암호화 왕복·마스터 비번 변경
- `vault-crypto`는 `MySchedulerApp.html`에서 함수를 **정규식으로 추출**해 검증하므로, 해당 함수명(`vaultDeriveKey`·`vB64e`·`vB64d`·`vaultGeneratePassword`·`VAULT_ITER`)을 바꾸면 테스트도 함께 고칠 것.

## 로컬 검증 흐름
빌드(`node build.js`) → 정적 서버(예: `python -m http.server`)로 `web/public` 서빙 → 브라우저로 확인. `/api/health`가 없으면 로컬(비클라우드) 모드로 뜬다. 함수/D1까지 보려면 `npm run dev`(wrangler pages dev).
- 클라우드 경로 검증 팁: `run-daily`를 `X-Cron-Secret`으로 직접 호출하면 D1+시크릿+발송을 한 번에 확인.

## 기기 간 작업
- 작업 전 `git pull`, 작업 후 `git add -A && git commit && git push`. **한 번에 한 기기에서만** 편집 권장.
- 새 기기 세팅: Node+Git 설치 → `git clone` → `cd web && npm install` → `npx wrangler login` → `npm run deploy`.

## 커밋 규칙
- 커밋 메시지 끝에: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- 실제 업무 데이터 백업(`Ray-Work-Flow-백업.json`)·시크릿은 커밋 금지(gitignore/placeholder 처리됨).
