// 기간 연장(마감일 미루기)을 메일로 알리는 세 가지 (2026-08-05 요청).
//   1) 아침 브리핑·주간 목록 줄에 "⟳2 · 원래 07/30"
//   2) 금요일 주간 리포트에 "이번 주에 미룬 건" 절
//   3) 3회 넘게 미룬 건은 별도 경고 블록
//
// 배경: 📅 로 미루는 건 쉬워졌는데(8/5 하루에 8건), 미룬 사실이 어디에도 안 남아
//       "이거 몇 번째 미루는 거지?"를 앱을 열어야만 알 수 있었다.
// ⚠️ 미룬 횟수 규칙은 앱의 dueMoveCount 와 같아야 한다 — **뒤로 민 것만** 센다.
import { readFileSync } from 'node:fs';
import { check, section, API, mockDB } from './_helpers.mjs';

const {
  dueMoveCount, originalDue, lastDueMove, computeChronic, computeMovedIn, computeWeekly, computeSummary,
} = await import(API + 'push/_send.js');
const { buildMailBody, buildWeeklyMailBody } = await import(API + 'push/_mail.js');

const H = (from, to, at) => ({ from, to, at });
const T = (id, o) => Object.assign({ id, text: '업무 ' + id, channel: '마리오', status: '진행중' }, o);

section('미룬 횟수 — 뒤로 민 것만 센다');
{
  check('이력이 없으면 0', dueMoveCount(T('a')) === 0);
  check('뒤로 1회', dueMoveCount(T('a', { dueHistory: [H('2026-07-30', '2026-08-07', '2026-08-05')] })) === 1);
  check('앞당긴 건 안 센다', dueMoveCount(T('a', { dueHistory: [H('2026-08-07', '2026-07-30', '2026-07-25')] })) === 0);
  check('섞이면 뒤로 민 것만', dueMoveCount(T('a', {
    dueHistory: [H('2026-07-30', '2026-08-07', '2026-08-01'), H('2026-08-07', '2026-08-02', '2026-08-03'), H('2026-08-02', '2026-08-14', '2026-08-04')],
  })) === 2);
  check('망가진 이력은 무시', dueMoveCount(T('a', { dueHistory: [{ from: '', to: '' }, null] })) === 0);
  check('배열이 아니어도 안 죽는다', dueMoveCount(T('a', { dueHistory: 'x' })) === 0);
}

section('원래 마감일 · 마지막 이동');
{
  const t = T('a', { dueHistory: [H('2026-07-20', '2026-07-30', '2026-07-19'), H('2026-07-30', '2026-08-07', '2026-08-05')] });
  check('맨 처음 from 이 원래 날짜', originalDue(t) === '2026-07-20');
  check('마지막 이동은 최근 것', lastDueMove(t).to === '2026-08-07');
  check('이력이 없으면 빈 문자열', originalDue(T('b')) === '');
  check('이력이 없으면 null', lastDueMove(T('b')) === null);
}

section('세 번 넘게 미룬 건');
{
  const many = (n) => Array.from({ length: n }, (_, i) => H('2026-07-0' + (i + 1), '2026-07-0' + (i + 2), '2026-07-0' + (i + 1)));
  const list = [
    T('a', { dueHistory: many(4), dueDate: '2026-08-20' }),
    T('b', { dueHistory: many(3), dueDate: '2026-08-10' }),
    T('c', { dueHistory: many(2) }),                            // 2회 — 기준 미달
    T('d', { dueHistory: many(5), status: '완료' }),             // 끝난 건은 제외
    T('e', { dueHistory: many(5), status: '보류' }),             // 보류도 제외
  ];
  const out = computeChronic(list, 3, 5);
  check('3회 이상만 2건', out.length === 2);
  check('많이 미룬 순', out[0].todo.id === 'a' && out[0].moves === 4);
  check('2회는 빠진다', !out.some((c) => c.todo.id === 'c'));
  check('완료는 빠진다', !out.some((c) => c.todo.id === 'd'));
  check('보류도 빠진다', !out.some((c) => c.todo.id === 'e'));
  check('원래/지금 날짜를 담는다', out[1].from === '2026-07-01' && out[1].to === '2026-08-10');
  check('개수 제한이 먹는다', computeChronic(list, 3, 1).length === 1);
  check('기준을 올리면 준다', computeChronic(list, 5, 9).length === 0);
}

