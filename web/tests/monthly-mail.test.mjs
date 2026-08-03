// 월간 결산 메일 — 매월 1일 아침에 지난달을 정리해 보낸다.
// ⚠️ 지표 규칙은 앱의 computeWorkStats 와 같아야 한다(등록일 필드는 registeredDate).
//    화면과 메일이 다른 숫자를 말하면 둘 다 못 믿게 된다.
import { API, check, section, mockDB, mockRequest, mockFetch } from './_helpers.mjs';

const { computeMonthly, monthRangeKST } = await import(API + 'push/_send.js');
const { buildMonthlyMailBody, sendMonthlyMail } = await import(API + 'push/_mail.js');
const { onRequestPost } = await import(API + 'push/run-daily.js');

const T = (o) => Object.assign({ id: Math.random().toString(36).slice(2), text: '업무', channel: '엔터식스', status: '대기' }, o);
const envOf = (docs) => ({ DB: mockDB(docs) });

section('달 구간 계산');
{
  const cur = monthRangeKST('2026-08-03', 0);
  check('이번 달 1일', cur.start === '2026-08-01');
  check('이번 달 말일', cur.end === '2026-08-31');
  check('키는 YYYY-MM', cur.key === '2026-08');

  const prev = monthRangeKST('2026-08-01', -1);
  check('지난달 1일', prev.start === '2026-07-01');
  check('지난달 말일(30일)', prev.end === '2026-07-31');

  check('2월 말일(평년)', monthRangeKST('2026-03-01', -1).end === '2026-02-28');
  check('2월 말일(윤년)', monthRangeKST('2028-03-01', -1).end === '2028-02-29');
  check('1월 1일 → 작년 12월', monthRangeKST('2026-01-01', -1).key === '2025-12');
  check('12월 → 다음 달은 1월', monthRangeKST('2026-12-05', 1).key === '2027-01');
}

section('결산 집계');
{
  const docs = { main: JSON.stringify({
    projects: [{ id: 'p1', name: '정산' }, { id: 'p2', name: '영업' }],
    todos: [
      // 7월 완료 4건 (기한 준수 2 / 초과 1 / 마감일 없음 1)
      T({ id: 'd1', status: '완료', completedDate: '2026-07-10', dueDate: '2026-07-15', registeredDate: '2026-07-01', projectId: 'p1' }),
      T({ id: 'd2', status: '완료', completedDate: '2026-07-20', dueDate: '2026-07-20', registeredDate: '2026-07-10', projectId: 'p1' }),
      T({ id: 'd3', status: '지연완료', completedDate: '2026-07-25', dueDate: '2026-07-18', registeredDate: '2026-07-05', projectId: 'p2', channel: '쿠팡' }),
      T({ id: 'd4', status: '완료', completedDate: '2026-07-31', registeredDate: '2026-07-30', projectId: 'p2' }),
      // 8월 완료 → 지난달 결산에 들어가면 안 된다
      T({ id: 'x1', status: '완료', completedDate: '2026-08-02', dueDate: '2026-08-01' }),
      // 6월 완료 → 역시 제외
      T({ id: 'x2', status: '완료', completedDate: '2026-06-30' }),
      // 7월 말까지 마감인데 아직 미완료 → 넘어온 짐
      T({ id: 'c1', dueDate: '2026-07-02' }),
      T({ id: 'c2', dueDate: '2026-07-28', status: '진행중' }),
      // 8월 마감 미완료 → 넘어온 짐 아님
      T({ id: 'n1', dueDate: '2026-08-20' }),
    ],
  }) };

  const m = await computeMonthly(envOf(docs), '2026-08-01');
  check('대상은 지난달', m.month.key === '2026-07');
  check('완료 4건', m.done === 4);
  check('8월 완료는 안 센다', !m.doneList.some((t) => t.id === 'x1'));
  check('6월 완료도 안 센다', !m.doneList.some((t) => t.id === 'x2'));
  check('완료 목록은 완료일 순', m.doneList.map((t) => t.id).join(',') === 'd1,d2,d3,d4');
  check('넘어온 일 2건', m.carried === 2);
  check('다음 달 마감은 넘어온 일이 아님', !m.carriedList.some((t) => t.id === 'n1'));
  check('넘어온 일은 마감일 순', m.carriedList.map((t) => t.id).join(',') === 'c1,c2');

  check('기한 준수 판정 기준은 마감일 있는 완료 건', m.onTimeBase === 3);
  check('기한 준수율 67%', m.onTimeRate === 67);          // d1·d2 준수, d3 초과
  check('평균 소요일', m.avgLead === 10);                  // (9 + 10 + 20 + 1) / 4

  const proj = (n) => (m.byProject.find((r) => r.name === n) || {}).count;
  check('대분류별 집계 — 정산 2건', proj('정산') === 2);
  check('대분류는 id 가 아니라 이름으로', proj('영업') === 2);
  check('건수가 같으면 이름순', m.byProject.map((r) => r.name).join(',') === '영업,정산');
  check('중분류별 집계', m.byChannel.find((r) => r.name === '엔터식스').count === 3);
  check('중분류 쿠팡 1건', m.byChannel.find((r) => r.name === '쿠팡').count === 1);
}

