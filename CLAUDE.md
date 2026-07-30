# SCLM — 프로젝트 안내 (Claude Code용)

## 개요
**SCLM (스케줄 관리)** — 개인 업무용 일정/할일 관리 웹앱. 유통사업팀 실제 업무 데이터(할일 40여 건, 세부채널 등)를 관리한다.
- **단일 HTML 앱**: 배포물은 인라인 CSS·JS·FullCalendar 번들이 들어간 `index.html` 한 장. **소스는 `src/` 조각으로 나눠 두고 빌드 때 합친다.**
- **클라우드 배포**: Cloudflare Pages + D1(SQLite). 여러 기기에서 같은 데이터 공유.
- **라이브 주소**: https://sclm.pages.dev (Pages 프로젝트명 `sclm`).

## 문서
`docs/TECH-SPEC.md`(기술 스펙·IA — 시스템 구성/API 명세/데이터 모델/보안), `docs/USER-GUIDE.md`(사용자 가이드). **구조·API·화면을 바꾸면 해당 문서도 갱신할 것.**

## 소스/작업 규칙
- 앱 소스는 **`src/` 안에서만 수정**한다. `web/public/index.html`은 빌드 산출물(`web/build.js`가 생성)이라 직접 수정 금지 — gitignore됨.
  | 파일 | 내용 |
  |---|---|
  | `src/shell.html` | HTML 뼈대 + 화면 마크업 + **FullCalendar 임베드 번들** + `<!--@include 경로-->` 자리표시자 |
  | `src/app.css` | 앱 스타일 전부 |
  | `src/local-api.js` | 로컬 저장 계층(`window.api`) |
  | `src/cloud-sync.js` | 클라우드 동기화(`window.CloudSync`) |
  | `src/app.js` | 앱 로직 전부(렌더·모달·대시보드·금고 등) |
    - 대시보드 분석 카드는 `renderDashAnalytics()` 하나가 다 그린다. 계산은 순수 함수(`computeWorkStats` / `computeTrend` / `computeDataIssues` / `computeTaxoTop`)로 빼 두었고 `web/tests/`에서 소스에서 정규식으로 떼어내 검증하므로, **이름이나 시그니처를 바꾸면 테스트의 `grab(...)` 정규식도 같이 고쳐야 한다.**
    - **업무 로그 · 마감일 변경 이력** (2026-07-30). 둘 다 할 일에 배열로 붙는다 — `logs: [{at:'YYYY-MM-DD', text}]`, `dueHistory: [{from, to, at}]`. 순수 함수(`todoLogs`/`todoLogLatest`/`todoProgressCell`/`dueMoveCount`/`dueHistoryText`/`pushDueHistory`)로 빼 두었고 `todo-log.test.mjs`가 소스에서 추출해 검증한다.
      - ⚠️ **옛 `progress`(자유 텍스트)는 건드리지 않는다.** 43건에 내용이 있고 CSV·시트 머리글 매핑이 그 필드를 쓴다. 표는 로그가 있으면 로그를, 없으면 `progress`를 보여줄 뿐이다(`todoProgressCell`). 마이그레이션하지 말 것.
      - 로그는 모달 DOM(`.log-row`의 `data-at`/`data-text`)이 표시의 원본이고, `syncLogs()`가 그걸 그대로 `todo.logs`로 옮겨 담는다(표시와 데이터가 어긋날 여지를 없앤다).
      - ⚠️ **기존 할 일의 로그는 [기록]/✕ 즉시 저장**된다(2026-07-30). 로그는 "적으면 남는다"가 자연스러운데, [저장]을 눌러야 남는 구조라 적어 놓고 잃는 일이 있었다. **새로 만드는 중인 할 일만** 저장할 대상이 없어 [저장] 때 함께 반영된다.
      - `persist()`는 성공 여부를 돌려준다. 즉시저장 경로에서 성공 토스트가 **저장 실패 토스트를 덮어쓰지 않도록** 반드시 반환값을 보고 띄울 것.
      - `dueMoveCount`는 **뒤로 민 것만** 센다(앞당긴 건 이력엔 남지만 배지로 경고하지 않는다). 보고 싶은 건 "이 건이 자꾸 밀린다"이지 날짜가 몇 번 바뀌었나가 아니다.
    - **분류 Top**은 대·중·소를 카드 하나에서 탭으로 바꿔 보는 구조(`TAXO_AXES` + `taxoTab`). 세 축이 같은 눈금(막대 = 전체 건수, 진한 부분 = 완료 비율)을 쓰는 게 핵심이라, 축마다 다른 지표를 쓰지 말 것 — 예전에 대분류만 "진행률", 중분류만 "미완료 건수"였던 탓에 서로 비교가 안 됐다.
- **FullCalendar 임베드 번들(`src/shell.html` 안의 대용량 `<script>` 4개)은 수정하지 말 것.**
- `build.js`는 `<!--@include ...-->` 자리표시자를 파일 내용으로 치환할 뿐이다. 조각을 추가하려면 shell.html에 자리표시자를 넣고 파일을 만들면 된다. 처리 못 한 자리표시자가 남으면 빌드가 실패한다.
- ⚠️ 조각 파일은 **CRLF**다(원본 HTML을 그대로 쪼갠 것). 줄바꿈을 통째로 바꾸면 diff가 폭발하니 건드리지 말 것.
- 배포 절차: `cd web && npm run deploy` = `node build.js && wrangler pages deploy public --project-name sclm --branch=main`. **`--branch=main` 필수**(production 브랜치). package.json에 반영돼 있음.

