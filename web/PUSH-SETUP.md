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