section('구간 안에 미룬 건');
{
  const list = [
    T('a', { dueHistory: [H('2026-07-30', '2026-08-07', '2026-08-05')] }),   // 이번 주
    T('b', { dueHistory: [H('2026-07-20', '2026-07-25', '2026-07-21')] }),   // 지난주 — 빠져야 한다
    T('c', { dueHistory: [H('2026-08-07', '2026-07-30', '2026-08-04')] }),   // 앞당김 — 빠져야 한다
    T('d', { dueHistory: [H('2026-08-01', '2026-08-05', '2026-08-03'), H('2026-08-05', '2026-08-12', '2026-08-06')] }),
  ];
  const out = computeMovedIn(list, '2026-08-03', '2026-08-09');
  check('이번 주 2건', out.length === 2);
  check('지난주는 빠진다', !out.some((m) => m.todo.id === 'b'));
  check('앞당긴 건 빠진다', !out.some((m) => m.todo.id === 'c'));

  const d = out.find((m) => m.todo.id === 'd');
  check('두 번 민 건도 한 줄로', d.times === 2);
  check('원래는 첫 from', d.from === '2026-08-01');
  check('지금은 마지막 to', d.to === '2026-08-12');
  check('민 날짜순 정렬', out[0].todo.id === 'a');
  check('구간 밖이면 빈 배열', computeMovedIn(list, '2026-09-01', '2026-09-07').length === 0);
}

/* ---------- 메일 본문 ---------- */

const BASE = {
  today: '2026-08-05', overdue: 0, dueToday: 0, upcoming: 0, events: 0,
  overdueList: [], todayList: [], upcomingList: [], eventList: [], stuckList: [], chronicList: [],
};

section('아침 브리핑 — 목록 줄에 ⟳ 가 붙는다');
{
  const m = buildMailBody(Object.assign({}, BASE, {
    overdue: 2,
    overdueList: [
      T('a', { text: '민 업무', dueDate: '2026-08-01', dueHistory: [H('2026-07-30', '2026-08-01', '2026-07-30')] }),
      T('b', { text: '안 민 업무', dueDate: '2026-08-02' }),
    ],
  }));
  check('민 건에 ⟳1', m.html.includes('⟳1'));
  check('원래 날짜도 보여 준다', m.html.includes('원래 07/30'));
  check('안 민 건엔 안 붙는다', (m.html.match(/⟳/g) || []).length === 1);
  check('평문에도 들어간다', m.text.includes('(⟳1 · 원래 07/30)'));
  check('두 건 다 나온다', m.html.includes('민 업무') && m.html.includes('안 민 업무'));
}

section('아침 브리핑 — 세 번 넘게 미룬 건 경고');
{
  const none = buildMailBody(BASE);
  check('없으면 블록도 없다', !none.html.includes('세 번 넘게 미룬 건'));

  const m = buildMailBody(Object.assign({}, BASE, {
    chronicList: [
      { todo: T('a', { text: '자꾸 미루는 일' }), moves: 4, from: '2026-06-30', to: '2026-08-20' },
    ],
  }));
  check('경고 블록이 뜬다', m.html.includes('세 번 넘게 미룬 건'));
  check('업무 이름', m.html.includes('자꾸 미루는 일'));
  check('횟수', m.html.includes('4회 미룸'));
  check('원래 → 지금', m.html.includes('원래 06/30') && m.html.includes('지금 08/20'));
  check('딥링크가 붙는다', m.html.includes('/?todo=a'));
  check('평문에도', m.text.includes('[세 번 넘게 미룬 건]') && m.text.includes('4회 미룸'));
  check('분류 경고와 색이 다르다', m.html.includes('#f4f0fb'));
}