## 배포물이 2개다 (중요)
1. **Pages `sclm`** — 앱 + Functions(`web/functions/api/**`). 배포: `cd web && npm run deploy`.
2. **별도 Worker `sclm-push-cron`** (`web/push-cron/`) — 매일 08:00·08:10 KST에 **두 엔드포인트를 각각** `X-Cron-Secret`으로 호출. 배포: `cd web/push-cron && npx wrangler deploy`.
   - **정기 발송은 이 워커가 단독으로 한다**(08:00 본발사 + 08:10 재시도). GitHub Actions(`.github/workflows/daily-alarm.yml`)는 **정기 스케줄을 해제**하고 `workflow_dispatch` 수동 예비용으로만 남겼다 — 아침에 알림이 안 오면 Actions 탭에서 [Run workflow].
   - **2일 연속 실측(2026-07-29·30)**: `cf-cron` 08:00:16 정시 발송(양일 동일, 초 단위 일치) / 08:10 재시도는 가드로 skipped. `gh-actions`는 예정(07:57·08:12)보다 **9시간 이상 지각**(07-29 17:11, 07-30 16:56)해 둘 다 skipped. **저녁에 오는 아침 브리핑은 백업 역할도 못 하므로 정기 실행을 껐다.**
   - ⚠️ 그 이전의 "이 계정 크론은 발사되지 않는다"는 진단은 **틀렸다**. 워커를 재생성한 뒤 아직 23:00 UTC가 지나지 않아 발사 기회가 없던 것을 미발사로 오해했고, `wrangler tail`이 실행 중인 동안의 이벤트만 보여주는 것도 오해를 키웠다(낮에 띄워 아무것도 없는 건 정상). **관측 없이 미발사로 단정하지 말 것.**
   - 단독 운영의 위험은 08:10 재시도와 수동 예비(위)로 받는다. 아침 알림이 안 온 날이 있으면 `daily` 문서의 `attempts`를 먼저 볼 것 — 발사는 됐는데 `nothing_due`로 걸렀을 수도 있다.
   - 판정 방법: `run-daily`가 호출자를 `X-Cron-Source`(`cf-cron`/`gh-actions`/`cf-manual`/`manual`)로 기록한다. 아침 이후 `SELECT data FROM documents WHERE id='daily'`의 `attempts`를 보면 어느 쪽이 실제로 발사됐는지(그리고 중복이라 `skipped`됐는지) 알 수 있다.
   - GitHub 저장소 시크릿 `CRON_SECRET`(Pages와 동일 값) 필요 — Settings → Secrets → Actions.
   - `/api/google/sync` — 캘린더 양방향 동기화(`truncated`면 최대 3회 이어서). URL은 `CAL_URL` 또는 `TARGET_URL`에서 자동 유추.
   - `/api/push/run-daily` — 마감/지연 + **오늘 일정** 요약 푸시·카카오 발송 (시트 선동기화는 2026-07-28 제거)
   - ⚠️ **호출 순서가 중요하다: 캘린더 동기화 → 브리핑.** 브리핑이 `state.events`에서 오늘 일정을 읽으므로 캘린더를 먼저 맞춰야 한다. 반대로 두면 **어제 동기화분**을 보고 나간다(2026-07-30 이전이 그 상태였다). 동기화 실패가 브리핑을 막지 않도록 `try/catch`로 끊어 두었으니 이 보호를 없애지 말 것. GitHub Actions 워크플로(`daily-alarm.yml`)도 같은 순서다.
   - ⚠️ 요청을 나눈 이유: Cloudflare **서브리퀘스트 한도(요청당 50)**를 각각 따로 쓰기 위해. 한 요청에 합치지 말 것.
   - 클라이언트의 15분 주기 폴링은 **제거**됨(앱 열 때 1회 + 수동 버튼만). 정기 갱신은 이 크론이 담당하므로, 탭을 안 켜도 캘린더가 최신 유지된다.

