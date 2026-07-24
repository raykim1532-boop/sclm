# 나의 스케줄러 (MySchedulerApp)

단일 HTML 파일로 동작하는 개인 일정관리 앱. 설치 없이 `MySchedulerApp.html`을 브라우저로 열면 바로 실행된다.

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
- 앱 로직: 하단 `<script>` 블록들 (`window.api` 저장 계층 + `app` 로직)