section('주간 리포트 — 이번 주에 미룬 건 절');
{
  const w = {
    today: '2026-08-07',
    week: { start: '2026-08-03', end: '2026-08-09' },
    nextWeek: { start: '2026-08-10', end: '2026-08-16' },
    done: 0, next: 0, late: 0, doneList: [], nextList: [], lateList: [],
    moved: 2,
    movedList: [
      { todo: T('a', { text: '한 번 민 일' }), times: 1, from: '2026-07-30', to: '2026-08-07', at: '2026-08-05', totalMoves: 1 },
      { todo: T('b', { text: '자주 미루는 일' }), times: 1, from: '2026-07-31', to: '2026-08-10', at: '2026-08-05', totalMoves: 4 },
    ],
  };
  const m = buildWeeklyMailBody(w);
  check('절 제목', m.html.includes('이번 주에 미룬 건'));
  check('원래 → 지금', m.html.includes('07/30 → 08/07'));
  check('두 건 다', m.html.includes('한 번 민 일') && m.html.includes('자주 미루는 일'));
  check('누적 3회 이상은 표시', m.html.includes('누적 4회'));
  check('1회짜리엔 누적 표시 없음', !m.html.includes('누적 1회'));
  check('상단 요약에도 건수', m.html.includes('기간 연장 2'));
  check('평문에도', m.text.includes('[이번 주에 미룬 건]') && m.text.includes('07/30 → 08/07'));

  const empty = buildWeeklyMailBody(Object.assign({}, w, { moved: 0, movedList: [] }));
  check('없으면 없음으로', empty.html.includes('이번 주에 미룬 건') && empty.html.includes('없음'));
  check('상단 요약엔 안 쓴다', !empty.html.includes('기간 연장'));
}

/* ---------- 실제 계산과 연결 ---------- */

section('computeSummary 가 chronicList 를 담는다');
{
  const many = (n) => Array.from({ length: n }, (_, i) => H('2026-07-0' + (i + 1), '2026-07-0' + (i + 2), '2026-07-0' + (i + 1)));
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const docs = { main: JSON.stringify({ todos: [
    T('a', { dueDate: today, dueHistory: many(4) }),
    T('b', { dueDate: today, dueHistory: many(1) }),
  ], events: [] }) };
  const s = await computeSummary({ DB: mockDB(docs) });
  check('4회 민 건만 잡힌다', s.chronicList.length === 1 && s.chronicList[0].todo.id === 'a');
  check('오늘 마감 2건은 그대로', s.dueToday === 2);
}

section('computeWeekly 가 movedList 를 담는다');
{
  const docs = { main: JSON.stringify({ todos: [
    T('a', { dueDate: '2026-08-07', dueHistory: [H('2026-07-30', '2026-08-07', '2026-08-05')] }),
    T('b', { dueDate: '2026-08-07', dueHistory: [H('2026-07-20', '2026-07-25', '2026-07-21')] }),
  ], events: [] }) };
  const w = await computeWeekly({ DB: mockDB(docs) }, '2026-08-07');
  check('이번 주 1건', w.moved === 1 && w.movedList[0].todo.id === 'a');
  check('건수 필드도 있다', typeof w.moved === 'number');
}

section('앱과 서버가 같은 규칙으로 센다');
{
  const app = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
  const srv = readFileSync(new URL('../functions/api/push/_send.js', import.meta.url), 'utf8');
  const rule = /h\.from && h\.to && h\.to > h\.from/;
  check('앱이 뒤로 민 것만 센다', rule.test(app.slice(app.indexOf('function dueMoveCount'))));
  check('서버도 같은 조건', rule.test(srv.slice(srv.indexOf('export function dueMoveCount'))));
}
