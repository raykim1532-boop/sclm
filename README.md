# 나의 스케줄러 (MySchedulerApp)

단일 HTML 파일로 동작하는 개인 일정관리 앱. 설치 없이 `MySchedulerApp.html`을 브라우저로 열면 바로 실행된다.

> 📚 **문서**: [기술 스펙 & IA](docs/TECH-SPEC.md) · [사용자 가이드](docs/USER-GUIDE.md) · [구글 연동 설정](web/GOOGLE-SETUP.md) · [알림 설정](web/PUSH-SETUP.md)

## 기능
- **캘린더** — FullCalendar(내장). 일정(events) + 할일(todos, 마감일) + 프로젝트 태스크(tasks, 마감일)를 한 화면에 표시
- **할 일** — 투두 리스트 (프로젝트/상태 필터)
- **프로젝트** — 칸반 보드 (할일 / 진행중 / 완료)
- **설정** — 테마, 강조색, 클라우드 폴더 동기화(File System Access API), 백업 내보내기/불러오기

## 저장소
- 기본: 브라우저 `localStorage` (`myscheduler:data:v1`)
- 동기화: File System Access API로 로컬(또는 OneDrive/Dropbox/Drive 폴더 안) JSON 파일에 직접 읽기/쓰기, 파일 핸들은 IndexedDB에 보관

## 데이터 스키마
```jsonc
{
  "settings": { "theme": "light", "accent": "#1a73e8" },
  "projects": [{ "id": "cat-1", "name": "정산", "color": "#d50000" }],
  "events":   [],   // 캘린더 일정
  "todos":    [],   // 할 일
  "tasks":    []    // 프로젝트(칸반) 카드 — status: todo | inprogress | done, dueDate 있으면 캘린더 표시
}
```

`sample-sheet-import.json` — 구글시트 업무리스트(39건)를 위 포맷으로 변환한 샘플. 설정 → 불러오기로 적재 가능(기존 데이터 덮어씀).

## 개발
파일 하나짜리라 빌드 과정이 없다. `MySchedulerApp.html`을 직접 편집하고 브라우저에서 새로고침해 확인한다.
- HTML/CSS: 상단 `<style>`
- FullCalendar: 내장 번들 (수정 금지)
- 앱 로직: 하단 `<script>` 블록들 (`window.api` 저장 계층 + `클라우드 모듈` + `app` 로직)

## 웹 배포 (여러 기기 데이터 공유)
`web/` 폴더가 Cloudflare Pages 배포 프로젝트다. 정적 앱 + Functions API(`/api`) + D1(SQLite)로,
어느 기기에서 접속해도 비밀번호 로그인 후 **같은 데이터**를 본다. 배포 방법은 [web/README-deploy.md](web/README-deploy.md) 참고.

- 앱은 http(s)로 서빙되고 `/api/health`가 있으면 **클라우드 모드**(로그인 게이트 + 클라우드 저장)로 전환된다.
- `file://`로 그냥 열면 기존 **로컬 모드**(localStorage) 그대로 — 동작 변화 없음.
- 저장소 교체는 `window.api`(loadData/saveData) 추상화 위에서 이뤄져, 앱 로직은 그대로다.