## 주요 구조
- `web/functions/api/` — Pages Functions(파일 기반 라우팅). 앱 비밀번호(Bearer) 인증.
  - `_auth.js`(공용 인증), `health.js`(클라우드 감지 핑), `data.js`(상태 load/save), `snapshots.js`(D1 백업/복원)
    - ⚠️ **충돌은 3자 병합으로 자동 해결한다(2026-07-30)**. 두 기기를 동시에 켜 두면 앱이 연 뒤로 서버를 다시 읽지 않아 충돌이 **필연**이었고, 선택지가 "전부 버리기/전부 덮어쓰기"뿐이라 어느 쪽이든 잃었다. 이제 `cloud-sync.js`가 마지막으로 서버와 맞춘 상태를 `baseSnapshot`으로 들고 있다가, 409를 받으면 **base·mine·theirs** 셋을 비교해 합친다(`mergeStates`). 한쪽만 바꾼 항목은 그대로 반영, 같은 항목을 양쪽에서 고친 경우만 이 화면 것을 택하고 **토스트로 반드시 알린다**. 자동으로 못 정하는 건 **금고(vault)뿐**이며(통짜 암호문이라 합칠 수 없음) 그때만 옛 대화상자를 띄운다.
      - 병합 규칙: `todos`/`events`/`projects`는 **id로 짝지어** 비교, `channels`/`subMaster`는 "서버 것 − 내가 지운 것 + 내가 더한 것", 그 밖의 **모르는 키까지 전부** 훑는다(키를 열거하지 않는다 — 2026-07-29 화이트리스트 사고와 같은 계열). 한쪽이 지우고 한쪽이 고쳤으면 **남기는 쪽**을 택한다(지우는 건 다시 할 수 있지만 잃은 건 못 되돌린다).
      - 409 응답의 서버 데이터는 **`ensureShape`로 정규화한 뒤 병합**할 것. 기준점은 이미 정규화돼 있어서, 안 맞추면 `settings` 같은 기본값 키가 매번 가짜 충돌로 잡힌다.
      - `baseSnapshot`은 **불러올 때와 저장 성공할 때** 갱신한다. 이 갱신을 빠뜨리면 병합 기준이 틀어져 남의 작업을 되살리거나 지운다. 검증: `merge-states.test.mjs`(규칙 40개) + `merge-flow.test.mjs`(409→병합→재저장 전 구간).
    - **창을 다시 볼 때 자동 새로고침**(`setupAutoRefresh`): `visibilitychange`/`focus`에서 서버 버전을 확인해 바뀌었으면 조용히 불러온다. 편집 중(모달 열림)에는 건드리지 않고 20초 간격을 둔다. 충돌을 **애초에 줄이는** 쪽이라 병합보다 이게 먼저 일한다.
    - ⚠️ **저장 충돌 감지**: PUT은 통짜 덮어쓰기라 마지막에 저장한 쪽이 이긴다. 그래서 클라이언트가 마지막으로 읽은 버전(`baseVersion` = 그때의 `updated_at`)을 함께 보내고, 서버 버전이 다르면 **409 + 서버 데이터**를 돌려준다. 덮어쓰려면 `force:true`를 명시해야 하며, 앱은 `setupConflictHandler`가 사용자에게 '서버 것 불러오기 / 내 것으로 덮어쓰기'를 묻는다. **이 검사를 우회하거나 자동 force 하지 말 것** — 2026-07-29 오래된 탭이 덮어써서 할 일에 지정한 소분류가 통째로 사라진 사고가 있었다(시간여행으로도 대부분 복구 못 함). 검증: `data-conflict.test.mjs`.
    - 백업: 최근 20건 보관(prune), 자동 백업은 하루 1회(`force`로 강제). 복원 시 **현재 상태를 `pre-restore`로 먼저 백업**하므로 복원도 되돌릴 수 있다.
    - ⚠️ 복원은 **금고(vault) 암호문을 현재 것으로 유지**한다(`vaultKept`). 금고 생성 이전 스냅샷으로 되돌릴 때 계정이 통째로 사라지는 것을 막기 위함 — `data.js` PUT의 vault 보존 규칙과 같은 취지. 이 보호를 제거하지 말 것.
  - `google/*` — 구글 OAuth(`_util.js`, 스코프 `calendar`+`spreadsheets`) + 캘린더 양방향 동기화(`sync.js`, 전용 "SCLM" 캘린더) + **다른 캘린더 읽기 전용 가져오기**(`calendars.js`로 선택, `gdoc.readCalendars`에 저장)
    - ⚠️ **쓰기는 오직 "SCLM" 캘린더에만.** 가져온 항목은 `roCal`(출처 캘린더 id)로 표시되며 **① 푸시 루프에서 `continue`** ② **삭제 판정에서 제외**(present 집합은 SCLM 캘린더 것이라 그냥 두면 즉시 지워진다) ③ 앱에서 `openReadOnlyEventModal`로 보기 전용. 이 세 가지 중 하나라도 빠지면 개인 일정이 SCLM 캘린더로 복사되거나 사라진다. 검증: `calendar-sync.test.mjs`의 '읽기 전용 캘린더 가져오기' 절.
    - 선택에서 뺀 캘린더의 가져온 일정은 다음 동기화에서 정리된다. 캘린더 수 상한 8개(서브리퀘스트 한도). + ~~시트 읽기 전용 가져오기~~(`_sheets.js`, `sheet-config.js`, `sheet-sync.js`).
  - 🛑 **시트 연동은 2026-07-28 종료. 이 앱이 업무 데이터의 원천이다.** 시트가 원천이면 앱에서 바꾼 상태·첨부·링크가 다음 동기화 때 되돌아가고(실제 사고 2건), 앱 전용 기능(첨부·반복·캘린더·AI 등록)은 시트에 담을 수도 없다. 코드는 복구용으로 남겨두되 D1 `google` 문서의 `sheet.disabled = true` 로 막혀 있고(`runSheetSync`가 `sheet_sync_disabled` 반환), `run-daily`의 선동기화 호출과 앱 설정 UI도 제거했다. **되살리려면** 플래그를 지우고 UI·`run-daily` 호출을 복원할 것 — 단, 그 전에 앱 전용 필드 보존 규칙을 반드시 확인. 시트 동기화는 **시트에 쓰지 않고**(수식·구조 보존) 고정 열 위치로 파싱, 헤더 구조 가드 후 `todos`를 시트 기준으로 교체(id=등록일+업무내용 해시로 안정). ⚠️ **교체 시 시트에 없는 앱 전용 필드(`googleId`·`gSig`·`files`·`links`·`logs`·`dueHistory`)는 이전 값에서 반드시 되살릴 것** — 2026-07-28 이 누락으로 첨부파일이 동기화 한 번에 사라지고 R2 객체만 고아로 남는 사고가 있었다. 필드를 추가할 때마다 이 목록도 갱신하고 `sheet-sync.test.mjs`의 '앱 전용 데이터 보존' 절에 케이스를 넣을 것. 공용 `runSheetSync(env)`를 엔드포인트와 `push/run-daily`가 함께 사용. ⚠️ 과거 양방향(full-rewrite)이 실사용 시트를 훼손해 읽기 전용으로 전환함.
  - `push/*` — 웹푸시(aes128gcm+VAPID) + 카카오 '나에게 보내기': `subscribe`, `test`, `run-daily`(요약 계산 → 발송, 호출자를 `X-Cron-Source`로 기록), `kakao-test`, `_webpush.js`, `_send.js`, `_kakao.js`. `public/sw.js`=서비스워커.
    - 아침 브리핑 = **지연 · 오늘 마감 · 임박(3일) · 오늘 일정** 네 구분. 계산은 `_send.js`의 `computeSummary`(순수 함수 `pickTodayEvents` 사용), 푸시 본문은 `run-daily.js`의 `buildPushBody`, 카카오 본문은 `_kakao.js`의 `summaryLines`. **셋 다 따로 만들므로 구분을 추가하면 세 곳을 같이 고칠 것.**
    - 일정은 `state.events`에서 `start <= 오늘 <= end`로 뽑는다(여러 날 걸친 일정 포함). 정렬은 종일 → 시작시각 순. 구글에서 읽기 전용으로 가져온 일정(`roCal`)도 같은 배열이라 함께 잡히며, 공휴일 캘린더도 그렇게 들어온다.
    - ⚠️ **발송 여부 판정에 일정도 포함**된다(`s.events === 0`까지 봐야 `nothing_due`). 할 일이 없어도 오늘 회의가 있으면 알려야 하기 때문 — 이 조건에서 일정을 빼면 조용히 안 가는 날이 생긴다.
    - ⚠️ 푸시 본문 320자 제한은 **줄 단위로** 처리한다(`buildPushBody`가 뒤에서부터 덜어내고 "외 N건"을 늘림). 그냥 `slice`하면 글자 중간에서 잘려 토막 줄이 남는다. 검증: `brief-events.test.mjs`.
  - `files/[[path]].js` — **파일 첨부**(R2 버킷 `sclm-files`, 바인딩 `FILES`). POST 업로드(multipart, 25MB) / GET 다운로드(`?t=<APP_PASSWORD>` 쿼리도 허용 — `<a href>`용) / DELETE. 키는 서버 생성 + 형식 검증. 할일의 `files:[{key,name,size}]`에 저장, 표에 📎N 배지. **할 일을 지우는 모든 경로는 첨부도 함께 지운다** — 앱은 `deleteTodoFiles()`(행 삭제·벌크 삭제·모달 개별/반복 전체 4곳), 서버는 `assistant.js`의 `delete_todo`가 `deleteFiles` 키를 반환하면 호출부가 `env.FILES.delete()`. 새 삭제 경로를 만들면 여기도 연결할 것(안 하면 접근 불가한 고아 객체가 쌓인다). ⚠️ `wrangler r2 bucket info`의 object_count는 반영이 지연되니, 검증은 `wrangler r2 object get`으로.
  - `assistant.js` — **AI 일정 비서**(자연어 채팅). **무료 Google Gemini**(`gemini-2.5-flash`) function-calling으로 D1 직접 조회·생성. 도구: list_schedule / find_free_slots / add_event / add_todo / complete_todo / update_todo / delete_todo / weekly_report / monthly_report / **search_todos(조건 검색)** / **count_todos(집계, group_by)** / **work_stats(처리 지표)**. `runTool`은 테스트에서 직접 호출하므로 **export 유지**(`web/tests/assistant-tools.test.mjs`). 프론트는 우하단 🤖 위젯(`setupAssistant`, 클라우드 전용), 실행 시 상태 자동 새로고침. `GEMINI_API_KEY` 필요. (유료 Claude로 바꾸려면 이 파일의 API 호출부만 교체.)
