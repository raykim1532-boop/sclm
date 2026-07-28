// push/run-daily — 크론 이중 발사(08:00·08:10) 중복 방지 가드
// 회귀 방지: 크론은 하루 1회만 발송, 수동(Bearer)은 항상 발송, 인증 없음은 401.
import { API, check, section, mockDB, mockRequest, mockFetch } from './_helpers.mjs';

const { onRequestPost } = await import(API + 'push/run-daily.js');

const DUE_TODO = { id: 'sh_x', text: '오늘 마감 업무', dueDate: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), status: '대기' };

function makeCtx(docs, headers) {
  return {
    env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', DB: mockDB(docs) },
    request: mockRequest(headers),
  };
}

section('크론 중복 방지');
{
  const docs = { main: JSON.stringify({ todos: [DUE_TODO], projects: [] }) };
  mockFetch([]); // 외부 호출 없음(카카오·구글 미설정)

  const r1 = await onRequestPost(makeCtx(docs, { 'X-Cron-Secret': 'CRONSEC' }));
  const b1 = await r1.json();
  check('크론 1차 → 발송(ok)', b1.ok === true && !b1.skipped);
  check('발송일이 daily 문서에 기록됨', !!docs.daily && JSON.parse(docs.daily).lastSentDay);

  const r2 = await onRequestPost(makeCtx(docs, { 'X-Cron-Secret': 'CRONSEC' }));
  const b2 = await r2.json();
  check('크론 2차(같은 날) → already_sent_today 스킵', b2.skipped === 'already_sent_today');

  const r3 = await onRequestPost(makeCtx(docs, { Authorization: 'Bearer pw' }));
  const b3 = await r3.json();
  check('수동(Bearer)은 같은 날에도 항상 발송', b3.ok === true && !b3.skipped);
}

section('보낼 것 없는 날');
{
  const docs = { main: JSON.stringify({ todos: [], projects: [] }) };
  mockFetch([]);
  const r = await onRequestPost(makeCtx(docs, { 'X-Cron-Secret': 'CRONSEC' }));
  const b = await r.json();
  check('지연·오늘·임박 0건 → nothing_due 스킵', b.skipped === 'nothing_due');
  check('nothing_due는 발송 기록을 남기지 않음(늦게 생긴 업무 대비)', !docs.daily);
}

section('인증');
{
  const docs = { main: JSON.stringify({ todos: [DUE_TODO], projects: [] }) };
  mockFetch([]);
  check('잘못된 크론 시크릿 → 401', (await onRequestPost(makeCtx(docs, { 'X-Cron-Secret': 'WRONG' }))).status === 401);
  check('인증 없음 → 401', (await onRequestPost(makeCtx(docs, {}))).status === 401);
}
