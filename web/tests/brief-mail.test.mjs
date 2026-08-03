// 아침 브리핑 이메일 — 본문 생성과 발송 경로.
// ⚠️ Resend 무료 계정은 도메인 없이 onboarding@resend.dev 로만 보낼 수 있고,
//    **가입한 본인 주소로만** 발송된다. 그래서 설정이 없으면 조용히 건너뛰고,
//    실패해도 푸시·카카오를 막지 않아야 한다.
import { check, section } from './_helpers.mjs';
import { API, mockRequest, mockFetch } from './_helpers.mjs';

const { buildMailBody, mailConfigured, sendBriefMail } = await import(API + 'push/_mail.js');
const { computeStuckChannels, computeWeekly, weekRangeKST } = await import(API + 'push/_send.js');
const { buildWeeklyMailBody, sendWeeklyMail } = await import(API + 'push/_mail.js');
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

section('원클릭 완료 — ✓ 칸');
{
  const links = { o1: 'https://sclm.pages.dev/api/mail-action?a=done&id=o1&s=SIG' };
  const withDone = buildMailBody(SUM, links);
  check('링크 준 항목에 ✓ 가 붙는다', withDone.html.includes('>✓</a>'));
  check('그 항목의 링크가 실린다', withDone.html.includes('a=done&amp;id=o1'));
  check('링크 없는 항목엔 ✓ 칸이 없다', (withDone.html.match(/>✓<\/a>/g) || []).length === 1);
  check('안내 문구가 붙는다', withDone.html.includes('완료 처리'));

  const plain = buildMailBody(SUM);
  check('링크를 안 주면 예전 그대로', !plain.html.includes('✓'));
  check('안내 문구도 없다', !plain.html.includes('앱을 열지 않고'));
  check('평문본은 영향 없음', plain.text === withDone.text);
}

section('딥링크 — 항목을 누르면 그 할 일이 열린다');
{
  const m = buildMailBody(SUM);
  check('할 일마다 링크', m.html.includes('/?todo=o1') && m.html.includes('/?todo=d1') && m.html.includes('/?todo=u1'));
  check('일정에도 링크', m.html.includes('/?event=e1'));
  check('절대 주소', m.html.includes('https://sclm.pages.dev/?todo='));
  check('제목이 링크 안에 들어간다', /href="[^"]*todo=o1"[^>]*>[^<]*밀린 업무 하나/.test(m.html));

  // id 에 특수문자가 있어도 주소가 깨지지 않아야 한다
  const odd = buildMailBody(Object.assign({}, SUM, { todayList: [T({ id: 'a b&c', text: 'x' })] }));
  check('id 를 인코딩한다', odd.html.includes('todo=a%20b%26c'));
}

section('밀리는 분류 — 계산');
{
  const t = (ch, due, status) => ({ id: Math.random().toString(36).slice(2), channel: ch, dueDate: due, status: status || '대기' });
  const list = [
    t('마리오', day(-5)), t('마리오', day(-3)), t('마리오', day(-1)), t('마리오', TODAY, '완료'),
    t('사방넷', day(-2)), t('사방넷', TODAY), t('사방넷', TODAY),
    t('작은곳', day(-9)), t('작은곳', day(-9)),
    t('기타', day(-9)), t('기타', day(-9)), t('기타', day(-9)),
  ];
  const r = computeStuckChannels(list, TODAY, 3, 5);
  check('마리오가 잡힌다', r.some((x) => x.name === '마리오'));
  check('지연 3건', r.find((x) => x.name === '마리오').overdue === 3);
  check('평균 지연일', r.find((x) => x.name === '마리오').avgLate === 3);
  check('지연 1건뿐인 곳은 제외', !r.some((x) => x.name === '사방넷'));
  check('표본 3건 미만은 제외', !r.some((x) => x.name === '작은곳'));
  check('기타는 분류가 아니라 제외', !r.some((x) => x.name === '기타'));
  check('지연 많은 순', r[0].overdue >= (r[1] ? r[1].overdue : 0));
  check('빈 입력 안전', computeStuckChannels(null, TODAY).length === 0);
}

section('밀리는 분류 — 메일에 실린다');
{
  const withStuck = Object.assign({}, SUM, { stuckList: [{ name: '마리오아울렛', total: 31, overdue: 6, avgLate: 3.7 }] });
  const m = buildMailBody(withStuck);
  check('경고 블록', m.html.includes('계속 밀리는 분류'));
  check('이름과 수치', m.html.includes('마리오아울렛') && m.html.includes('지연 6건') && m.html.includes('3.7일'));
  check('텍스트본에도', m.text.includes('[계속 밀리는 분류]') && m.text.includes('마리오아울렛'));
  // '지연' 은 상단 요약 줄에도 있으므로 섹션 제목으로 비교한다
  check('지연 목록보다 위에 온다', m.html.indexOf('계속 밀리는 분류') < m.html.indexOf('⏰ 지연'));

  check('없으면 블록 자체가 없다', !buildMailBody(SUM).html.includes('계속 밀리는 분류'));
}