- `web/wrangler.toml` — D1 바인딩(`DB` = scheduler-db) + R2 바인딩(`FILES` = sclm-files). `web/schema.sql`, `web/seed.sql`.
- `web/static/` — **배포용 정적 자산(추적됨)**: `manifest.webmanifest`, `icon-192/512/180.png`, `sw.js`. `build.js`가 `static/* → public/`으로 복사한다. `web/public/`은 gitignore이므로 **배포에 필요한 파일은 반드시 static/에 두고 커밋**할 것.
- **PWA**: manifest + apple-touch-icon + standalone 메타로 홈 화면 설치 지원(아이폰은 설치해야 푸시 가능).
- **오프라인**(`web/static/sw.js`): 문서=네트워크 우선→캐시 셸, 정적자산=캐시 우선+백그라운드 갱신, `GET /api/data`=네트워크 우선+캐싱(오프라인이면 마지막 응답에 `X-SCLM-Offline: 1` 붙여 반환), `GET /api/health`=오프라인이면 **데이터 캐시가 있을 때만** `{cloud:true,offline:true}` 합성(없으면 그대로 실패시켜 로컬 모드로). 비-GET·나머지 `/api/*`는 개입하지 않음. 앱 쪽: `setupServiceWorker`/`setupOfflineBar`/`reconcileOffline`. 오프라인 저장 실패분은 `myscheduler:offline:pending`에 보관했다가 온라인 복귀 시 **사용자 확인 후** 업로드/폐기(자동 덮어쓰기 금지 — 다른 기기 작업이 날아감). `verify()`는 `true|false|'offline'` 3값이며 캐시 응답(`X-SCLM-Offline`)으로는 비밀번호를 통과시키지 않는다. 캐시 스키마 바꾸면 `sw.js`의 `VERSION` 올릴 것.
- 데이터 스키마(D1 documents id='main' JSON): `{ settings, projects, events, todos, channels, channelProjects, subChannels, tasks }`. 실제 업무는 `todos`. `tasks`는 미사용(칸반이 todos 기반).
- **분류 체계 = 대분류 · 중분류 · 소분류 (2026-07-29, 서로 독립된 3축)**. ⚠️ **내부 필드명은 옛 이름 그대로다** — 화면 용어만 바꾸고 데이터는 이전하지 않았다(Password 관리자=vault와 같은 방식).
  | 화면 | 뜻 | 필드 | 목록 |
  |---|---|---|---|
  | 대분류 | 업무 성격(정산·영업·CS) | `projectId` | `state.projects` (칸반·캘린더 색상 공유) |
  | 중분류 | 거래처·채널 | `channel` | `state.channels[]` |
  | 소분류 | 브랜드 등 세부 | `subChannel` | `state.subMaster[]` |
  - 🛑 **세 축을 종속시키지 말 것.** 처음엔 트리(중분류가 대분류에 소속)로 만들었다가 실데이터에서 뒤집었다 — 한 거래처에 **정산 업무도 영업 업무도** 있어서 중분류를 대분류 하나에 묶으면 표현이 불가능하다. 옛 키 `channelProjects`·`subChannels`는 `migrateTaxonomy`가 지운다.
  - `migrateTaxonomy(state)`는 할 일에 쓰인 값을 목록에 편입할 뿐 소속·연결을 만들지 않는다. **순수 함수로 유지**할 것(`web/tests/taxonomy.test.mjs`가 정규식으로 `taxoInit`+`migrateTaxonomy`를 추출해 검증).
  - ⚠️ **`state`를 새로 대입하는 모든 지점에서 `migrateTaxonomy(state)`를 부를 것** — init·클라우드 재조회(`j.changed`)·구글 동기화 후·스냅샷 복원·백업 가져오기·오프라인 반영. 하나라도 빠지면 새로 받은 데이터에 목록이 비어 화면에서 분류가 통째로 사라진다(실제로 겪은 버그).
  - 삭제는 **목록에서만** 빼고 할 일의 값은 남긴다. 목록에 없는 값을 타이핑해도 막지 않고 저장 시 자동 등록한다.
  - **분류값 운영 규칙 (2026-07-29 확정)** — 새 값을 만들거나 사용자에게 분류를 제안할 때 이 규칙을 따를 것.
    - 축마다 답하는 질문이 하나씩이다: **대분류 = 무슨 성격의 일인가 / 중분류 = 누구 일인가 / 소분류 = 무엇에 걸려 있는 일인가**.
    - **소분류는 고유명사만**(판매채널·솔루션·산출물). `업무협의`·`프로세스`·`정책`·`업체미팅` 같은 성격어는 대분류가 이미 답하므로 넣지 않는다 — 넣으면 같은 정보를 두 축에서 두 번 말하게 된다.
    - **`기타`를 쓰지 말고 비운다.** 비어 있으면 대시보드 분류 Top에 `(미지정)`으로 잡혀 "아직 안 정함"이 드러나는데, `기타`는 분류된 것처럼 위장해 그 신호를 지운다. 중분류의 `기타`도 같다. **밀리는 분류 카드(`computeStuckTaxo`)는 `기타`를 아예 제외한다**(2026-07-30) — 실데이터 replay에서 이 카드가 뜬 이틀 중 하루가 소분류 `기타`였는데 묶인 건 '폴더 정리'와 '외장하드 구매'로 서로 무관해, 경고가 다음 행동으로 이어지지 않았다. 제외 목록은 함수 안 `SKIP` 상수이며 **바깥 상수를 참조하지 말 것**(테스트가 함수만 떼어내 실행한다).
    - **3건 규칙** — 그 이름으로 3건 이상 쌓일 확신이 없으면 만들지 말고 비워 둔다. 나중에 일괄 지정(`bulkAssign`)으로 붙이는 비용이 거의 없다. ⚠️ **제목과 단어가 겹치는 것은 문제가 아니다** — `패션플러스` 4건은 전부 제목에도 그 단어가 있지만 잘 쓰인 소분류다. 문제는 **혼자 있는 값**이다(1건짜리는 제목을 한 번 더 쓴 것일 뿐이라 검색으로 충분하다).
    - **한 이름은 한 축에만.** 새 값을 만들기 전 다른 축에 같은 이름이 있는지 볼 것. 현재 `SEMP`가 세 축 전부에, `기타`·`유베이스`·`사방넷`·`공통`이 두 축에 걸쳐 있어 필터할 때 "어느 쪽 SEMP인가"를 매번 생각하게 된다.
    - 근거가 된 분포(2026-07-29, 51건): 대분류는 6종 전부, 중분류는 9종 중 8종이 쓰여 **건강**했고 문제는 소분류뿐이었다 — 35개 중 **16개가 한 번도 미사용**, 1위가 **`기타` 11건(22%)**, 쓰인 19종 중 **9종이 1건짜리**. 과거 51건은 재분류 비용이 얻는 것보다 커서 **손대지 않기로** 했고, 이 규칙은 **앞으로 들어오는 건부터** 적용한다. 그러니 오래된 데이터가 규칙과 어긋나 보여도 일괄 정리를 먼저 제안하지 말 것.
    - 정리가 필요해지면 **이름 변경이 곧 병합**이다(`subRename`/`midRename` — 이미 있는 이름으로 바꾸면 두 값이 합쳐지고 할 일도 따라온다). 삭제(`subDeleteGlobal`)는 목록에서만 빼고 할 일의 값은 남긴다.
  - 관리 화면(Categories)은 **가로 3열**이고 각 열이 자기 목록만 관리한다(`renderCatProjects`/`renderCatMids`/`renderCatSubs`). 대분류 수정은 `openProjectModal` 재사용 — 프로젝트 CRUD를 고치면 이 화면도 함께 확인할 것.
  - 분류 필드를 추가·변경하면 따라가야 하는 곳: 할 일 모달(`openTodoModal`) · 표 헤더(`shell.html`)와 셀 · 정렬키(`todoSortValue`) · 필터(`filterTodos`/`renderTodos`) · 검색 · CSV(`exportTodosCsv`) · 칸반 카드 · 시트 머리글 매핑(`SHEET_HEADER_MAP`) · `assistant.js`(도구 파라미터·`filterTodos`·`systemPrompt`).

