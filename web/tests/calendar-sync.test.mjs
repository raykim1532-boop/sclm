// /api/google/sync — 캘린더 양방향 동기화 (공용 함수 + 크론 인증)
import { API, check, section, mockDB, mockRequest, mockFetch, GOOGLE_TOKEN_ROUTE } from './_helpers.mjs';

const { onRequestPost, runCalendarSync } = await import(API + 'google/sync.js');

function makeEnv() {
  const docs = {
    main: JSON.stringify({
      todos: [{ id: 'sh_a', text: '시트 업무', dueDate: '2026-07-30', no: 1 }],
      events: [], projects: [{ id: 'cat-1', name: '정산' }], settings: {},
    }),
    google: JSON.stringify({ refresh_token: 'r', calendarId: 'CAL1' }),
  };
  mockFetch([
    GOOGLE_TOKEN_ROUTE,
    { match: '/events', method: 'POST', reply: { id: 'gev_new' } },
    { match: '/events', reply: { items: [] } },
    { match: 'calendarList', reply: { items: [{ id: 'CAL1', summary: 'SCLM' }] } },
  ]);
  return { docs, env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', DB: mockDB(docs) } };
}

section('공용 함수');
{
  const { docs, env } = makeEnv();
  const out = await runCalendarSync(env);
  check('Response가 아닌 객체 반환', out && typeof out.json !== 'function');
  check('ok=true', out.ok === true);
  check('할 일이 캘린더로 생성됨', out.pushed >= 1);
  check('googleId 저장', JSON.parse(docs.main).todos[0].googleId === 'gev_new');
}

section('엔드포인트 인증');
{
  const { env } = makeEnv();
  const ctx = (h) => ({ env, request: mockRequest(h) });
  check('크론 시크릿 → 200', (await onRequestPost(ctx({ 'X-Cron-Secret': 'CRONSEC' }))).status === 200);
  check('앱 비밀번호 → 200', (await onRequestPost(ctx({ Authorization: 'Bearer pw' }))).status === 200);
  check('잘못된 시크릿 → 401', (await onRequestPost(ctx({ 'X-Cron-Secret': 'WRONG' }))).status === 401);
  check('인증 없음 → 401', (await onRequestPost(ctx({}))).status === 401);
}

section('미연결 처리');
{
  const docs = { main: '{}', google: '{}' }; // refresh_token 없음
  const r = await onRequestPost({ env: { APP_PASSWORD: 'pw', DB: mockDB(docs) }, request: mockRequest({ Authorization: 'Bearer pw' }) });
  check('구글 미연결 → 400', r.status === 400);
  check('error=not_connected', (await r.json()).error === 'not_connected');
}

section('읽기 전용 캘린더 가져오기');
{
  // 개인 캘린더(PERSONAL)를 읽기 전용으로 고른 상태
  const docs = {
    main: JSON.stringify({
      todos: [], events: [], projects: [{ id: 'cat-1', name: '정산' }], settings: {},
    }),
    google: JSON.stringify({
      refresh_token: 'r', calendarId: 'CAL1',
      readCalendars: [{ id: 'PERSONAL', name: '내 캘린더' }],
    }),
  };
  mockFetch([
    GOOGLE_TOKEN_ROUTE,
    { match: '/calendars/PERSONAL/events', reply: { items: [
      { id: 'p1', status: 'confirmed', summary: '치과 예약', start: { date: '2026-08-01' }, end: { date: '2026-08-02' } },
    ] } },
    { match: '/events', method: 'POST', reply: { id: 'gev_new' } },
    { match: '/events', reply: { items: [] } },
    { match: 'calendarList', reply: { items: [{ id: 'CAL1', summary: 'SCLM' }] } },
  ]);
  const env = { APP_PASSWORD: 'pw', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', DB: mockDB(docs) };

  const out = await runCalendarSync(env);
  const evs = JSON.parse(docs.main).events;
  check('개인 캘린더 일정을 가져옴', evs.length === 1 && evs[0].title === '치과 예약');
  check('읽기 전용 표시', evs[0].roCal === 'PERSONAL' && evs[0].readOnly === true);
  check('출처 캘린더 이름 보관', evs[0].roCalName === '내 캘린더');
  check('종일 일정 종료일 보정', evs[0].start === '2026-08-01' && evs[0].end === '2026-08-01');
  check('선택한 캘린더 수 보고', out.readCalendars === 1);

  // 같은 일정을 다시 동기화해도 중복되지 않고, SCLM 캘린더로 밀어 올리지도 않는다
  const before = JSON.parse(docs.main).events[0].id;
  const out2 = await runCalendarSync(env);
  const evs2 = JSON.parse(docs.main).events;
  check('두 번 돌려도 중복 없음', evs2.length === 1 && evs2[0].id === before);
  check('남의 캘린더 일정은 SCLM으로 밀지 않음', !evs2[0].gSig && out2.pushed === 0);

  // 원본이 사라지면 가져온 항목도 정리된다
  mockFetch([
    GOOGLE_TOKEN_ROUTE,
    { match: '/calendars/PERSONAL/events', reply: { items: [] } },
    { match: '/events', method: 'POST', reply: { id: 'gev_new' } },
    { match: '/events', reply: { items: [] } },
    { match: 'calendarList', reply: { items: [{ id: 'CAL1', summary: 'SCLM' }] } },
  ]);
  await runCalendarSync(env);
  check('원본 삭제 시 함께 사라짐', JSON.parse(docs.main).events.length === 0);
}

section('가져오기 선택을 끄면 정리된다');
{
  const docs = {
    main: JSON.stringify({
      todos: [], projects: [{ id: 'cat-1', name: '정산' }], settings: {},
      events: [
        { id: 'r1', googleId: 'p1', roCal: 'PERSONAL', readOnly: true, title: '치과', start: '2026-08-01' },
        { id: 'own1', title: '내 일정', start: '2026-08-02' },
      ],
    }),
    google: JSON.stringify({ refresh_token: 'r', calendarId: 'CAL1', readCalendars: [] }),
  };
  mockFetch([
    GOOGLE_TOKEN_ROUTE,
    { match: '/events', method: 'POST', reply: { id: 'gev_new' } },
    { match: '/events', reply: { items: [] } },
    { match: 'calendarList', reply: { items: [{ id: 'CAL1', summary: 'SCLM' }] } },
  ]);
  const env = { APP_PASSWORD: 'pw', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', DB: mockDB(docs) };
  await runCalendarSync(env);
  const evs = JSON.parse(docs.main).events;
  check('선택 해제한 캘린더 일정은 제거', !evs.some((e) => e.roCal));
  check('내 일정은 그대로 남음', evs.some((e) => e.id === 'own1'));
}
