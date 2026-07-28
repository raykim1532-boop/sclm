# SCLM 기술 스펙 & 정보구조(IA)

> 개인 업무 일정·할 일 통합 관리 시스템 — 기술 문서
> 라이브: https://sclm.pages.dev · 저장소: github.com/raykim1532-boop/sclm
> 최종 갱신: 2026-07-28

---

## 1. 개요

| 항목 | 내용 |
|---|---|
| 목적 | 구글 시트로 관리하던 업무 리스트를 앱·알림·캘린더로 자동 연결하는 개인 업무 비서 |
| 사용자 모델 | **단일 사용자** (앱 비밀번호 1개, 데이터 문서 1개) |
| 프런트엔드 | 단일 HTML 파일 (`MySchedulerApp.html`, ~5,000줄) — CSS·JS·FullCalendar 인라인 |
| 백엔드 | Cloudflare Pages Functions (파일 기반 라우팅, API 16개) |
| 저장소 | Cloudflare D1(SQLite) + R2(파일) |
| 자동화 | 별도 Cron Worker(`sclm-push-cron`) — 매일 08:00 KST |
| 설계 원칙 | ① 시트에는 쓰지 않는다(읽기 전용) ② 기존 업무 방식(시트)을 바꾸지 않는다 ③ 데이터 유실 방지 우선 |

---

## 2. 시스템 구성

```
사용자 (PC / 휴대폰·PWA)
   │  HTTPS + Bearer(APP_PASSWORD)
   ▼
┌───────────────── Cloudflare ─────────────────┐
│  Pages "sclm"                                 │
│   ├─ public/index.html   ← build.js가 복사    │
│   ├─ public/sw.js        (오프라인/푸시 SW)    │
│   └─ functions/api/**    (Pages Functions)    │
│         │                                     │
│   D1 "scheduler-db" ──── documents 테이블      │
│   R2 "sclm-files"   ──── 할 일 첨부파일        │
│                                               │
│  Worker "sclm-push-cron"                      │
│   └─ cron 0 23 * * * (UTC) = 08:00 KST        │
│       ① POST /api/push/run-daily              │
│       ② POST /api/google/sync (최대 3회)      │
└───────────────────────────────────────────────┘
   │                │               │
   ▼                ▼               ▼
구글 시트(읽기)   구글 캘린더(양방향)  카카오톡 · 웹푸시
                                  Gemini(AI 비서)
```

- **크론이 두 요청을 나눠 호출하는 이유**: Cloudflare 서브리퀘스트 한도(요청당 50)를 각각 따로 쓰기 위함. 한 요청에 합치지 말 것.
- 클라이언트 주기 폴링은 없음(앱 열 때 1회 + 수동 버튼). 정기 갱신은 크론이 담당.

---

## 3. 정보구조 (IA)

### 3.1 화면 구조

```
SCLM (로그인 게이트: 앱 비밀번호)
├─ 🏠 Dashboard        오늘/지연/진행 현황 요약, 분석 위젯
├─ 📆 Calendar         FullCalendar 월·주 뷰 (일정 + 할 일 마감일)
├─ ✅ To-do List       시트와 동일한 표 뷰 (필터·정렬·파일첨부 📎)
├─ 📁 Projects         칸반 보드 (대분류=프로젝트 단위)
├─ 🏷️ Channels         세부채널(거래처) 관리 — 이름변경 시 할 일 일괄 반영
├─ 🔐 Accounts         계정 금고 (마스터 비밀번호 암호화)
│    ├─ 금고 생성 / 잠금 해제 / 자동 잠금(기본 10분)
│    ├─ 계정 목록 (검색 · 아이디/비번 복사 · 사이트 열기)
│    └─ 계정 추가/편집 (비밀번호 생성기 🎲) · 마스터 비번 변경
├─ ⚙️ Settings
│    ├─ 테마 (라이트/다크 · 강조색)
│    ├─ 구글 캘린더 연동 (연결 · 지금 동기화 · 자동 동기화)
│    ├─ 구글 시트 동기화 (URL 저장 · 지금 동기화 · 자동 동기화)
│    ├─ 푸시 알림 (켜기/끄기 · 테스트 발송)
│    ├─ 백업 & 복구 (스냅샷 목록 · 지금 백업 · 복원)
│    └─ 데이터 (내보내기 / 불러오기)
├─ 🤖 AI 비서          우하단 플로팅 위젯 (자연어 채팅)
└─ 사이드바            내 프로젝트 목록 (빠른 필터)
```

### 3.2 데이터 IA — D1 `documents` 테이블

