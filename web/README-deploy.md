# 나의 스케줄러 — 웹 배포 가이드 (Cloudflare, 무료)

여러 기기에서 **같은 데이터**를 보는 웹 버전으로 올리는 방법. 전부 Cloudflare 무료 티어로 가능하고, 처음엔 `https://raymond-scheduler.pages.dev` 같은 무료 주소로 시작한 뒤 나중에 도메인을 붙이면 된다.

```
구성:  브라우저(정적 HTML) ──HTTPS──> Cloudflare Pages
                                        ├─ Functions(/api)  ← 로그인·저장 API
                                        └─ D1(SQLite)       ← 데이터 1행에 통째로 저장
인증:  비밀번호 1개(APP_PASSWORD). 맞으면 그 값을 토큰으로 써서 /api 호출.
```

> ⚠️ 실제 업무 데이터다. 비밀번호는 **길고 유추 어렵게**. 아는 사람은 다 볼 수 있으니 절대 공유 금지.

---

## 0. 사전 준비 (한 번만)
1. Cloudflare 무료 계정 가입 — https://dash.cloudflare.com/sign-up
2. 이 폴더(`web/`)에서 의존성 설치:
   ```bash
   cd web
   npm install
   ```
3. Cloudflare 로그인 (브라우저 창이 열림):
   ```bash
   npx wrangler login
   ```

## 1. D1 데이터베이스 만들기
```bash
npx wrangler d1 create scheduler-db
```
출력에 나오는 `database_id = "xxxxxxxx-...."` 값을 복사해 **`wrangler.toml`의 `database_id`** 자리에 붙여넣는다(`REPLACE_WITH_YOUR_D1_DATABASE_ID` 교체).

그다음 원격 DB에 테이블 생성:
```bash
npm run db:init          # = wrangler d1 execute scheduler-db --remote --file=schema.sql
```

## 2. 첫 배포 (프로젝트 생성됨)
```bash
npm run deploy           # = node build.js && wrangler pages deploy public
```
- 처음이면 프로젝트 이름을 물어볼 수 있다 → `raymond-scheduler` 로.
- 끝나면 `https://raymond-scheduler.pages.dev` 주소가 나온다.

## 3. 비밀번호 설정
```bash
npx wrangler pages secret put APP_PASSWORD --project-name raymond-scheduler
```
프롬프트에 원하는 비밀번호를 입력. (대시보드에서도 가능: Pages → 프로젝트 → Settings → Environment variables & secrets 에 `APP_PASSWORD` 추가)

## 4. D1 바인딩 확인 (대시보드)
Cloudflare 대시보드 → **Workers & Pages → raymond-scheduler → Settings → Functions → D1 database bindings** 에서
변수명 `DB` ↔ `scheduler-db` 가 연결돼 있는지 확인. (없으면 추가 후 재배포)

> `wrangler.toml`의 `[[d1_databases]]` 로도 바인딩되지만, Pages는 대시보드 바인딩이 우선인 경우가 있어 한 번 확인하는 게 안전하다.

## 5. 완료 — 접속
- 아무 기기에서나 `https://raymond-scheduler.pages.dev` 접속 → 비밀번호 입력 → 사용.
- PC에서 추가/수정 → 핸드폰에서 새로고침하면 그대로 반영. (같은 데이터)

---

## 코드 수정 후 재배포
앱은 상위 폴더의 **`../MySchedulerApp.html` 한 파일**이 원본이다. 수정 후:
```bash
npm run deploy
```
`build.js`가 `../MySchedulerApp.html` → `public/index.html` 로 복사한 뒤 배포한다.

## 로컬에서 웹 버전 테스트
```bash
npm run db:init:local    # 로컬 D1에 테이블(최초 1회)
npm run dev              # http://localhost:8788 (또는 콘솔에 표시된 포트)
```
로컬 비밀번호는 `web/.dev.vars` 의 `APP_PASSWORD`(기본 `test1234`). `.dev.vars`는 git에 올라가지 않는다.

## 커스텀 도메인 붙이기 (나중에)
1. 도메인을 Cloudflare에 등록(네임서버 이전) — 무료.
2. Pages → 프로젝트 → **Custom domains → Set up a domain** 에서 `scheduler.내도메인.com` 추가.
3. 자동으로 DNS·HTTPS 인증서가 설정된다.

## 보안 강화(선택)
- 비밀번호 대신 **Cloudflare Access(Zero Trust)** 로 구글 로그인 게이트를 씌우면 더 안전하다. 무료 플랜에서 사용자 50명까지.
- 여러 사람이 계정별로 나눠 쓰려면 사용자/권한 모델과 로그인 방식을 추가해야 한다(현재는 단일 비밀번호).

## 데이터 백업/복구
- 앱 **설정 → 데이터 → 백업 파일로 내보내기** 로 언제든 JSON 백업.
- D1 직접 백업: `npx wrangler d1 export scheduler-db --remote --output=backup.sql`