## 시크릿 (저장소에 없음 — Cloudflare에만)
Pages `sclm`: `APP_PASSWORD`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `KAKAO_REST_API_KEY`, `KAKAO_REFRESH_TOKEN`(선택 `KAKAO_CLIENT_SECRET`), `GEMINI_API_KEY`(AI 비서, aistudio.google.com 무료 키).
Worker `sclm-push-cron`: `CRON_SECRET`(Pages와 동일 값).
- 카카오 '나에게 보내기' 매일 알림: `run-daily`가 웹푸시와 함께 카카오 메모를 발송한다(`push/_kakao.js`). `KAKAO_REFRESH_TOKEN`으로 access token을 매 호출 재발급. 설정 안 돼 있으면 카카오만 건너뜀(푸시는 정상). 토큰 발급 절차는 `web/PUSH-SETUP.md` 참고. 검증: `POST /api/push/kakao-test`(Bearer=APP_PASSWORD).
- 시크릿 등록: `npx wrangler pages secret put <NAME> --project-name sclm` (워커는 `npx wrangler secret put <NAME>`).
- 시크릿 변경 후엔 **Pages 재배포**해야 반영됨.
- **어시스턴트는 비밀번호/키를 직접 입력하지 않는다** — 값은 사용자가 등록. 공개값(client_id 등)만 예외.
- 로컬 미리보기: `web/.dev.vars`에 `APP_PASSWORD=...` (gitignore됨) 후 `npm run dev`.

