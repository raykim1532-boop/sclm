// 캘린더 배선 — FullCalendar 자체가 아니라 **앱이 넘기는 것과 받아 처리하는 것**을 본다.
// 가짜 FullCalendar(_dom.mjs)가 옵션을 붙잡아 두고 콜백을 발사해 준다.
//
// ⚠️ 이 파일이 필요한 이유: 캘린더는 여태 하네스에서 통째로 가짜였다(render/refetch만 있는 빈 껍데기).
//    그래서 "종일 일정의 end 는 +1일" 같은 규칙이나 클릭 라우팅이 깨져도 테스트가 조용했다.
//    실제로 여러 날 일정의 마지막 날이 화면에서 빠지는 부류의 버그가 이 규칙에서 나온다.
import { check, section } from './_helpers.mjs';
import { bootApp } from './_dom.mjs';

const P = [
  { id: 'p1', name: '정산', color: '#1a73e8' },
  { id: 'p2', name: '영업', color: '#8e24aa' }
];

function boot(state) {
  const env = bootApp();
  env.app.setState(Object.assign({
    settings: {}, projects: P, channels: [], subMaster: [], events: [], todos: [], tasks: []
  }, state));
  env.app.setupCalendar();
  return env;
}
const byId = (arr, id) => arr.filter((x) => x.id === id)[0];

section('캘린더 생성·배선');
{
  const env = boot({});
  const cal = env.calendars[0];
  check('캘린더가 만들어짐', !!cal);
  check('render() 호출됨', cal.renders === 1);
  check('#calendar 요소에 붙음', cal.el && cal.el.id === 'calendar');
  check('월 뷰로 시작', cal.opts.initialView === 'dayGridMonth');
  check('한국어 로케일', cal.opts.locale === 'ko');
  check('24시간 표기', cal.opts.eventTimeFormat && cal.opts.eventTimeFormat.hour12 === false);
  check('날짜 클릭 핸들러 있음', typeof cal.opts.dateClick === 'function');
  check('일정 클릭 핸들러 있음', typeof cal.opts.eventClick === 'function');

  env.app.refreshCalendarEvents();
  check('refreshCalendarEvents() → refetchEvents 호출', cal.refetches === 1);
}

section('종일 일정 매핑');
{
  const env = boot({ events: [
    { id: 'e1', title: '하루 일정', start: '2026-08-03', end: '', allDay: true, projectId: 'p1' },
    { id: 'e2', title: '3일짜리', start: '2026-08-10', end: '2026-08-12', allDay: true, projectId: 'p1' }
  ] });
  const evs = env.calendars[0].events();
  const one = byId(evs, 'ev-e1'), many = byId(evs, 'ev-e2');

  check('id에 ev- 접두', !!one && !!many);
  check('종일 플래그', one.allDay === true);
  check('하루 일정은 end 없음', one.end === undefined);
  // FullCalendar 의 end 는 '포함하지 않는' 경계다. +1 을 안 하면 마지막 날이 화면에서 빠진다.
  check('여러 날 일정은 end = 마지막날 +1', many.end === '2026-08-13');
  check('시작일은 그대로', many.start === '2026-08-10');
  check('대분류 색을 씀', one.color === '#1a73e8');
}

section('시간 지정 일정 매핑');
{
  const env = boot({ events: [
    { id: 'e3', title: '미팅', start: '2026-08-05', end: '', allDay: false, startTime: '14:00', endTime: '15:30', projectId: 'p2' },
    { id: 'e4', title: '종료없는 미팅', start: '2026-08-06', end: '', allDay: false, startTime: '09:00', endTime: '', projectId: 'p2' }
  ] });
  const evs = env.calendars[0].events();
  const m = byId(evs, 'ev-e3'), n = byId(evs, 'ev-e4');

  check('allDay false', m.allDay === false);
  check('시작이 날짜+시간 ISO', m.start === '2026-08-05T14:00:00');
  check('종료도 날짜+시간 ISO', m.end === '2026-08-05T15:30:00');
  check('종료시간 없으면 end 없음', n.end === undefined);
  check('대분류 색', m.color === '#8e24aa');
}

section('색상 우선순위');
{
  const env = boot({ events: [
    { id: 'c1', title: '직접 지정', start: '2026-08-01', allDay: true, projectId: 'p1', color: '#ff0000' },
    { id: 'c2', title: '읽기전용 가져옴', start: '2026-08-01', allDay: true, projectId: 'p1', roCal: 'other@group' },
    { id: 'g12345', title: '구글에서 온 것', start: '2026-08-01', allDay: true, projectId: 'p1', source: 'google', googleId: 'gg1' },
    { id: 'c3', title: '기본', start: '2026-08-01', allDay: true, projectId: 'p2' }
  ] });
  const evs = env.calendars[0].events();
  const col = (id) => byId(evs, 'ev-' + id).color;

  check('지정 색이 최우선', col('c1') === '#ff0000');
  check('읽기 전용은 회색', col('c2') === '#8a8f98');
  check('구글 가져온 일정은 파랑', col('g12345') === '#4285F4');
  check('그 외는 대분류 색', col('c3') === '#8e24aa');
}

