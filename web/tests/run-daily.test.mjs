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
  // 이력은 남기되 '발송함' 표시는 하지 않는다 → 늦게 업무가 생기면 그날 안에 다시 보낼 수 있어야 한다
  check('nothing_due는 발송일을 기록하지 않음', !JSON.parse(docs.daily || '{}').lastSentDay);
  docs.main = JSON.stringify({ todos: [DUE_TODO], projects: [] });
  const r2 = await onRequestPost(makeCtx(docs, { 'X-Cron-Secret': 'CRONSEC' }));
  const b2 = await r2.json();
  check('그 뒤 업무가 생기면 같은 날에도 발송', b2.ok === true && !b2.skipped);
}

section('호출한 스케줄러 기록 (cf-cron / gh-actions 구분)');
{
  const docs = { main: JSON.stringify({ todos: [DUE_TODO], projects: [] }) };
  mockFetch([]);
  const r1 = await onRequestPost(makeCtx(docs, { 'X-Cron-Secret': 'CRONSEC', 'X-Cron-Source': 'gh-actions' }));
  check('응답에 source 반환', (await r1.json()).source === 'gh-actions');
  let daily = JSON.parse(docs.daily);
  check('발송 이력에 source 기록', daily.attempts[0].source === 'gh-actions' && daily.attempts[0].action === 'sent');

  // 같은 날 Cloudflare 크론이 뒤이어 발사되면 '발송'은 건너뛰되 '발사됐다'는 기록은 남아야 한다
  const r2 = await onRequestPost(makeCtx(docs, { 'X-Cron-Secret': 'CRONSEC', 'X-Cron-Source': 'cf-cron' }));
  check('중복이면 skipped', (await r2.json()).skipped === 'already_sent_today');
  daily = JSON.parse(docs.daily);
  check('건너뛴 호출도 이력에 남음', daily.attempts.some((a) => a.source === 'cf-cron' && a.action === 'skipped'));
  check('발송일은 그대로 유지', !!daily.lastSentDay);

  const r3 = await onRequestPost(makeCtx(docs, { Authorization: 'Bearer pw' }));
  check('수동 호출은 manual로 기록', (await r3.json()).source === 'manual');

  // 헤더가 없으면 unknown, 이상한 값은 걸러낸다
  const docs2 = { main: JSON.stringify({ todos: [DUE_TODO], projects: [] }) };
  const r4 = await onRequestPost(makeCtx(docs2, { 'X-Cron-Secret': 'CRONSEC' }));
  check('헤더 없으면 unknown', (await r4.json()).source === 'unknown');
  const docs3 = { main: JSON.stringify({ todos: [DUE_TODO], projects: [] }) };
  const r5 = await onRequestPost(makeCtx(docs3, { 'X-Cron-Secret': 'CRONSEC', 'X-Cron-Source': 'cf cron<script>' }));
  check('이상 문자는 제거', (await r5.json()).source === 'cfcronscript');

  // 이력이 무한히 쌓이지 않아야 한다
  const docs4 = { main: JSON.stringify({ todos: [DUE_TODO], projects: [] }) };
  for (let i = 0; i < 15; i++) await onRequestPost(makeCtx(docs4, { 'X-Cron-Secret': 'CRONSEC', 'X-Cron-Source': 'cf-cron' }));
  check('이력은 최근 10건까지만 보관', JSON.parse(docs4.daily).attempts.length <= 10);
}

section('인증');
{
  const docs = { main: JSON.stringify({ todos: [DUE_TODO], projects: [] }) };
  mockFetch([]);
  check('잘못된 크론 시크릿 → 401', (await onRequestPost(makeCtx(docs, { 'X-Cron-Secret': 'WRONG' }))).status === 401);
  check('인증 없음 → 401', (await onRequestPost(makeCtx(docs, {}))).status === 401);
}