단일 테이블에 문서(JSON)를 행으로 보관: `documents(id TEXT PK, data TEXT, updated_at INTEGER)`

| id | 내용 |
|---|---|
| `main` | 앱 전체 상태: `{ settings, projects, events, todos, channels, tasks, vault }` |
| `google` | 구글 OAuth: `refresh_token`, `calendarId`, `sheet{ spreadsheetId, gid, title, lastSync }` |
| `kakao` | 카카오: 회전된 `refresh_token`, `lastOkAt` / `lastError` |
| `snap_*` | 스냅샷 백업 (최근 20개, `snapshots` 테이블) |

부가 테이블: `push_subs`(웹푸시 구독), `snapshots`(백업).

### 3.3 `main` 문서 스키마 (핵심 필드)

```jsonc
{
  "settings": { "theme": "light", "accent": "#1a73e8", "googleLastSync": 0 },
  "projects": [{ "id": "cat-1", "name": "정산", "color": "#d50000" }],
  "channels": ["마리오아울렛", "..."],
  "events":   [{ "id", "title", "start", "end", "allDay", "startTime", "endTime",
                 "projectId", "notes", "googleId", "gSig" }],
  "todos":    [{ "id",              // 시트 유래: "sh_"+해시(등록일+업무내용) / 앱 생성: uid()
                 "no", "registeredDate", "projectId", "channel", "priority",
                 "text", "assignee", "dueDate", "status", "needsCheck",
                 "completedDate", "progress", "remarks", "done",
                 "googleId", "gSig",  // 캘린더 연동 키
                 "files": [{ "key", "name", "size" }] }],
  "tasks":    [],                    // 미사용(칸반은 todos 기반)
  "vault":    { "v": 1, "kdf": "PBKDF2", "iterations": 210000,
                "salt": "b64", "iv": "b64", "ct": "b64" }   // 암호문만 저장
}
```

**id 규칙이 곧 소유권**: `sh_` 접두 = 시트가 원천(동기화 때 교체됨), 그 외 = 앱이 원천(동기화에도 보존됨).

---

## 4. API 명세

모든 엔드포인트는 `Authorization: Bearer <APP_PASSWORD>` 필요. 예외는 표에 명시.

### 4.1 코어

| 메서드·경로 | 설명 | 비고 |
|---|---|---|
| `GET /api/health` | 클라우드 모드 감지 핑 | **인증 없음** |
| `GET /api/data` | `main` 문서 조회 | |
| `PUT /api/data` | `main` 문서 저장(통짜 덮어쓰기) | **vault 보존 규칙**: 본문에 `vault` 키가 없으면 기존 암호문 유지, `vault:null`만 명시 삭제 |
| `GET /api/snapshots` | 백업 목록(데이터 제외) | |
| `POST /api/snapshots` | 생성(`{reason, force}`) / 복원(`{action:'restore', id}`) | force 아니면 하루 1회, 복원 전 자동 백업, 20개 보관 |

### 4.2 구글

| 메서드·경로 | 설명 | 비고 |
|---|---|---|
| `GET /api/google/auth` | 동의 화면 URL 발급 | 스코프: `calendar` + `spreadsheets` |
| `GET /api/google/callback` | OAuth 리다이렉트 수신 | **인증 없음**, `state` 검증 |
| `GET /api/google/status` | 연결 상태 / `DELETE` 연결 해제 | |
| `GET /api/google/token` | 단기 access_token 발급(프런트용) | |
| `POST /api/google/sync` | **캘린더 양방향 동기화** | `X-Cron-Secret`도 허용. 전용 "SCLM" 캘린더만 사용, 쓰기 45회 상한(`truncated` 반환 시 이어서 호출) |
| `GET/POST /api/google/sheet-config` | 대상 시트 조회/저장(`{url}`) | URL에서 spreadsheetId·gid 파싱 |
| `POST /api/google/sheet-sync` | **시트 → 앱 읽기 전용 가져오기** | 아래 4.4 참조 |

### 4.3 알림·파일·AI

