// /api/google/sheet-sync — 시트 읽기 전용 가져오기
// 회귀 방지: ① 시트에 절대 쓰지 않는다 ② 구조가 다르면 중단 ③ 앱에서 추가한 할 일은 보존한다
import { API, check, section, mockDB, mockFetch, GOOGLE_TOKEN_ROUTE } from './_helpers.mjs';

const { runSheetSync } = await import(API + 'google/sheet-sync.js');

// 실제 '업무리스트' 탭과 같은 고정 열 배치
const HEADER = ['', '', '', '', '담당자', '대분류', '세부채널', '우선순위', '진행상태', '점검필요', '업무내용', '진행사항 / 업데이트 로그', '산출물 링크', '비고', 'D-Day(남은일수)', '소요일수'];
const row = (o) => [o.no || '', o.reg || '', o.due || '', o.done || '', o.assignee || '김성철', o.project || '영업', o.ch || '', o.pri || '보통', o.status || '대기', o.check || '', o.text || '', o.progress || '', '', o.remarks || '', '-', '-'];

const baseSheet = [
  HEADER,
  row({ no: 1, reg: '2026-07-01', due: '2026-07-10', done: '2026-07-10', project: '정산', ch: '엔터식스', pri: '중요', status: '완료', text: '엔터식스 정산' }),
  row({ no: 2, reg: '2026-07-20', due: '2026-07-30', status: '진행중', check: 'Y', text: '마리오 그랜드오픈' }),
  [], // 빈 행
  row({ no: 9, reg: '2026-07-01', text: '' }), // 업무내용 없음 → 스킵
];

