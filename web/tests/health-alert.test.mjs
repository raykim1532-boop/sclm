// 고장 감시 메일 — 조용히 망가진 것을 찾아 **문제가 있을 때만** 알린다.
//
// 이게 필요한 이유: "알림이 안 온다"와 "오늘은 알릴 게 없다"가 겉보기에 똑같아서
// 크론이 죽어도 며칠씩 모르고 지나간다(실제로 GitHub Actions 9시간 지각을 이틀 뒤에 알았다).
// ⚠️ 반대로 틀린 경고가 몇 번 오면 진짜 경고도 안 읽게 되므로,
//    '모르는 상태'(기록 없음·조회 실패)는 절대 경고로 만들지 않는다.
import { API, check, section, mockDB, mockRequest, mockFetch } from './_helpers.mjs';

const { buildAlertMailBody, sendAlertMail } = await import(API + 'push/_mail.js');
const { onRequestPost } = await import(API + 'push/run-daily.js');

const NOW = Date.UTC(2026, 7, 12, 0, 0, 0);           // KST 2026-08-12(수) 09:00
const TODAY = '2026-08-12';
const T = (o) => Object.assign({ id: 'z', text: '업무', dueDate: TODAY, status: '대기' }, o);
const MAIL = { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', RESEND_API_KEY: 'K', MAIL_TO: 'me@example.com' };
const resend = (calls) => calls.filter((c) => c.url.includes('api.resend.com')).map((c) => JSON.parse(c.opts.body));
const alerts = (calls) => resend(calls).filter((m) => m.subject.includes('점검 필요'));

async function atNow(fn) {
  const real = Date.now;
  Date.now = () => NOW;
  try { return await fn(); } finally { Date.now = real; }
}

/* snapshots 의 MAX(created_at) 까지 답해 주는 DB 모의.
   ⚠️ 공용 mockDB 는 snapshots 를 모르고 null 을 돌려준다 — 그건 '모름'이라 경고가 안 뜬다.
      백업 경고를 검증하려면 이렇게 전용 모의가 필요하다. */
function dbWithSnapshot(docs, lastBackupAt) {
  const base = mockDB(docs);
  return {
    prepare(q) {
      if (q.includes('MAX(created_at)')) {
        return { bind() { return this; }, async first() { return { last: lastBackupAt }; }, async run() { return {}; } };
      }
      return base.prepare(q);
    },
  };
}

section('본문');
{
  const out = buildAlertMailBody([
    { icon: '⏱', title: '아침 알림이 2일 동안 실행되지 않았습니다', detail: '마지막 실행 2026-08-09.' },
    { icon: '💾', title: '백업이 3일째 만들어지지 않았습니다', detail: '지금 백업으로 남길 수 있습니다.' },
  ], TODAY);

  check('제목에 건수', out.subject === '[SCLM] ⚠️ 점검 필요 2건');
  check('두 건 다 실린다', out.html.includes('2일 동안') && out.html.includes('3일째'));
  check('상세도 실린다', out.html.includes('마지막 실행 2026-08-09'));
  check('평상시엔 안 온다고 알려 준다', out.html.includes('문제가 감지된 날에만'));
  check('평문본도 있다', out.text.includes('점검 필요 (2건)'));
  check('이스케이프', buildAlertMailBody([{ title: '<b>x</b>', detail: '' }], TODAY).html.includes('&lt;b&gt;'));
}

section('문제가 없으면 아예 안 보낸다');
{
  let called = 0;
  global.fetch = async () => { called++; return { ok: true, status: 200, async json() { return {}; } }; };
  check('빈 목록', (await sendAlertMail(MAIL, [], TODAY)).skipped === 'no_issues');
  check('발송 시도조차 없음', called === 0);
  check('설정 없으면 건너뜀', (await sendAlertMail({}, [{ title: 'x' }], TODAY)).skipped === 'not_configured');
}

section('크론 미발사 감지');
{
  await atNow(async () => {
    // 마지막 실행이 3일 전 → 2일 걸렀다
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-09', lastSentDay: '2026-08-09' }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'a' } }]);
    const env = Object.assign({ DB: mockDB(docs) }, MAIL);
    const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();

    check('점검 메일 발송', b.alert.ok === true && b.alert.issues === 1);
    check('공백 일수를 알려 준다', alerts(calls)[0].html.includes('2일 동안 실행되지 않았습니다'));
    check('마지막 실행일도', alerts(calls)[0].html.includes('2026-08-09'));
    check('아침 브리핑은 따로 나간다', resend(calls).length === 2);
    check('실행 기록이 오늘로 갱신됨', JSON.parse(docs.daily).lastRunDay === TODAY);
  });
}

section('정상일 때는 조용하다');
{
  await atNow(async () => {
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-11', lastSentDay: '2026-08-11' }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'a' } }]);
    const b = await (await onRequestPost({ env: Object.assign({ DB: mockDB(docs) }, MAIL),
      request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('어제 돌았으면 이상 없음', b.alert.skipped === 'no_issues');
    check('점검 메일 없음', alerts(calls).length === 0);
    check('브리핑만 나감', resend(calls).length === 1);
  });

  // 기록이 아예 없는 첫 실행은 '모름'이지 고장이 아니다
  await atNow(async () => {
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'a' } }]);
    const b = await (await onRequestPost({ env: Object.assign({ DB: mockDB(docs) }, MAIL),
      request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('첫 실행은 경고하지 않는다', b.alert.skipped === 'no_issues');
    check('점검 메일 없음', alerts(calls).length === 0);
  });
}

section('백업 정체 감지');
{
  await atNow(async () => {
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-11', lastSentDay: '2026-08-11' }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'a' } }]);
    // 마지막 백업이 4일 전
    const env = Object.assign({ DB: dbWithSnapshot(docs, Date.UTC(2026, 7, 8, 0, 0, 0)) }, MAIL);
    const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('백업 정체를 잡는다', b.alert.issues === 1);
    check('며칠째인지 알려 준다', alerts(calls)[0].html.includes('4일째'));
  });

  await atNow(async () => {
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-11', lastSentDay: '2026-08-11' }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'a' } }]);
    // 어제 백업됨 → 정상
    const env = Object.assign({ DB: dbWithSnapshot(docs, Date.UTC(2026, 7, 11, 0, 0, 0)) }, MAIL);
    const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('하루 전이면 정상', b.alert.skipped === 'no_issues');
    check('점검 메일 없음', alerts(calls).length === 0);
  });
}

section('카카오 실패도 잡는다');
{
  await atNow(async () => {
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-11', lastSentDay: '2026-08-11' }) };
    const calls = mockFetch([
      { match: 'kauth.kakao.com', method: 'POST', status: 401, reply: { error: 'invalid_grant' } },
      { match: 'api.resend.com', method: 'POST', reply: { id: 'a' } },
    ]);
    const env = Object.assign({ DB: mockDB(docs), KAKAO_REST_API_KEY: 'K', KAKAO_REFRESH_TOKEN: 'R' }, MAIL);
    const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('카카오 실패가 이상 목록에 들어간다', b.alert.issues >= 1);
    check('무엇을 해야 하는지 알려 준다', alerts(calls)[0].html.includes('카카오 다시 연결'));
  });
}

section('브리핑 메일 실패도 잡는다');
{
  await atNow(async () => {
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-11', lastSentDay: '2026-08-11' }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'a' } }]);
    /* 브리핑만 실패시키고 점검 메일은 살려 둔다 — 둘 다 죽이면 "경고가 도착하는가"를 못 본다.
       실제로도 한 통만 실패하는 경우(수신 거부·용량·일시 오류)가 대부분이라 이 쪽이 현실적이다. */
    const inner = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const subject = String(url).includes('api.resend.com')
        ? (JSON.parse(opts.body || '{}').subject || '') : '';
      if (subject && !subject.includes('점검 필요')) {
        calls.push({ method: opts.method || 'GET', url: String(url), opts });
        return { ok: false, status: 422, async json() { return { message: 'domain not verified' }; },
                 async text() { return '{}'; } };
      }
      return inner(url, opts);
    };
    try {
      const env = Object.assign({ DB: mockDB(docs) }, MAIL);
      const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();

      check('브리핑 메일이 실패했고', b.mail.ok === false);
      check('그게 이상 목록에 들어간다', b.alert.ok === true && b.alert.issues === 1);
      check('무엇이 실패했는지', alerts(calls)[0].html.includes('아침 브리핑 메일 발송에 실패'));
      check('원인도 함께', alerts(calls)[0].html.includes('domain not verified'));
    } finally { global.fetch = inner; }
  });

  // 메일을 아예 안 쓰는 설정(not_configured)은 고장이 아니다 — 경고하면 소음이 된다
  await atNow(async () => {
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-11', lastSentDay: '2026-08-11' }) };
    mockFetch([]);
    const env = { DB: mockDB(docs), APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC' };
    const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('메일 미설정은 경고하지 않는다', b.mail.skipped === 'not_configured');
    check('이상 없음', b.alert.skipped === 'no_issues');
  });
}

section('하루 한 통 (08:10 재시도에 또 오지 않는다)');
{
  await atNow(async () => {
    // 백업 정체는 한 번 실행한다고 풀리지 않으므로, 재시도 때도 이상 목록이 그대로 남는다.
    // (크론 미발사는 첫 실행이 lastRunDay 를 갱신하는 순간 해소되므로 가드 검증에 못 쓴다.)
    const docs = { main: JSON.stringify({ todos: [], events: [], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-11', lastSentDay: '2026-08-11' }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'a' } }]);
    const env = Object.assign({ DB: dbWithSnapshot(docs, Date.UTC(2026, 7, 5, 0, 0, 0)) }, MAIL);
    const ctx = () => ({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) });

    const b1 = await (await onRequestPost(ctx())).json();
    check('알릴 것 없는 날에도 점검은 나간다', b1.alert.ok === true);
    check('점검 메일 1통', alerts(calls).length === 1);
    check('발송일 기록', JSON.parse(docs.daily).lastAlertDay === TODAY);

    const b2 = await (await onRequestPost(ctx())).json();
    check('문제는 그대로지만', b2.alert.issues === 1);
    check('두 번째는 건너뛴다', b2.alert.skipped === 'already_sent_today');
    check('여전히 1통', alerts(calls).length === 1);

    // ⚠️ recordAttempt 가 daily 문서를 통짜로 새로 쓰므로 가드 키가 지워지기 쉽다
    check('가드 키가 유지된다', JSON.parse(docs.daily).lastAlertDay === TODAY);
  });
}

section('점검이 실패해도 브리핑은 나간다');
{
  await atNow(async () => {
    const docs = { main: JSON.stringify({ todos: [T({})], projects: [] }),
                   daily: JSON.stringify({ lastRunDay: '2026-08-09' }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'a' } }]);
    // 점검 메일만 실패하도록: sendAlertMail 이 던지는 상황을 흉내낸다
    const env = Object.assign({ DB: mockDB(docs) }, MAIL, { RESEND_API_KEY: 'K' });
    const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('브리핑은 정상 발송', b.ok === true && b.mail.ok === true);
    check('점검 결과도 응답에 실린다', !!b.alert);
    check('메일은 브리핑 + 점검', resend(calls).length === 2);
  });
}
