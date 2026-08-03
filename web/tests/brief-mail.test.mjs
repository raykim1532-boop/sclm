// 아침 브리핑 이메일 — 본문 생성과 발송 경로.
// ⚠️ Resend 무료 계정은 도메인 없이 onboarding@resend.dev 로만 보낼 수 있고,
//    **가입한 본인 주소로만** 발송된다. 그래서 설정이 없으면 조용히 건너뛰고,
//    실패해도 푸시·카카오를 막지 않아야 한다.
import { check, section } from './_helpers.mjs';
import { API, mockRequest, mockFetch } from './_helpers.mjs';

const { buildMailBody, mailConfigured, sendBriefMail } = await import(API + 'push/_mail.js');
const { onRequestPost } = await import(API + 'push/run-daily.js');

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const day = (n) => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = (o) => Object.assign({ id: 'a', text: '업무', dueDate: TODAY, status: '대기', channel: '마리오', subChannel: '패션플러스' }, o);

const SUM = {
  today: TODAY, overdue: 2, dueToday: 1, upcoming: 1, events: 1,
  overdueList: [T({ id: 'o1', text: '[중요] 밀린 업무 하나', dueDate: day(-3) }), T({ id: 'o2', text: '밀린 업무 둘', dueDate: day(-1) })],
  todayList: [T({ id: 'd1', text: '오늘 마감 건' })],
  upcomingList: [T({ id: 'u1', text: '임박 건', dueDate: day(2) })],
  eventList: [{ id: 'e1', title: '대표님+전략사업부_주간회의', start: TODAY, allDay: false, startTime: '10:00', roCalName: '세정글로벌' }],
};

section('설정 판정');
{
  check('키와 받는 주소가 다 있어야 한다', mailConfigured({ RESEND_API_KEY: 'k', MAIL_TO: 'a@b.com' }) === true);
  check('키만 있으면 안 됨', mailConfigured({ RESEND_API_KEY: 'k' }) === false);
  check('주소만 있으면 안 됨', mailConfigured({ MAIL_TO: 'a@b.com' }) === false);
  check('빈 env 안전', mailConfigured({}) === false && mailConfigured(null) === false);
}

section('본문 — 제목과 요약');
{
  const m = buildMailBody(SUM);
  check('제목에 날짜와 건수', m.subject.includes('지연 2') && m.subject.includes('일정 1'));
  check('HTML 과 텍스트 둘 다', !!m.html && !!m.text);
  check('요약 줄', m.html.includes('지연 2 · 오늘 1 · 임박 1 · 일정 1'));
}

section('본문 — 전체를 담는다(푸시처럼 3건으로 안 자른다)');
{
  const many = Object.assign({}, SUM, {
    overdue: 9,
    overdueList: Array.from({ length: 9 }, (_, i) => T({ id: 'x' + i, text: '밀린 업무 ' + i, dueDate: day(-2) })),
  });
  const m = buildMailBody(many);
  for (let i = 0; i < 9; i++) check('밀린 업무 ' + i + ' 포함', m.html.includes('밀린 업무 ' + i));
  check('"외 N건" 으로 접지 않는다', !m.html.includes('외 '));
}

section('본문 — 내용');
{
  const m = buildMailBody(SUM);
  check('지연 일수', m.html.includes('3일'));
  check('제목 앞 꼬리표는 뗀다', m.html.includes('밀린 업무 하나') && !m.html.includes('[중요]'));
  check('분류가 붙는다', m.html.includes('마리오 · 패션플러스'));
  check('일정 시각', m.html.includes('10:00'));
  check('일정 출처 캘린더', m.html.includes('세정글로벌'));
  check('앱 링크', m.html.includes('https://sclm.pages.dev'));
  check('종일 일정 표기', buildMailBody(Object.assign({}, SUM, {
    eventList: [{ id: 'e', title: '광복절', start: TODAY, allDay: true }],
  })).html.includes('종일'));
}

section('본문 — HTML 이스케이프');
{
  const m = buildMailBody(Object.assign({}, SUM, {
    todayList: [T({ id: 'x', text: '<img src=x onerror=1> "따옴표"' })],
  }));
  check('태그가 이스케이프된다', !m.html.includes('<img src=x') && m.html.includes('&lt;img'));
  check('따옴표도', m.html.includes('&quot;'));
}

