# 구글 캘린더 연동 설정 (SCLM)

앱이 구글 캘린더와 연동하려면 **본인 구글 클라우드에서 OAuth 앱**을 한 번 만들어야 합니다.

## 필요한 값 (앱에 고정)
- 승인된 JavaScript 원본: `https://raymond-scheduler.pages.dev`
- 승인된 리디렉션 URI: `https://raymond-scheduler.pages.dev/api/google/callback`
- 스코프: `https://www.googleapis.com/auth/calendar`

## 단계
1. https://console.cloud.google.com → 프로젝트 생성/선택
2. **API 및 서비스 → 라이브러리 → "Google Calendar API" → 사용 설정**
3. **OAuth 동의 화면**: User type = 외부(External) → 앱 이름(SCLM), 지원 이메일, 개발자 이메일 입력 → 저장
   - **중요:** 설정 후 **"앱 게시(PUBLISH APP)" → 프로덕션**으로 전환하세요. (테스트 모드는 리프레시 토큰이 7일마다 만료됩니다.)
   - 프로덕션이라도 미인증 앱이라 로그인 시 "확인되지 않은 앱" 경고가 뜨는데, 본인 앱이므로 **고급 → 이동**으로 진행하면 됩니다.
4. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 JavaScript 원본 / 리디렉션 URI: 위 값 입력
   - 만들기 → **클라이언트 ID / 클라이언트 보안 비밀** 복사
5. Cloudflare 시크릿 등록 (web/ 폴더에서):
   ```
   npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name raymond-scheduler
   npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name raymond-scheduler
   ```
6. 앱 새로고침 → 설정 → "구글 캘린더 연동" → **구글 캘린더 연결** → 로그인/권한 허용 → "연결됨"

연결이 확인되면 2단계(양방향 동기화)를 붙입니다.
