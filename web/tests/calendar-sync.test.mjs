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