section('본문 — 알릴 것이 없는 날');
{
  const empty = { today: TODAY, overdue: 0, dueToday: 0, upcoming: 0, events: 0, overdueList: [], todayList: [], upcomingList: [], eventList: [] };
  const m = buildMailBody(empty);
  check('죽지 않는다', !!m.html && !!m.subject);
  check('안내 문구', m.html.includes('알릴 것이 없어요'));
}

section('발송 — 설정이 없으면 건너뛴다');
{
  let called = 0;
  global.fetch = async () => { called++; return { ok: true, status: 200, async json() { return {}; } }; };
  const r = await sendBriefMail({}, SUM);
  check('건너뛴다', r.skipped === 'not_configured');
  check('호출도 안 한다', called === 0);
}

section('발송 — 요청 형태');
{
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, async json() { return { id: 'msg_1' }; } };
  };
  const r = await sendBriefMail({ RESEND_API_KEY: 're_test', MAIL_TO: 'me@company.com' }, SUM);
  check('성공', r.ok === true && r.id === 'msg_1');
  check('엔드포인트', captured.url === 'https://api.resend.com/emails');
  check('Bearer 인증', captured.headers.Authorization === 'Bearer re_test');
  check('받는 주소는 배열', Array.isArray(captured.body.to) && captured.body.to[0] === 'me@company.com');
  check('기본 발신 주소', captured.body.from.includes('onboarding@resend.dev'));
  check('html·text 둘 다 보낸다', !!captured.body.html && !!captured.body.text);

  await sendBriefMail({ RESEND_API_KEY: 'k', MAIL_TO: 'me@company.com', MAIL_FROM: 'SCLM <a@b.com>' }, SUM);
  check('발신 주소를 바꿀 수 있다', captured.body.from === 'SCLM <a@b.com>');
}

section('발송 — 실패해도 예외를 던지지 않는다');
{
  global.fetch = async () => ({ ok: false, status: 403, async json() { return { message: 'You can only send testing emails to your own email address' }; } });
  const r = await sendBriefMail({ RESEND_API_KEY: 'k', MAIL_TO: 'other@x.com' }, SUM);
  check('ok=false 로 돌려준다', r.ok === false && r.status === 403);
  check('사유가 남는다', r.error.includes('your own email address'));

  global.fetch = async () => { throw new Error('network down'); };
  const r2 = await sendBriefMail({ RESEND_API_KEY: 'k', MAIL_TO: 'a@b.com' }, SUM);
  check('네트워크 오류도 삼킨다', r2.ok === false && r2.error.includes('network down'));
}

section('run-daily — 메일이 다른 채널을 막지 않는다');
{
  const docs = { main: JSON.stringify({ todos: [T({ id: 'a', dueDate: TODAY })], events: [], projects: [] }) };
  const { mockDB } = await import('./_helpers.mjs');
  // 메일만 실패시킨다
  global.fetch = async (url) => {
    if (String(url).includes('api.resend.com')) return { ok: false, status: 500, async json() { return { message: 'boom' }; } };
    return { ok: true, status: 200, async json() { return {}; }, async text() { return '{}'; } };
  };
  const r = await onRequestPost({
    env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', DB: mockDB(docs), RESEND_API_KEY: 'k', MAIL_TO: 'a@b.com' },
    request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }),
  });
  const b = await r.json();
  check('알림 자체는 성공', b.ok === true && !b.skipped);
  check('메일 실패가 응답에 남는다', b.mail && b.mail.ok === false);
  check('푸시 결과도 그대로 있다', !!b.push);
}

section('run-daily — 메일 설정이 없어도 그대로 돈다');
{
  const docs = { main: JSON.stringify({ todos: [T({ id: 'a', dueDate: TODAY })], events: [], projects: [] }) };
  const { mockDB } = await import('./_helpers.mjs');
  mockFetch([]);
  const r = await onRequestPost({
    env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', DB: mockDB(docs) },
    request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }),
  });
  const b = await r.json();
  check('정상 발송', b.ok === true);
  check('메일은 건너뜀으로 표시', b.mail && b.mail.skipped === 'not_configured');
}