| 메서드·경로 | 설명 | 비고 |
|---|---|---|
| `POST/DELETE /api/push/subscribe` | 웹푸시 구독 등록/해제 | |
| `POST /api/push/test` | 푸시 테스트 발송 | |
| `POST /api/push/kakao-test` | 카카오 즉시 테스트 | |
| `POST /api/push/run-daily` | **데일리 파이프라인**: 시트 동기화 → 요약 계산 → 웹푸시+카카오 발송 | `X-Cron-Secret`도 허용. 지연·오늘·임박 0건이면 발송 생략. 카카오 실패 시 웹푸시로 경고 |
| `POST /api/files/<key>` | 첨부 업로드(multipart, 25MB) | R2 저장, 키는 서버 생성 |
| `GET /api/files/<key>` | 다운로드 | `?t=<APP_PASSWORD>` 쿼리 인증도 허용(`<a href>`용) |
| `DELETE /api/files/<key>` | 삭제 | |
| `POST /api/assistant` | AI 비서 채팅 | Gemini 2.5 Flash function-calling. 도구: `list_schedule` `find_free_slots` `add_event` `add_todo` `update_todo` `complete_todo` `delete_todo` `weekly_report` |

### 4.4 시트 동기화 알고리즘 (`sheet-sync.js`)

1. gid로 탭 제목 확인 → 탭 전체 값 읽기 (`FORMATTED_VALUE`)
2. **구조 가드**: 상위 6행 내에서 5열=`대분류`, 10열=`업무내용` 헤더 행 탐지. 실패 시 `422 sheet_structure_unrecognized` — **앱 데이터 불변**
3. 고정 열 위치 파싱(0-index): `0 No · 1 등록일 · 2 마감(예정)일 · 3 완료일 · 4 담당자 · 5 대분류 · 6 세부채널 · 7 우선순위 · 8 진행상태 · 9 점검필요 · 10 업무내용 · 11 진행사항 · 13 비고` (14·15열 D-Day·소요일수는 수식 → 무시)
4. id = `sh_` + 해시(등록일+업무내용) — 시트 행 재정렬에도 안정. 기존 todo의 `googleId`/`gSig` 보존
5. `todos` = 파싱 결과 + **앱 소유 항목(`sh_` 아닌 id) 전부 보존**
6. `대분류` 이름이 앱에 없으면 프로젝트 자동 생성
7. **시트에는 어떤 쓰기 호출도 하지 않음** (테스트로 강제: 쓰기 0건 검증)

### 4.5 캘린더 동기화 알고리즘 (`sync.js`)

- 전용 "SCLM" 캘린더 확보(없으면 생성) → −60d ~ +365d 이벤트 전량 조회
- `extendedProperties.private.sclmId`로 항목 매칭, 서명(`gSig`) 비교로 **변경분만** PUT/POST
- 양방향 삭제 전파(구글에서 지우면 앱에서도, 앱에서 지우면 구글에서도)
- 구글에서 새로 만든(외부) 일정은 앱으로 가져옴(`source:'google'`)
- 쓰기 45회 상한 → `truncated:true`면 호출자가 이어서 재호출(크론은 최대 3회)

---

## 5. 자동화 파이프라인 (매일 아침)

**주 스케줄러: GitHub Actions** (`.github/workflows/daily-alarm.yml`, 07:57·08:12 KST) — 이 Cloudflare 계정의 크론이 이벤트를 발사하지 않는 문제(2026-07-28 tail로 확정)로 이관. Cloudflare Worker(08:00·08:10)는 백업으로 유지하며, `run-daily`의 **하루 1회 가드**(documents id='daily'의 lastSentDay)가 중복 발송을 차단한다. 수동(Bearer) 호출은 가드와 무관하게 항상 발송된다.

```
GitHub Actions / sclm-push-cron (cron, UTC)
 ├─ ① POST /api/push/run-daily        (X-Cron-Secret)
 │     1. runSheetSync(env)            시트 → 앱 최신화
 │     2. computeSummary               지연 / 오늘 마감 / 임박(3일 내) 분류
 │     3. (0건이면 여기서 종료)
 │     4. sendToAll                    웹푸시 — 항목명 + D-n 나열
 │     5. sendKakaoMessages            카카오 '나에게 보내기'
 │        · 200자 초과 시 자동 분할, 제목에 (k/N)
 │        · 실패 시 웹푸시로 "⚠️ 카카오 알림 실패" 경고
 └─ ② POST /api/google/sync           캘린더 동기화 (truncated 시 ≤3회)
```

- 카카오 토큰: `documents id='kakao'`의 회전 토큰 우선, 없으면 시크릿 `KAKAO_REFRESH_TOKEN`으로 부트스트랩. 갱신 응답의 새 refresh_token은 즉시 D1 저장(60일 만료 대비).

---

## 6. 보안