section('빈 달·결측 데이터');
{
  const empty = await computeMonthly(envOf({ main: JSON.stringify({ todos: [] }) }), '2026-08-01');
  check('완료 0', empty.done === 0);
  check('넘어온 일 0', empty.carried === 0);
  check('판정 대상이 없으면 준수율 없음', empty.onTimeRate === null);
  check('소요일도 없음', empty.avgLead === null);

  const odd = await computeMonthly(envOf({ main: JSON.stringify({ todos: [
    T({ status: '완료', completedDate: '2026-07-05' }),                                   // 등록일 없음
    T({ status: '완료', completedDate: '2026-07-05', registeredDate: '2026-07-20' }),      // 역전
    T({ status: '완료', completedDate: '', dueDate: '2026-07-01' }),                       // 완료일 없음
  ] }) }), '2026-08-01');
  check('완료일 없는 완료 건은 제외', odd.done === 2);
  check('등록일 없거나 역전된 건은 소요일에서 제외', odd.avgLead === null);
  check('분류 없으면 (미지정)', odd.byProject[0].name === '(미지정)');

  const broken = await computeMonthly(envOf({}), '2026-08-01');
  check('문서가 없어도 안전', broken.done === 0 && broken.carried === 0);
}

section('메일 본문');
{
  const m = {
    today: '2026-08-01', month: { start: '2026-07-01', end: '2026-07-31', key: '2026-07' },
    done: 12, carried: 3, onTimeRate: 75, onTimeBase: 8, avgLead: 6.4,
    byProject: [{ name: '정산', count: 7 }, { name: '영업', count: 5 }],
    byChannel: [{ name: '엔터식스', count: 9 }],
    doneList: [T({ id: 'a', text: '[중요] 7월 정산 마감', completedDate: '2026-07-10', subChannel: '운영' })],
    carriedList: [T({ id: 'b', text: '넘어온 업무', dueDate: '2026-07-02' })],
  };
  const out = buildMonthlyMailBody(m);

  check('제목에 달과 건수', out.subject === '[SCLM] 2026년 07월 결산 · 완료 12 · 넘어온 일 3');
  check('기간 표시', out.html.includes('2026-07-01') && out.html.includes('2026-07-31'));
  check('완료 수치', out.html.includes('12건'));
  check('기한 준수율과 기준 건수', out.html.includes('75%') && out.html.includes('8건 기준'));
  check('평균 소요', out.html.includes('6.4일'));
  check('넘어온 일', out.html.includes('3건'));
  check('대분류 막대', out.html.includes('정산') && out.html.includes('width:71%'));   // 5/7
  check('중분류 절', out.html.includes('중분류별 완료'));
  check('꼬리표 제목의 [대괄호]는 뗀다', out.html.includes('7월 정산 마감') && !out.html.includes('[중요]'));
  check('항목에 딥링크', out.html.includes('?todo=a'));
  check('평문본도 만들어진다', out.text.includes('2026년 07월 결산') && out.text.includes('[지난달 완료]'));
  check('평문본이 통째로 날아가지 않는다', out.text.length > 120 && out.text.includes('[대분류별 완료]'));

  const zero = buildMonthlyMailBody(Object.assign({}, m, {
    done: 0, carried: 0, onTimeRate: null, avgLead: null, onTimeBase: 0,
    doneList: [], carriedList: [], byProject: [], byChannel: [] }));
  check('비어도 죽지 않는다', !!zero.html);
  check('값이 없으면 — 로 표시', zero.html.includes('—'));
  check('빈 목록은 없음으로', zero.html.includes('없음'));
}