## 테스트
`cd web && npm test` — `web/tests/*.test.mjs`를 모두 실행(D1/fetch 모의). **코드 수정 후 반드시 실행할 것.** 약 5초.
- **화면 동작 테스트**(`ui-*.test.mjs`)는 `_dom.mjs` 하네스가 `src/shell.html` 마크업을 linkedom 으로 띄우고 그 안에서 `src/app.js`를 통째로 실행한다. 그래서 `openTodoModal()`·`renderDashAnalytics()` 같은 **실제 함수를 실제 DOM 위에서** 부르고 버튼을 눌러 볼 수 있다.
  - ⚠️ 이게 있는 이유: 2026-07-30 분류 Top 탭이 **배포까지 나간 뒤에** 안 눌린다는 걸 알았다(공용 클래스로 핸들러를 걸어 서로 덮어씀). 계산은 멀쩡했으므로 순수 함수 테스트로는 못 잡는다. **배선·이벤트 전파·DOM 갱신은 눌러 봐야 안다.**
  - 하네스가 메우는 환경 차이: linkedom 의 `<select>.value` 는 읽기 전용이라 setter 를 붙여 준다(`patchSelectValue`). shell.html 의 `<script>` 는 전부 걷어낸다(FullCalendar 번들 30만 자).
  - 덮는 범위: `ui-todo-modal`(로그·마감이력) · `ui-todo-list`(표 렌더·필터·검색·정렬·일괄지정·CSV) · `ui-dashboard`(분류 Top 탭·추이 토글) · `ui-kanban-report`(칸반·주간/월간 리포트) · `ui-vault-list`(금고 목록·삭제).
  - CSV 는 `Blob`/`URL.createObjectURL` 이 node 에 없어서 문자열 생성을 `buildTodosCsv()` 로 분리해 두었다. 내보내기 형식을 바꾸면 이 함수만 고치면 된다.
  - 앱 내부 변수를 테스트에서 만지려면 `_dom.mjs` 의 `EXPORTS` 와 반환 객체에 접근자를 추가한다(`getState`/`setVaultKey` 등).
  - ⚠️ `run.mjs` 는 마지막에 `process.exit(0)` 한다. app.js 가 남기는 타이머(금고 자동잠금 30초 간격) 때문에 결과를 다 찍고도 node 가 안 죽는다. 이 줄을 빼면 테스트가 2분 넘게 매달린 것처럼 보인다.
