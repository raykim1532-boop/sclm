// 아침 브리핑의 '오늘 일정' — pickTodayEvents 집계 + run-daily 발송 판정.
// 회귀 방지: 일정만 있고 할 일이 하나도 없는 날에도 알림이 나가야 한다.
import { API, check, section, mockDB, mockRequest, mockFetch } from './_helpers.mjs';

const { pickTodayEvents, computeSummary } = await import(API + 'push/_send.js');
const { onRequestPost, buildPushBody } = await import(API + 'push/run-daily.js');

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const day = (n) => {
  const d = new Date(TODAY + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const E = (o) => Object.assign({ id: Math.random().toString(36).slice(2), title: '일정', allDay: true }, o);

section('오늘에 걸친 일정 고르기');
{
  const list = pickTodayEvents([
    E({ title: '어제', start: day(-1), end: day(-1) }),
    E({ title: '오늘', start: TODAY, end: TODAY }),
    E({ title: '내일', start: day(1), end: day(1) }),
    E({ title: '이번주 내내', start: day(-2), end: day(2) })
  ], TODAY);
  check('오늘 것만 남는다', list.length === 2);
  check('여러 날 걸친 일정도 포함', list.some((e) => e.title === '이번주 내내'));
  check('어제·내일은 빠진다', !list.some((e) => e.title === '어제' || e.title === '내일'));

  check('end 없으면 start 하루짜리로 본다', pickTodayEvents([E({ title: 'x', start: TODAY })], TODAY).length === 1);
  check('start 없는 건 무시', pickTodayEvents([E({ title: 'x' })], TODAY).length === 0);
  check('배열이 아니어도 안전', pickTodayEvents(null, TODAY).length === 0);
}

section('정렬 — 종일이 위, 그다음 시간순');
{
  const list = pickTodayEvents([
    E({ title: '오후회의', start: TODAY, allDay: false, startTime: '14:00' }),
    E({ title: '종일B', start: TODAY }),
    E({ title: '주간회의', start: TODAY, allDay: false, startTime: '10:00' }),
    E({ title: '종일A', start: TODAY })
  ], TODAY);
  check('종일이 먼저', list.slice(0, 2).every((e) => e.title.startsWith('종일')));
  check('종일끼리는 제목순', list[0].title === '종일A');
  check('시간 지정은 이른 순', list[2].title === '주간회의' && list[3].title === '오후회의');
}

section('computeSummary 가 일정을 함께 돌려준다');
{
  const docs = {
    main: JSON.stringify({
      todos: [],
      events: [E({ title: '대표님 주간회의', start: TODAY, allDay: false, startTime: '10:00' })]
    })
  };
  const s = await computeSummary({ DB: mockDB(docs) });
  check('events 건수', s.events === 1);
  check('eventList 내용', s.eventList[0].title === '대표님 주간회의');
  check('할 일은 0', s.overdue === 0 && s.dueToday === 0 && s.upcoming === 0);

  const empty = await computeSummary({ DB: mockDB({ main: JSON.stringify({ todos: [] }) }) });
  check('events 키가 없어도 안전', empty.events === 0 && Array.isArray(empty.eventList));
}

section('일정만 있어도 알림이 나간다');
{
  const docs = {
    main: JSON.stringify({
      todos: [],   // 할 일 0건
      events: [E({ title: '주간회의', start: TODAY, allDay: false, startTime: '10:00' })]
    })
  };
  mockFetch([]);
  const r = await onRequestPost({
    env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', DB: mockDB(docs) },
    request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' })
  });
  const b = await r.json();
  check('nothing_due 로 건너뛰지 않는다', b.skipped !== 'nothing_due');
  check('요약에 일정 건수 포함', b.summary && b.summary.events === 1);
}

section('할 일도 일정도 없으면 조용');
{
  const docs = { main: JSON.stringify({ todos: [], events: [E({ title: '내일', start: day(1) })] }) };
  mockFetch([]);
  const r = await onRequestPost({
    env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', DB: mockDB(docs) },
    request: mockRequest({ 'X-Cron-Secret': 'CRONSEC' })
  });
  const b = await r.json();
  check('nothing_due 로 건너뛴다', b.skipped === 'nothing_due');
}

section('푸시 본문 — 구분별 3건 + 나머지는 접기');
{
  const T = (n, d) => ({ id: 't' + n, text: '업무 ' + n, dueDate: d, status: '대기' });
  const s1 = {
    overdue: 5, dueToday: 0, upcoming: 0, events: 2,
    overdueList: [T(1, day(-1)), T(2, day(-1)), T(3, day(-1)), T(4, day(-1)), T(5, day(-1))],
    todayList: [], upcomingList: [],
    eventList: [E({ title: '주간회의', start: TODAY, allDay: false, startTime: '10:00' }), E({ title: '휴일', start: TODAY })]
  };
  const b = buildPushBody(s1);
  check('머리줄에 일정 건수', b.split('\n')[0] === '지연 5 · 일정 2건');
  check('지연은 3건까지만', (b.match(/⏰/g) || []).length === 3);
  check('일정은 시간 표기', b.includes('🗓 10:00 주간회의'));
  check('종일 일정은 종일로', b.includes('🗓 종일 휴일'));
  check('접힌 건수는 2건(지연 5-3)', b.includes('외 2건'));
}

section('푸시 본문 — 길이 제한은 줄 단위로');
{
  const T = (n, d) => ({ id: 't' + n, text: '아주 길고 긴 업무 제목을 가진 항목 번호 ' + n, dueDate: d, status: '대기' });
  const s2 = {
    overdue: 3, dueToday: 3, upcoming: 3, events: 3,
    overdueList: [T(1, day(-1)), T(2, day(-1)), T(3, day(-1))],
    todayList: [T(4, TODAY), T(5, TODAY), T(6, TODAY)],
    upcomingList: [T(7, day(1)), T(8, day(1)), T(9, day(1))],
    eventList: [1, 2, 3].map((i) => E({ title: '아주 길고 긴 회의 이름 ' + i, start: TODAY, allDay: false, startTime: '0' + i + ':00' }))
  };
  const b = buildPushBody(s2);
  check('320자 이내', b.length <= 320);
  // 잘라내지 않은 전체 본문의 줄 집합에 남은 줄이 전부 들어 있어야 한다 = 토막 난 줄이 없다
  const allowed = new Set(buildPushBody(s2, 100000).split('\n'));
  check('남은 줄은 모두 원래 줄 그대로(토막 없음)', b.split('\n').every((l) => allowed.has(l) || /^외 \d+건$/.test(l)));
  check('덜어낸 만큼 외 N건으로 잡힌다', /외 \d+건$/.test(b));

  // 한도를 아주 좁히면 머리줄만 남고, 그래도 총건수는 보존된다
  const tiny = buildPushBody(s2, 40);
  check('좁은 한도에서도 잘림 없이 머리줄 유지', tiny.split('\n')[0] === '지연 3 · 오늘 3 · 임박 3 · 일정 3건');
  check('전부 접히면 외 12건', tiny.includes('외 12건'));
}

section('일정이 없으면 예전과 똑같이 동작');
{
  const s3 = {
    overdue: 1, dueToday: 0, upcoming: 0, events: 0,
    overdueList: [{ id: 'a', text: '밀린 일', dueDate: day(-1), status: '대기' }],
    todayList: [], upcomingList: [], eventList: []
  };
  const b = buildPushBody(s3);
  check('일정 표기 없음', !b.includes('일정') && !b.includes('🗓'));
  check('접을 게 없으면 외 N건도 없음', !b.includes('외 '));
}