section('발송은 매월 1일에만');
{
  const state = JSON.stringify({ todos: [T({ id: 'z', dueDate: '2026-08-01' })], events: [], projects: [] });
  const MAIL = { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', RESEND_API_KEY: 'K', MAIL_TO: 'me@example.com' };
  const real = Date.now;

  // 8월 1일 (토) — 주간 리포트 요일이 아니면서 월간만 나가는 날
  Date.now = () => Date.UTC(2026, 7, 1, 3, 0, 0);
  try {
    const docs = { main: state };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'mo' } }]);
    const env = Object.assign({ DB: mockDB(docs) }, MAIL);
    const ctx = (h) => ({ env, request: mockRequest(h) });

    const b = await (await onRequestPost(ctx({ 'X-Cron-Secret': 'CRONSEC' }))).json();
    check('월간 결산 발송', b.monthly.ok === true);
    const subjects = calls.filter((c) => c.url.includes('resend')).map((c) => JSON.parse(c.opts.body).subject);
    check('브리핑 + 월간 2통', subjects.length === 2);
    check('결산 제목', subjects.some((s) => s.includes('결산')));
    check('발송일 기록', JSON.parse(docs.daily).lastMonthlyDay === '2026-08-01');

    // 재시도(수동) — 브리핑은 다시 가도 결산은 한 통
    const b2 = await (await onRequestPost(ctx({ Authorization: 'Bearer pw' }))).json();
    check('결산은 중복 안 됨', b2.monthly.skipped === 'already_sent_today');
    check('결산 메일은 여전히 1통', calls.filter((c) => c.url.includes('resend')
      && JSON.parse(c.opts.body).subject.includes('결산')).length === 1);
    check('브리핑 발송일 기록도 유지', JSON.parse(docs.daily).lastSentDay === '2026-08-01');
  } finally { Date.now = real; }

  // 1일이 아니면 안 나간다
  Date.now = () => Date.UTC(2026, 7, 2, 3, 0, 0);
  try {
    const docs = { main: state };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'x' } }]);
    const b = await (await onRequestPost({ env: Object.assign({ DB: mockDB(docs) }, MAIL),
      request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('1일이 아니면 건너뛴다', b.monthly.skipped === 'not_first_day');
    check('브리핑 1통만', calls.filter((c) => c.url.includes('resend')).length === 1);
  } finally { Date.now = real; }
}

section('한가한 1일에도 결산은 나간다');
{
  const real = Date.now;
  Date.now = () => Date.UTC(2026, 7, 1, 3, 0, 0);
  try {
    const docs = { main: JSON.stringify({ todos: [], events: [], projects: [] }) };
    const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'mo' } }]);
    const env = { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', RESEND_API_KEY: 'K', MAIL_TO: 'me@example.com', DB: mockDB(docs) };
    const b = await (await onRequestPost({ env, request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' }) })).json();
    check('브리핑은 건너뛴다', b.skipped === 'nothing_due');
    check('그래도 결산은 나갔다', b.monthly.ok === true);
    check('메일 1통(결산만)', calls.filter((c) => c.url.includes('resend')).length === 1);
  } finally { Date.now = real; }
}

section('설정이 없으면 조용히 건너뛴다');
{
  let called = 0;
  global.fetch = async () => { called++; return { ok: true, status: 200, async json() { return {}; } }; };
  const r = await sendMonthlyMail({}, { today: '2026-08-01', month: { start: 'a', end: 'b', key: '2026-07' },
    done: 0, carried: 0, onTimeRate: null, avgLead: null, doneList: [], carriedList: [] });
  check('건너뛴다', r.skipped === 'not_configured' && called === 0);
}