section('주간 구간 계산 — 월요일 시작');
{
  check('월요일', weekRangeKST('2026-08-03', 0).start === '2026-08-03');
  check('그 주 일요일까지', weekRangeKST('2026-08-03', 0).end === '2026-08-09');
  check('금요일에 봐도 같은 주', weekRangeKST('2026-08-07', 0).start === '2026-08-03');
  check('일요일도 같은 주', weekRangeKST('2026-08-09', 0).start === '2026-08-03');
  check('다음 주', weekRangeKST('2026-08-07', 1).start === '2026-08-10');
  check('달을 넘어가도', weekRangeKST('2026-08-31', 0).start === '2026-08-31');
}

section('주간 요약 — 구간별로 담긴다');
{
  const { mockDB } = await import('./_helpers.mjs');
  const t = (id, o) => Object.assign({ id, text: '업무 ' + id, channel: '마리오', status: '대기' }, o);
  const docs = { main: JSON.stringify({ todos: [
    t('done1', { status: '완료', completedDate: '2026-08-04' }),
    t('done2', { status: '지연완료', completedDate: '2026-08-06' }),
    t('oldDone', { status: '완료', completedDate: '2026-07-20' }),   // 지난주 — 빠져야 한다
    t('next1', { dueDate: '2026-08-11' }),
    t('next2', { dueDate: '2026-08-13' }),
    t('later', { dueDate: '2026-08-25' }),                            // 다다음주 — 빠져야 한다
    t('late1', { dueDate: '2026-07-30' }),
  ], events: [] }) };
  const w = await computeWeekly({ DB: mockDB(docs) }, '2026-08-07');

  check('이번 주 완료 2건', w.done === 2);
  check('지난주 완료는 빠진다', !w.doneList.some((x) => x.id === 'oldDone'));
  check('지연완료도 완료로 센다', w.doneList.some((x) => x.id === 'done2'));
  check('다음 주 마감 2건', w.next === 2);
  check('다다음주는 빠진다', !w.nextList.some((x) => x.id === 'later'));
  check('아직 지연 1건', w.late === 1);
  check('완료일 순 정렬', w.doneList[0].id === 'done1');
}

section('주간 메일 본문');
{
  const w = {
    today: '2026-08-07',
    week: { start: '2026-08-03', end: '2026-08-09' },
    nextWeek: { start: '2026-08-10', end: '2026-08-16' },
    done: 1, next: 1, late: 1,
    doneList: [T({ id: 'a', text: '끝낸 일', completedDate: '2026-08-04' })],
    nextList: [T({ id: 'b', text: '다음 주 일', dueDate: '2026-08-11' })],
    lateList: [T({ id: 'c', text: '아직 밀린 일', dueDate: '2026-07-30' })],
  };
  const m = buildWeeklyMailBody(w);
  check('제목에 구간과 건수', m.subject.includes('08/03~08/09') && m.subject.includes('완료 1'));
  check('세 구분이 다 있다', m.html.includes('이번 주 완료') && m.html.includes('다음 주 마감') && m.html.includes('아직 지연'));
  check('항목이 들어간다', m.html.includes('끝낸 일') && m.html.includes('다음 주 일') && m.html.includes('아직 밀린 일'));
  check('딥링크가 붙는다', m.html.includes('/?todo=a') && m.html.includes('/?todo=c'));
  check('지연 일수', m.html.includes('8일'));
  check('텍스트본도', m.text.includes('[이번 주 완료]') && m.text.includes('끝낸 일'));

  const empty = buildWeeklyMailBody(Object.assign({}, w, { done: 0, next: 0, late: 0, doneList: [], nextList: [], lateList: [] }));
  check('비어도 죽지 않는다', !!empty.html && empty.html.includes('없음'));
}

section('주간 리포트는 금요일에만');
{
  const { mockDB } = await import('./_helpers.mjs');
  const docs = { main: JSON.stringify({ todos: [T({ id: 'a', dueDate: TODAY })], events: [], projects: [] }) };
  mockFetch([]);
  const r = await onRequestPost({
    env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', DB: mockDB(docs) },
    request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }),
  });
  const b = await r.json();
  const isFriday = new Date(Date.now() + 9 * 3600e3).getUTCDay() === 5;
  check('요일에 맞게 판정한다', isFriday ? b.weekly.skipped !== 'not_friday' : b.weekly.skipped === 'not_friday');
  check('아침 브리핑은 그대로 나간다', b.ok === true);
}