- `data-vault` 금고 보존 규칙(저장 요청에 vault 없으면 기존 암호문 유지) · `sheet-sync` 비파괴/구조가드/앱항목 보존/id 안정성
- `taxonomy` 분류 트리 마이그레이션(소속 추론·기존 값 보존·빈 값 처리)
- `calendar-sync` 공용 함수·크론 인증 · `kakao` refresh_token 회전 저장·200자 분할 · `vault-crypto` 암호화 왕복·마스터 비번 변경
- `todo-log` 업무 로그·마감일 변경 이력(정규화·최신 판정·표 표시 우선순위·밀림 횟수)
  - ⚠️ `uid()` 는 **세션 카운터 + 난수** 조합이다. 난수만 쓰면 같은 밀리초에 대량 생성할 때 겹친다 — 금고 CSV 1000건 가져오기에서 실제로 충돌해 테스트가 간헐 실패했다. 카운터를 빼지 말 것.
- `vault-csv` Password 관리자 CSV 가져오기(크롬·구글·Bitwarden 머리글 매핑, BOM, 따옴표/쉼표/줄바꿈, 대량 id 고유성)
  - ⚠️ **`parseDelimitedTable`의 구분자 판별은 첫 줄(머리글)만 본다.** 파일 전체에서 `\t`를 찾으면(예전 코드) 메모나 비밀번호에 탭이 하나만 섞여도 쉼표 CSV가 통째로 TSV로 읽혀 **모든 행이 한 칸으로 뭉개진다** — 그런데도 "N건 가져왔어요"가 뜨고 비밀번호가 빈 채로 저장되는 조용한 실패였다(2026-07-30 발견). 이 함수는 구글시트 붙여넣기(TSV)와 금고 CSV가 **함께 쓰므로** 손댈 때 양쪽 테스트를 다 볼 것.
  - 금고 CSV는 **평문**이다. 내보내기 전 확인 대화상자를 띄우고 즉시 삭제를 권고하는 문구가 있으니 없애지 말 것.
- `vault-crypto`는 `src/app.js`에서 함수를 **정규식으로 추출**해 검증하므로, 해당 함수명(`vaultDeriveKey`·`vB64e`·`vB64d`·`vaultGeneratePassword`·`VAULT_ITER`)을 바꾸면 테스트도 함께 고칠 것.
- `work-stats`도 같은 방식으로 `computeWorkStats`(처리 지표)·`computeTrend`(월별 등록/완료/월말 미완료 잔량)·`computeDataIssues`(지표를 왜곡하는 입력 누락 탐지)를 추출해 검증한다. 세 함수는 **순수 함수로 유지**할 것(state 참조 금지).
  - 데이터 점검 카드는 결함이 있을 때만 뜨며, 항목 클릭 시 `openDataIssueModal`이 대상 목록을 보여준다. 시트 유입 건은 앱에서 고쳐도 다음 동기화에 덮이므로 **"시트에서 고치라"는 안내를 반드시 유지**할 것.
  - 추이 차트는 막대(`.an-cols`)와 잔량선 SVG(`.an-line`)가 **같은 박스를 덮어야** 눈금이 맞는다. SVG는 대체요소라 inset만으로는 고유비율로 그려지므로 `width/height`를 명시해 둠 — 건드리면 정렬이 깨진다. 잔량선은 막대와 **척도가 다르다**(범례·가이드에 명시).