section('할 일이 마감일에 표시된다');
{
  const env = boot({ todos: [
    { id: 't1', text: '정산 마감', projectId: 'p1', channel: '엔터식스', dueDate: '2026-08-07', status: '대기' },
    { id: 't2', text: '완료된 것', projectId: 'p1', channel: '', dueDate: '2026-08-08', status: '완료', done: true },
    { id: 't3', text: '마감일 없음', projectId: 'p1', channel: '', dueDate: '', status: '대기' }
  ] });
  const evs = env.calendars[0].events();
  const a = byId(evs, 'td-t1'), b = byId(evs, 'td-t2');

  check('id에 td- 접두', !!a);
  check('마감일이 시작일', a.start === '2026-08-07');
  check('할 일은 종일로', a.allDay === true);
  check('제목에 중분류가 붙음', a.title.indexOf('[엔터식스]') >= 0 && a.title.indexOf('정산 마감') >= 0);
  check('미완료는 대분류 색', a.color === '#1a73e8');
  check('완료는 회색', b.color === '#9698b8');
  check('마감일 없는 할 일은 캘린더에 안 나옴', !byId(evs, 'td-t3'));
}

section('클릭 라우팅');
{
  const env = boot({
    events: [
      { id: 'e9', title: '내 일정', start: '2026-08-09', allDay: true, projectId: 'p1' },
      { id: 'e8', title: '남의 캘린더', start: '2026-08-09', allDay: true, projectId: 'p1', roCal: 'other@group' }
    ],
    todos: [{ id: 't9', text: '할 일 클릭', projectId: 'p1', channel: '', dueDate: '2026-08-09', status: '대기' }]
  });
  const cal = env.calendars[0];
  const doc = env.document;
  const modalTitle = () => { const el = doc.querySelector('#modalTitle, .modal-title, .modal h2'); return el ? el.textContent.trim() : ''; };
  const closeAll = () => { try { env.app.closeModal(); } catch (e) {} };

  // 빈 날짜 클릭 → 그 날짜로 새 일정 모달
  cal.fire('dateClick', { dateStr: '2026-08-20' });
  const startInput = doc.querySelector('#f-start');
  check('날짜 클릭 → 새 일정 모달', !!startInput);
  check('클릭한 날짜가 채워짐', startInput && startInput.getAttribute('value') === '2026-08-20');
  closeAll();

  // 내 일정 클릭 → 편집 모달(제목 입력칸이 있다)
  cal.fire('eventClick', { event: { id: 'ev-e9' } });
  const titleInput = doc.querySelector('#f-title');
  check('내 일정 클릭 → 편집 모달', !!titleInput);
  check('제목이 실려 옴', titleInput && titleInput.getAttribute('value') === '내 일정');
  closeAll();

  // 읽기 전용 일정 클릭 → 보기 전용(입력칸이 없어야 한다)
  cal.fire('eventClick', { event: { id: 'ev-e8' } });
  check('읽기 전용은 편집칸이 없다', !doc.querySelector('#f-title'));
  check('읽기 전용 모달이 떴다', modalTitle().length > 0);
  closeAll();

  // 할 일 클릭 → 할 일 모달 (업무내용 칸 + 마감일이 실려 있어야 한다)
  cal.fire('eventClick', { event: { id: 'td-t9' } });
  const textInput = doc.querySelector('#f-text');
  check('할 일 클릭 → 할 일 모달', !!textInput);
  check('업무내용이 실려 옴', textInput && textInput.getAttribute('value') === '할 일 클릭');
  check('마감일도 실려 옴', (doc.querySelector('#f-due') || {}).getAttribute && doc.querySelector('#f-due').getAttribute('value') === '2026-08-09');
  closeAll();
}

section('없는 항목을 눌러도 죽지 않는다');
{
  const env = boot({ events: [], todos: [] });
  const cal = env.calendars[0];
  let ok = true;
  try {
    cal.fire('eventClick', { event: { id: 'ev-nope' } });
    cal.fire('eventClick', { event: { id: 'td-nope' } });
  } catch (e) { ok = false; }
  check('삭제된 일정/할 일 클릭에도 예외 없음', ok);
}