section('주간 백업 첨부');
{
  const { buildBackupAttachments, buildTodosCsv } = await import(API + 'push/_mail.js');
  const state = {
    projects: [{ id: 'p1', name: '정산' }],
    todos: [
      { id: 'a', text: '엔터식스 "정산" 확인', projectId: 'p1', channel: '엔터식스', subChannel: '운영',
        assignee: '김성철', priority: '높음', status: '대기', dueDate: '2026-08-07', registeredDate: '2026-08-01' },
      { id: 'b', text: '줄바꿈\n포함', projectId: 'nope', status: '완료', completedDate: '2026-08-03' },
    ],
  };

  const csv = buildTodosCsv(state);
  check('BOM 으로 시작(엑셀 한글 깨짐 방지)', csv.charCodeAt(0) === 0xFEFF);
  check('머리글 포함', csv.includes('"등록일","업무내용","대분류"'));
  // ⚠️ 등록일 필드명은 registeredDate 다(createdDate 가 아니다). 틀리면 열이 통째로 빈다.
  check('등록일이 실제로 채워진다', csv.includes('"2026-08-01"'));
  check('대분류는 이름으로 바뀐다', csv.includes('"정산"'));
  check('없는 대분류는 빈 칸', csv.includes('"","","완료"'));
  check('큰따옴표는 두 번으로 escape', csv.includes('""정산""'));
  // 값 안의 줄바꿈은 따옴표 안에 갇히므로 행 수가 늘지 않는다(머리글 + 2행)
  check('값 안의 줄바꿈이 행을 쪼개지 않는다', csv.split('\r\n').length === 3);
  check('줄바꿈은 값 안에 그대로 남는다', csv.includes('"줄바꿈\n포함"'));
  check('상태 기본값', buildTodosCsv({ todos: [{ id: 'c', done: true }] }).includes('"완료"'));

  const at = buildBackupAttachments(state, '2026-08-07');
  check('첨부 2개', at.length === 2);
  check('JSON 파일명에 날짜', at[0].filename === 'sclm-백업-2026-08-07.json');
  check('CSV 파일명에 날짜', at[1].filename === 'sclm-업무목록-2026-08-07.csv');
  const back = JSON.parse(Buffer.from(at[0].content, 'base64').toString('utf8'));
  check('JSON 은 원본 그대로 복원된다', back.todos.length === 2 && back.todos[0].text === state.todos[0].text);
  check('한글이 깨지지 않는다', Buffer.from(at[1].content, 'base64').toString('utf8').includes('엔터식스'));
  check('빈 상태도 안전', buildBackupAttachments({}, '2026-08-07').length === 2);
}

section('주간 리포트에 백업이 붙는다');
{
  const { mockDB } = await import('./_helpers.mjs');
  const docs = { main: JSON.stringify({ todos: [T({ id: 'z' })], projects: [] }) };
  const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'wk' } }]);
  const env = { RESEND_API_KEY: 'K', MAIL_TO: 'me@example.com', DB: mockDB(docs) };
  const r = await sendWeeklyMail(env, { today: '2026-08-07', week: { start: '2026-08-03', end: '2026-08-09' }, done: 0, next: 0, late: 0 });
  const sent = JSON.parse(calls[0].opts.body);
  check('발송 성공', r.ok === true);
  check('첨부가 실린다', Array.isArray(sent.attachments) && sent.attachments.length === 2);
  check('본문에도 안내', sent.html.includes('이번 주 백업'));

  // DB 를 못 읽어도 리포트 자체는 나가야 한다
  const calls2 = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'wk2' } }]);
  const bad = { RESEND_API_KEY: 'K', MAIL_TO: 'me@example.com', DB: { prepare() { throw new Error('down'); } } };
  const r2 = await sendWeeklyMail(bad, { today: '2026-08-07', week: { start: 'a', end: 'b' }, done: 0, next: 0, late: 0 });
  check('백업이 실패해도 발송된다', r2.ok === true);
  check('첨부 없이 나간다', !JSON.parse(calls2[0].opts.body).attachments);
  check('안내 문구도 빠진다', !JSON.parse(calls2[0].opts.body).html.includes('이번 주 백업'));
}

section('주간 메일 발송 — 설정 없으면 건너뛴다');
{
  let called = 0;
  global.fetch = async () => { called++; return { ok: true, status: 200, async json() { return {}; } }; };
  const r = await sendWeeklyMail({}, { today: '2026-08-07', week: { start: 'a', end: 'b' }, done: 0, next: 0, late: 0 });
  check('건너뛴다', r.skipped === 'not_configured' && called === 0);
}