function makeEnv(grid, todos = [], extra = {}) {
  const docs = {
    main: JSON.stringify({ todos, projects: [{ id: 'cat-1', name: '정산' }, { id: 'cat-2', name: '영업' }], ...extra }),
    google: JSON.stringify({ refresh_token: 'r', sheet: { spreadsheetId: 'S', gid: 1, title: '업무리스트' } }),
  };
  const calls = mockFetch([
    GOOGLE_TOKEN_ROUTE,
    { match: '?fields=sheets', reply: { sheets: [{ properties: { sheetId: 1, title: '업무리스트' } }] } },
    { match: '/values/', reply: { values: grid } },
  ]);
  return { docs, calls, env: { GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', DB: mockDB(docs) } };
}

section('시트 → 앱 파싱');
{
  const { docs, env } = makeEnv(baseSheet);
  const out = await runSheetSync(env);
  const st = JSON.parse(docs.main);
  check('빈 행·업무내용 없는 행은 스킵(2건)', out.imported === 2);
  const t1 = st.todos.find((t) => t.text === '엔터식스 정산');
  check('대분류 → 프로젝트 매핑', t1.projectId === 'cat-1');
  check('마감(예정)일 매핑', t1.dueDate === '2026-07-10');
  check('완료일 매핑', t1.completedDate === '2026-07-10');
  check('완료 → done true', t1.done === true);
  const t2 = st.todos.find((t) => t.text === '마리오 그랜드오픈');
  check('진행중 → done false', t2.done === false);
  check('점검필요 매핑', t2.needsCheck === 'Y');
  check('시트 항목 id는 sh_ 접두', st.todos.every((t) => t.id.startsWith('sh_')));
}

section('시트에 쓰지 않음(비파괴)');
{
  const { calls, env } = makeEnv(baseSheet);
  await runSheetSync(env);
  const writes = calls.filter((c) => ['PUT', 'POST'].includes(c.method) && c.url.includes('sheets.googleapis.com'));
  check('시트 쓰기 호출 0건', writes.length === 0);
}

section('앱에서 추가한 할 일 보존');
{
  const appTodo = { id: 'm8x2k9ab', text: '앱에서 직접 추가', dueDate: '2026-07-29' }; // uid() 형태
  const { docs, env } = makeEnv(baseSheet, [{ id: 'sh_old', text: '옛 시트 항목' }, appTodo]);
  const out = await runSheetSync(env);
  const st = JSON.parse(docs.main);
  check('앱 항목 보존', st.todos.some((t) => t.id === 'm8x2k9ab'));
  check('옛 시트 항목은 교체', !st.todos.some((t) => t.id === 'sh_old'));
  check('kept 카운트 보고', out.kept === 1);
}

section('앱 전용 데이터 보존 (첨부·링크·캘린더 연동)');
{
  // 실사고: 시트 항목에 붙인 첨부파일이 동기화 한 번에 사라졌다(R2 객체는 고아로 남음).
  // 시트에 없는 필드는 이전 값에서 되살려야 한다.
  const { docs: seed, env: env0 } = makeEnv(baseSheet);
  await runSheetSync(env0);
  const target = JSON.parse(seed.main).todos.find((t) => t.text === '엔터식스 정산');

  const withExtras = JSON.parse(seed.main).todos.map((t) => (t.id === target.id
    ? { ...t, files: [{ key: 'ms4i5j0s/q7alzj4x.xlsx', name: '정산서.xlsx', size: 1234 }], links: ['https://drive.example/a'], googleId: 'gcal-1', gSig: 'sig-1' }
    : t));

  const { docs, env } = makeEnv(baseSheet, withExtras);
  const out = await runSheetSync(env);
  const after = JSON.parse(docs.main).todos.find((t) => t.id === target.id);

  check('동기화 후에도 같은 항목이 존재', !!after);
  check('첨부파일 보존', !!after.files && after.files.length === 1 && after.files[0].key === 'ms4i5j0s/q7alzj4x.xlsx');
  check('첨부 이름·크기까지 그대로', after.files[0].name === '정산서.xlsx' && after.files[0].size === 1234);
  check('산출물 링크 보존', Array.isArray(after.links) && after.links[0] === 'https://drive.example/a');
  check('캘린더 연동 정보 보존', after.googleId === 'gcal-1' && after.gSig === 'sig-1');
  check('시트 값은 여전히 시트 기준으로 갱신', after.dueDate === '2026-07-10' && out.imported === 2);

  // 첨부가 없던 항목에 빈 배열을 억지로 만들지 않는다(데이터만 커짐)
  const other = JSON.parse(docs.main).todos.find((t) => t.text === '마리오 그랜드오픈');
  check('첨부 없던 항목엔 files 키를 만들지 않음', other.files === undefined);
}

section('id 안정성');
{
  const { docs, env } = makeEnv(baseSheet);
  await runSheetSync(env);
  const first = JSON.parse(docs.main).todos.find((t) => t.text === '엔터식스 정산').id;
  await runSheetSync(env);
  const second = JSON.parse(docs.main).todos.find((t) => t.text === '엔터식스 정산').id;
  check('재실행해도 같은 id(등록일+내용 해시)', first === second);
}

section('구조 가드');
{
  const bad = [['Ray-Work-Flow', '', ''], ['', '4', '2026-07-01']]; // 헤더 없음
  const original = JSON.stringify({ todos: [{ id: 'keep', text: '보존되어야 함' }], projects: [] });
  const docs = { main: original, google: JSON.stringify({ refresh_token: 'r', sheet: { spreadsheetId: 'S', gid: 1, title: 'X' } }) };
  mockFetch([
    GOOGLE_TOKEN_ROUTE,
    { match: '?fields=sheets', reply: { sheets: [{ properties: { sheetId: 1, title: 'X' } }] } },
    { match: '/values/', reply: { values: bad } },
  ]);
  const out = await runSheetSync({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', DB: mockDB(docs) });
  check('인식 못 하는 구조 → 거부', out.error === 'sheet_structure_unrecognized');
  check('앱 데이터는 건드리지 않음', docs.main === original);
}

section('연동 종료(disabled) 가드');
{
  // 2026-07-28 시트 연동 종료. 플래그가 켜져 있으면 어떤 경로로 불려도 실행되지 않아야 한다.
  const original = JSON.stringify({ todos: [{ id: 'sh_keep', text: '앱이 원천', status: '완료' }], projects: [] });
  const docs = {
    main: original,
    google: JSON.stringify({ refresh_token: 'r', sheet: { spreadsheetId: 'S', gid: 1, title: '업무리스트', disabled: true } }),
  };
  const calls = mockFetch([
    GOOGLE_TOKEN_ROUTE,
    { match: '?fields=sheets', reply: { sheets: [{ properties: { sheetId: 1, title: '업무리스트' } }] } },
    { match: '/values/', reply: { values: baseSheet } },
  ]);
  const out = await runSheetSync({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', DB: mockDB(docs) });
  check('disabled면 실행 거부', out.error === 'sheet_sync_disabled');
  check('앱 데이터 그대로', docs.main === original);
  check('구글 API를 호출하지도 않음', calls.length === 0);
}

section('미설정 처리');
{
  const docs = { main: '{}', google: JSON.stringify({ refresh_token: 'r' }) }; // sheet 설정 없음
  const out = await runSheetSync({ GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', DB: mockDB(docs) });
  check('대상 시트 미설정 → no_sheet_configured', out.error === 'no_sheet_configured');
}
