# SCLM — 프로젝트 안내 (Claude Code용)

## 개요
**SCLM (스케줄 관리)** — 개인 업무용 일정/할일 관리 웹앱. 유통사업팀 실제 업무 데이터(할일 40여 건, 세부채널 등)를 관리한다.
- **단일 HTML 앱**: `MySchedulerApp.html` (루트) 하나에 CSS·JS·FullCalendar 번들이 모두 인라인.
- **클라우드 배포**: Cloudflare Pages + D1(SQLite). 여러 기기에서 같은 데이터 공유.
- **라이브 주소**: https://sclm.pages.dev (Pages 프로젝트명 `sclm`).

## 소스/작업 규칙
- 앱 로직은 **오직 `MySchedulerApp.html`만 수정**한다. `web/public/index.html`은 빌드 산출물(`web/build.js`가 복사)이라 직접 수정 금지 — gitignore됨.
- **FullCalendar 임베드 번들(HTML 내 대용량 `<script>`/`<style>` 블록)은 수정하지 말 것.**
- 배포 절차: `cd web && npm run deploy` = `node build.js && wrangler pages deploy public --project-name sclm --branch=main`. **`--branch=main` 필수**(production 브랜치). package.json에 반영돼 있음.

## 배포물이 2개다 (중요)
1. **Pages `sclm`** — 앱 + Functions(`web/functions/api/**`). 배포: `cd web && npm run deploy`.
2. **별도 Worker `sclm-push-cron`** (`web/push-cron/`) — 매일 08:00 KST(cron `0 23 * * *`)에 Pages `/api/push/run-daily`를 `X-Cron-Secret`으로 호출해 마감/지연 요약 푸시 발송. 배포: `cd web/push-cron && npx wrangler deploy`.

## 주요 구조
- `web/functions/api/` — Pages Functions(파일 기반 라우팅). 앱 비밀번호(Bearer) 인증.
  - `_auth.js`(공용 인증), `health.js`(클라우드 감지 핑), `data.js`(상태 load/save), `snapshots.js`(D1 백업/복원)
  - `google/*` — 구글 캘린더 OAuth + 양방향 동기화(생성/수정/삭제). 전용 "SCLM" 구글 캘린더에만 반영.
  - `push/*` — 웹푸시(aes128gcm+VAPID): `subscribe`, `test`, `run-daily`, `_webpush.js`, `_send.js`. `public/sw.js`=서비스워커.
- `web/wrangler.toml` — D1 바인딩(`DB` = scheduler-db). `web/schema.sql`, `web/seed.sql`.
- 데이터 스키마(D1 documents id='main' JSON): `{ settings, projects, events, todos, channels, tasks }`. 실제 업무는 `todos`. `tasks`는 미사용(칸반이 todos 기반).

## 시크릿 (저장소에 없음 — Cloudflare에만)
Pages `sclm`: `APP_PASSWORD`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
Worker `sclm-push-cron`: `CRON_SECRET`(Pages와 동일 값).
- 시크릿 등록: `npx wrangler pages secret put <NAME> --project-name sclm` (워커는 `npx wrangler secret put <NAME>`).
- 시크릿 변경 후엔 **Pages 재배포**해야 반영됨.
- **어시스턴트는 비밀번호/키를 직접 입력하지 않는다** — 값은 사용자가 등록. 공개값(client_id 등)만 예외.
- 로컬 미리보기: `web/.dev.vars`에 `APP_PASSWORD=...` (gitignore됨) 후 `npm run dev`.

## 로컬 검증 흐름
빌드(`node build.js`) → 정적 서버(예: `python -m http.server`)로 `web/public` 서빙 → 브라우저로 확인. `/api/health`가 없으면 로컬(비클라우드) 모드로 뜬다. 함수/D1까지 보려면 `npm run dev`(wrangler pages dev).
- 클라우드 경로 검증 팁: `run-daily`를 `X-Cron-Secret`으로 직접 호출하면 D1+시크릿+발송을 한 번에 확인.

## 기기 간 작업
- 작업 전 `git pull`, 작업 후 `git add -A && git commit && git push`. **한 번에 한 기기에서만** 편집 권장.
- 새 기기 세팅: Node+Git 설치 → `git clone` → `cd web && npm install` → `npx wrangler login` → `npm run deploy`.

## 커밋 규칙
- 커밋 메시지 끝에: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- 실제 업무 데이터 백업(`Ray-Work-Flow-백업.json`)·시크릿은 커밋 금지(gitignore/placeholder 처리됨).