/* ---- 한가한 금요일 ----
   2026-08-03 발견: nothing_due 조기 반환이 주간 리포트보다 위에 있어서, 지연·오늘 마감·임박·
   일정이 모두 0인 금요일에는 주간 리포트가 통째로 빠졌다. 주간 리포트가 답하는 건 "오늘 뭘 하나"가
   아니라 "이번 주에 뭘 했나"라, 정작 여유 있어 돌아볼 만한 주에 안 오는 셈이었다.
   ⚠️ 요일에 의존하는 테스트라 Date.now 를 고정한다(2026-08-07 = 금요일). */
const FRI_NOW = Date.UTC(2026, 7, 7, 3, 0, 0);   // KST 2026-08-07(금) 12:00
async function onFriday(fn) {
  const real = Date.now;
  Date.now = () => FRI_NOW;
  try { return await fn(); } finally { Date.now = real; }
}
const MAIL_ENV = { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', RESEND_API_KEY: 'K', MAIL_TO: 'me@example.com' };
const resendCalls = (calls) => calls.filter((c) => c.url.includes('api.resend.com'));

section('한가한 금요일에도 주간 리포트는 나간다');
{
  const { mockDB } = await import('./_helpers.mjs');
  await onFriday(async () => {
    const docs = { main: JSON.stringify({ todos: [], events: [], projects: [] }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'wk1' } }]);
    const env = Object.assign({ DB: mockDB(docs) }, MAIL_ENV);
    const ctx = () => ({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) });

    const b = await (await onRequestPost(ctx())).json();
    check('브리핑 자체는 건너뛴다', b.skipped === 'nothing_due');
    check('그래도 주간 리포트는 나갔다', b.weekly && b.weekly.ok === true);
    check('메일 1통', resendCalls(calls).length === 1);
    check('보낸 건 주간 리포트', JSON.parse(resendCalls(calls)[0].opts.body).subject.includes('주간 리포트'));

    // 08:10 재시도 — nothing_due 는 lastSentDay 를 세우지 않으므로 다시 들어온다
    const b2 = await (await onRequestPost(ctx())).json();
    check('재시도도 브리핑은 nothing_due', b2.skipped === 'nothing_due');
    check('주간 리포트는 두 번 안 간다', b2.weekly.skipped === 'already_sent_today');
    check('메일은 여전히 1통', resendCalls(calls).length === 1);
  });
}

section('주간 리포트는 금요일 하루 한 통 (수동 재발송에도)');
{
  const { mockDB } = await import('./_helpers.mjs');
  await onFriday(async () => {
    const docs = { main: JSON.stringify({ todos: [T({ id: 'x', dueDate: '2026-08-07' })], events: [], projects: [] }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'wk2' } }]);
    const env = Object.assign({ DB: mockDB(docs) }, MAIL_ENV);
    const ctx = (h) => ({ env, request: mockRequest(h) });

    const b = await (await onRequestPost(ctx({ 'X-Cron-Secret': 'CRONSEC' }))).json();
    check('브리핑 발송', b.ok === true && !b.skipped);
    check('주간 리포트도 함께', b.weekly.ok === true);
    check('브리핑 + 주간 = 2통', resendCalls(calls).length === 2);
    check('발송일 기록', JSON.parse(docs.daily).lastWeeklyDay === '2026-08-07');

    // 수동(Bearer)은 브리핑을 다시 보내지만 주간 리포트까지 두 번 가면 안 된다
    const b2 = await (await onRequestPost(ctx({ Authorization: 'Bearer pw' }))).json();
    check('수동 호출은 브리핑 재발송', b2.ok === true && b2.mail.ok === true);
    check('주간 리포트는 중복 안 됨', b2.weekly.skipped === 'already_sent_today');
    check('메일은 3통(브리핑 2 + 주간 1)', resendCalls(calls).length === 3);

    // ⚠️ recordAttempt 가 daily 문서를 통짜로 새로 쓰므로 가드 키가 지워지기 쉽다
    check('발송 이력을 남겨도 가드 키는 유지', JSON.parse(docs.daily).lastWeeklyDay === '2026-08-07');
    check('브리핑 발송일도 그대로', JSON.parse(docs.daily).lastSentDay === '2026-08-07');
  });
}

section('금요일이 아니면 주간 리포트는 안 간다');
{
  const { mockDB } = await import('./_helpers.mjs');
  const real = Date.now;
  Date.now = () => Date.UTC(2026, 7, 6, 3, 0, 0);   // KST 목요일
  try {
    const docs = { main: JSON.stringify({ todos: [T({ id: 'x', dueDate: '2026-08-06' })], events: [], projects: [] }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'th' } }]);
    const env = Object.assign({ DB: mockDB(docs) }, MAIL_ENV);
    const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('not_friday', b.weekly.skipped === 'not_friday');
    check('브리핑 1통만', resendCalls(calls).length === 1);
  } finally { Date.now = real; }
}