### 화면 동작 테스트 하네스 (`web/tests/_dom.mjs`)
`src/shell.html`을 linkedom으로 띄우고 그 안에서 `src/app.js`를 통째로 실행한다 → `renderTodos()`·`openTodoModal()` 같은 **실제 함수를 실제 DOM 위에서** 호출한다. 순수 함수 테스트로 못 잡는 것(버튼 배선·이벤트 전파·DOM 갱신)이 여기 몫이다. `ui-*.test.mjs` 6개가 이걸 쓴다.
- 테스트에서 부르려면 **`EXPORTS` 배열에 함수 이름을 추가**해야 한다. 없으면 `undefined`라 조용히 통과하는 게 아니라 호출에서 죽는다.
- **FullCalendar는 가짜다**(라이브러리가 아니라 우리 배선을 검증). `bootApp()`이 돌려주는 `calendars[]`로 앱이 넘긴 옵션을 보고 콜백을 발사한다: `cal.opts` / `cal.events()`(매핑 결과) / `cal.fire('dateClick'|'eventClick', arg)` / `cal.renders`·`cal.refetches`. 검증: `ui-calendar.test.mjs`.
  - ⚠️ 종일 일정의 `end`는 FullCalendar 규칙상 **포함하지 않는 경계**라 여러 날이면 마지막날 **+1일**을 넘겨야 한다. 이걸 빼면 마지막 날이 화면에서 사라진다(테스트로 고정해 둠).
- 하네스로 **못 잡는 것**: 실제 브라우저 렌더링(CSS·레이아웃·반응형), FullCalendar 내부 동작, 서비스워커/오프라인, 실제 네트워크 왕복(fetch는 항상 404). 이건 Browser 도구로 눈으로 확인할 몫이다.
- `<select>.value`는 linkedom에서 읽기 전용이라 setter를 덧붙여 브라우저와 같게 맞춰 뒀다 — **테스트 환경의 한계를 메우는 것이지 앱 동작을 바꾸는 게 아니다.**

## 로컬 검증 흐름
빌드(`node build.js`) → 정적 서버(예: `python -m http.server`)로 `web/public` 서빙 → 브라우저로 확인. `/api/health`가 없으면 로컬(비클라우드) 모드로 뜬다. 함수/D1까지 보려면 `npm run dev`(wrangler pages dev).
- 클라우드 경로 검증 팁: `run-daily`를 `X-Cron-Secret`으로 직접 호출하면 D1+시크릿+발송을 한 번에 확인.

## 기기 간 작업
- 작업 전 `git pull`, 작업 후 `git add -A && git commit && git push`. **한 번에 한 기기에서만** 편집 권장.
- 새 기기 세팅: Node+Git 설치 → `git clone` → `cd web && npm install` → `npx wrangler login` → `npm run deploy`.

## 이어서 개발할 때 (세션 시작 규약)
새 세션이 열리면 사용자가 구조를 다시 설명하지 않는다. 이 문서가 곧 인수인계서다.

**요청받으면 기본으로 이렇게 움직인다** — 사용자가 매번 지시하지 않아도 된다.
1. **`git pull` 먼저.** 다른 기기에서 작업했을 수 있다. 받은 커밋이 있으면 무엇이 바뀌었는지 한 줄로 요약해 알린다.
2. 코드를 고쳤으면 **`cd web && npm test`** (현재 622개). 실패를 남긴 채 다음으로 넘어가지 않는다.
3. 화면에 보이는 변경이면 **로컬에서 눈으로 확인**한다(로컬 검증 흐름 참고). "될 것이다"로 끝내지 말 것.
4. 배포·푸시는 **사용자가 원할 때만**. 다만 요청받았으면 `npm run deploy` → `git push`까지 끝내고 배포 URL·커밋 해시를 알린다.
5. 순수 계산 로직을 새로 만들면 **테스트를 함께** 넣는다(기존 방식: 소스에서 정규식으로 함수를 떼어내 검증).
6. 구조·API·화면을 바꿨으면 **`docs/TECH-SPEC.md`·`docs/USER-GUIDE.md`·이 문서**를 같이 갱신한다.

**하지 말 것**
- 시크릿·비밀번호·API 키를 직접 입력하거나 파일에 쓰지 않는다. 등록은 사용자가 한다(공개값은 예외).
- 실데이터를 파괴적으로 바꾸기 전에 **백업 없이 진행하지 않는다**(스냅샷 또는 `main` 문서 덤프).
- D1 조회 시 `google`·`kakao` 문서는 **refresh_token이 들어 있으니 SELECT 하지 않는다**. 필요한 필드만 `json_extract`로 꺼낼 것.
- 관측하지 않은 것을 단정하지 않는다(크론 미발사 오진 사례 참고).

**모르면 물어볼 것** — 원천 데이터를 바꾸는 결정(스키마 전환, 연동 종료, 일괄 수정)은 되돌리기 어렵다. 방향이 갈리면 진행 전에 확인한다.

## 커밋 규칙
- 커밋 메시지 끝에: `Co-Authored-By: Claude Opus <버전> <noreply@anthropic.com>` — **작업한 모델의 실제 버전**을 적는다(2026-07-29 기준 `Claude Opus 5`). 옛 버전 이름을 관성으로 복사하지 말 것.
- 실제 업무 데이터 백업(`Ray-Work-Flow-백업.json`)·시크릿은 커밋 금지(gitignore/placeholder 처리됨).
