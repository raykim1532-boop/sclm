# SCLM 푸시 알림 설정 가이드

매일 아침 8시(KST) "오늘 마감·지연" 요약을 브라우저 푸시로 받는 기능.
안드로이드 크롬 / PC 크롬 지원. (아이폰은 홈 화면에 앱 추가 필요)

구성:
- `functions/api/push/*` — 구독 저장(subscribe), 테스트 발송(test), 일일 발송(run-daily)
- `public/sw.js` — 서비스 워커(푸시 수신/클릭)
- `push-cron/` — 매일 08:00 KST에 run-daily를 호출하는 Cron 워커
- VAPID 공개키는 코드에 내장, 개인키/크론시크릿은 Cloudflare Secret

> ⚠️ 이 문서에는 실제 시크릿 값을 적지 말 것(저장소에 올라감). 값은 별도 안전한 곳에 보관.
> VAPID 키쌍이 필요하면 재발급: `web/push-cron` 등에서 WebCrypto로 P-256 키 생성 → 공개키는 `_webpush.js`/프론트 `VAPID_PUBLIC_KEY`에, 개인키는 아래 시크릿으로.

---

## 1단계 — 푸시 켜서 테스트

### (1) VAPID 개인키 시크릿 등록  ※ `web` 폴더에서 실행
```
npx wrangler pages secret put VAPID_PRIVATE_KEY --project-name sclm
```
프롬프트가 뜨면 VAPID 개인키(base64(JWK) 형태) 값을 붙여넣고 Enter.

### (2) Pages 재배포 → 시크릿 반영 (`npm run deploy`)

### (3) 앱에서 켜기
설정 → 푸시 알림 → **알림 켜기** (권한 허용) → **테스트 발송**
→ 폰/PC에 알림이 뜨면 성공.

---

## 2단계 — 매일 아침 8시 자동 발송

### (4) workers.dev 서브도메인 1회 생성 (대시보드)
Cloudflare 대시보드 → 좌측 **컴퓨트(Workers & Pages)** 최초 진입 시 자동 생성.

### (5) 크론 시크릿 등록 (두 곳에 같은 값)
`web` 폴더:
```
npx wrangler pages secret put CRON_SECRET --project-name sclm
```
`web/push-cron` 폴더:
```
npx wrangler secret put CRON_SECRET
```
두 곳 모두 프롬프트에 **동일한** 크론 시크릿(임의의 랜덤 문자열) 붙여넣기.

### (6) Cron 워커 배포
```
cd web/push-cron && npx wrangler deploy
```

발송 시각을 바꾸려면 `push-cron/wrangler.toml`의 `crons = ["0 23 * * *"]`
(UTC 기준, 23:00 UTC = 08:00 KST) 수정 후 재배포.

## 검증
`run-daily`를 크론 시크릿으로 직접 호출하면 D1+시크릿+발송을 한 번에 확인:
```
curl -X POST https://sclm.pages.dev/api/push/run-daily -H "X-Cron-Secret: <크론시크릿>"
```

---

## 3단계 — 카카오톡 '나에게 보내기' 알림 (선택)

매일 아침 8시(2단계 크론과 동일 시각) 웹푸시와 **함께** 카카오톡 메모(나에게 보내기)로도
"지연·오늘·임박" 할 일 요약을 받는다. 코드는 이미 반영됨(`push/_kakao.js`, `run-daily`에서 호출).
아래는 **1회성 토큰 발급**만 하면 된다. 심사 불필요(자기 자신에게 보내는 memo API).

> ⚠️ REST API 키·refresh token은 시크릿. 이 문서/저장소에 실제 값 적지 말 것.

### (7) 카카오 디벨로퍼스 앱 생성
1. https://developers.kakao.com → **내 애플리케이션 → 애플리케이션 추가**
2. **앱 설정 → 앱 키**: `REST API 키` 값을 복사 → 이게 `KAKAO_REST_API_KEY`
3. **제품 설정 → 카카오 로그인**: 활성화 **ON**
4. 같은 화면 **Redirect URI** 등록: `https://sclm.pages.dev` (정확히 이 값으로)
5. **카카오 로그인 → 동의항목**: "카카오톡 메시지 전송(`talk_message`)" 사용 설정
6. (선택) **앱 설정 → 보안**에서 Client Secret 발급 시 → `KAKAO_CLIENT_SECRET`

### (8) refresh token 발급 (1회)
브라우저에서 아래 URL 열기(`<REST_API_KEY>` 치환):
```
https://kauth.kakao.com/oauth/authorize?client_id=<REST_API_KEY>&redirect_uri=https://sclm.pages.dev&response_type=code&scope=talk_message
```
→ 동의하면 `https://sclm.pages.dev/?code=XXXX` 로 이동. 주소창의 **`code` 값 복사**(10분 내 사용).

이어서 토큰 교환(PowerShell, `<REST_API_KEY>`·`<CODE>` 치환):
```powershell
$body = @{ grant_type='authorization_code'; client_id='<REST_API_KEY>'; redirect_uri='https://sclm.pages.dev'; code='<CODE>' }
# Client Secret 발급했다면: $body.client_secret = '<CLIENT_SECRET>'
Invoke-RestMethod -Uri 'https://kauth.kakao.com/oauth/token' -Method Post -Body $body -ContentType 'application/x-www-form-urlencoded'
```
응답의 **`refresh_token` 값**이 `KAKAO_REFRESH_TOKEN`. (access_token은 6시간짜리라 저장 불필요 — 서버가 매번 재발급.)
refresh token은 약 2개월 유효하며, 매일 크론이 사용하면 자동 갱신되어 사실상 계속 유지된다.

### (9) 시크릿 등록 (`web` 폴더)
```
npx wrangler pages secret put KAKAO_REST_API_KEY --project-name sclm
npx wrangler pages secret put KAKAO_REFRESH_TOKEN --project-name sclm
# (선택) npx wrangler pages secret put KAKAO_CLIENT_SECRET --project-name sclm
```

### (10) Pages 재배포 → 시크릿 반영
```
cd web && npm run deploy
```

### 검증 (즉시 카카오 테스트 발송)
```
curl -X POST https://sclm.pages.dev/api/push/kakao-test -H "Authorization: Bearer <APP_PASSWORD>"
```
→ 카카오톡 '나에게 보내기' 방에 요약 메시지가 오면 성공. 이후 매일 아침 크론이 자동 발송한다.
(설정 전이거나 토큰이 틀리면 `run-daily` 응답의 `kakao` 필드에 사유가 찍히고, 웹푸시는 정상 동작.)