| 계층 | 내용 |
|---|---|
| 페이지 접근 | 로그인 게이트(앱 비밀번호). 토큰은 localStorage 보관, `verify()`로 검증 |
| API 접근 | 전 엔드포인트 Bearer 검증(상수시간 비교). 크론 경로만 `X-Cron-Secret` 병행 |
| 금고(vault) | 브라우저 내 **클라이언트 암호화**: PBKDF2(SHA-256, 210,000회) → AES-GCM-256. 서버·저장소에는 암호문만. 마스터 비밀번호 미저장 → **분실 시 복구 불가** — 잠금 화면 [금고 초기화]로 `vault:null` 삭제 후 재생성(계정 재입력 필요). 유휴 자동 잠금(5/10/30분) |
| OAuth | 구글: refresh_token은 D1에만, 콜백 `state` 검증. 카카오: 회전 토큰 D1 보관 |
| 시크릿 | 저장소에 없음 — Cloudflare 시크릿만. `.dev.vars`·실데이터 백업은 gitignore |
| XSS | 렌더 시 `escapeHtml`(따옴표 포함) 일괄 적용 |

**시크릿 목록** — Pages `sclm`: `APP_PASSWORD` `VAPID_PRIVATE_KEY` `CRON_SECRET` `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `KAKAO_REST_API_KEY` `KAKAO_REFRESH_TOKEN` (`KAKAO_CLIENT_SECRET` 선택) `GEMINI_API_KEY` / Worker `sclm-push-cron`: `CRON_SECRET`(동일 값)

---

## 7. 오프라인 / PWA

- `manifest.webmanifest` + 아이콘 → 홈 화면 설치(standalone). 아이폰은 설치해야 푸시 수신 가능
- 서비스워커(`web/static/sw.js`): 문서=네트워크 우선→캐시, 정적=캐시 우선+백그라운드 갱신, `GET /api/data`=네트워크 우선+캐싱(오프라인 시 `X-SCLM-Offline:1`)
- 오프라인 저장 실패분은 로컬 보관 후 온라인 복귀 시 **사용자 확인 후** 업로드(자동 덮어쓰기 금지)

---

## 8. 저장소 구조 · 빌드 · 배포

```
sclm/
├─ MySchedulerApp.html        ★ 앱 소스(유일한 편집 대상)
├─ CLAUDE.md · README.md
├─ docs/                      본 문서 · 사용자 가이드
└─ web/
   ├─ build.js                MySchedulerApp.html + static/* → public/
   ├─ wrangler.toml           D1·R2 바인딩
   ├─ schema.sql · seed.sql
   ├─ static/                 manifest · 아이콘 · sw.js (추적됨)
   ├─ public/                 빌드 산출물 (gitignore — 직접 수정 금지)
   ├─ functions/api/**        Pages Functions
   ├─ push-cron/              별도 Cron Worker
   └─ tests/                  자동 테스트 (npm test, 63개)
```

| 작업 | 명령 |
|---|---|
| 테스트 | `cd web && npm test` (외부 의존성 없음 — D1/fetch 모의) |
| 로컬 개발 | `npm run db:init:local`(최초 1회) → `npm run dev` (wrangler pages dev, D1 로컬) |
| 앱 배포 | `cd web && npm run deploy` (**배포 전 `git pull` 필수** — 병렬 기기 작업 덮어쓰기 방지) |
| 크론 배포 | `cd web/push-cron && npx wrangler deploy` |
| 시크릿 | `npx wrangler pages secret put <NAME> --project-name sclm` → **재배포해야 반영** |

테스트 커버리지: 금고 보존 규칙 / 시트 비파괴·구조가드·앱항목 보존·id 안정성 / 캘린더 공용함수·크론 인증 / 카카오 토큰 회전·200자 분할 / 금고 암호화 왕복·마스터 비번 변경(HTML에서 실제 함수 추출 검증).

---

## 9. 이력에서 배운 설계 결정

| 결정 | 배경 |
|---|---|
| 시트 **읽기 전용** | 초기 양방향(full-rewrite)이 실사용 시트의 제목행·수식·다른 탭을 훼손 → 버전 기록으로 복구 후 재설계 |
| 구조 가드 | 시트 형식이 다르면 "이상하게 가져오기"보다 "안 가져오기"가 안전 |
| 서버 vault 보존 | PUT이 통짜 덮어쓰기라, 금고 생성 전 열어둔 탭이 저장하면 암호문 소실(복구 불가) → 서버측 머지로 차단 |
| 앱 소유 todo 보존 | 시트 기준 통짜 교체가 앱에서 추가한 실제 업무를 삭제 → id 접두사로 소유권 구분 |
| 카카오 토큰 D1 보관 | refresh_token 60일 만료 — 회전분을 저장하지 않으면 알림이 조용히 끊김 |
| 크론 요청 분리 | 서브리퀘스트 50 한도를 파이프라인별로 따로 사용 |
