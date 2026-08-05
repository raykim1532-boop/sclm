// 보류(⏸)는 지연으로 세지 않는다 — 화면·아침 브리핑·리포트 전부.
//
// 배경(2026-08-05): "지금은 안 한다"고 결정해 보류로 바꿔도 마감일이 지났으면 계속 지연으로
// 세어졌다. 결정을 내렸는데도 매일 아침 잔소리를 들으면 지연 숫자 자체가 신호를 잃는다.
// 대신 조용히 사라지지도 않게 대시보드에 "보류" 칸을 따로 뒀다.
// ⚠️ 앱(todoIsHeld/todoIsLive)과 서버(_send.js 의 isHeld/isLive)가 같은 규칙이어야 한다 —
//    화면 숫자와 메일 숫자가 어긋나면 둘 다 못 믿게 된다.
import { readFileSync } from 'node:fs';
import { check, section, API, mockDB } from './_helpers.mjs';
import { bootApp, $, $$, click, tick } from './_dom.mjs';

const src = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('함수 추출 실패: ' + name); return m[0]; };
const computeWorkStats = new Function(grab(/function computeWorkStats\([\s\S]*?\n}/, 'computeWorkStats') + '; return computeWorkStats;')();
const computeStuckTaxo = new Function(grab(/function computeStuckTaxo\([\s\S]*?\n}/, 'computeStuckTaxo') + '; return computeStuckTaxo;')();

const TODAY = '2026-08-05';
let seq = 0;
const T = (o) => Object.assign({
  id: 't' + (++seq), no: seq, text: '업무 ' + seq, projectId: 'p1', channel: '마리오',
  registeredDate: '2026-07-01', dueDate: '2026-07-30', status: '진행중', links: [], files: [],
}, o);

/* ---------- 순수 함수 ---------- */

section('처리 지표 — 보류는 지연에서 뺀다');
{
  seq = 0;
  const base = [T({ dueDate: '2026-07-30' }), T({ dueDate: '2026-07-31' })];
  check('진행중 2건은 지연 2건', computeWorkStats(base, TODAY).overdueCount === 2);

  const held = [T({ dueDate: '2026-07-30' }), T({ dueDate: '2026-07-31', status: '보류' })];
  const s = computeWorkStats(held, TODAY);
  check('하나를 보류로 바꾸면 지연 1건', s.overdueCount === 1);
  check('평균 지연일도 보류를 뺀 값', s.avgLate === 6);   // 07-30 → 08-05

  const allHeld = [T({ status: '보류' }), T({ status: '보류' })];
  check('전부 보류면 지연 0건', computeWorkStats(allHeld, TODAY).overdueCount === 0);
  check('지연이 없으면 평균도 null', computeWorkStats(allHeld, TODAY).avgLate === null);
}

section('밀리는 분류 — 보류는 지연으로 안 센다');
{
  seq = 0;
  const AX = [{ label: '중분류', pick: (t) => t.channel }];
  const mk = (st) => T({ channel: '마리오', status: st, dueDate: '2026-07-30' });

  const stuck = computeStuckTaxo([mk('진행중'), mk('진행중'), mk('대기')], AX, TODAY, 3, 5);
  check('지연 3건이면 카드가 뜬다', stuck.length === 1 && stuck[0].overdue === 3);

  // 2건을 보류로 돌리면 지연 1건 → 기준(2건) 미달로 카드가 사라져야 한다
  const calmed = computeStuckTaxo([mk('진행중'), mk('보류'), mk('보류')], AX, TODAY, 3, 5);
  check('보류로 돌리면 카드가 사라진다', calmed.length === 0);

  // 표본(total)에는 남는다 — 보류도 그 분류의 업무이긴 하다
  const half = computeStuckTaxo([mk('진행중'), mk('진행중'), mk('보류')], AX, TODAY, 3, 5);
  check('표본 3건은 유지', half.length === 1 && half[0].total === 3);
  check('지연만 2건으로 준다', half[0].overdue === 2);
}

/* ---------- 화면 ---------- */

function bootDash(todos) {
  const env = bootApp();
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }],
    todos, events: [], channels: ['마리오'], subMaster: [], settings: {},
  });
  env.app.renderDashboard();
  return env;
}
const card = (doc, title) =>
  $$(doc, '#dashboardGrid .dash-card').find((c) => $(c, 'h3').textContent.includes(title));
const cardCount = (doc, title) => +$(card(doc, title), '.count').textContent;

section('대시보드 — 보류는 지연 칸에서 빠지고 보류 칸으로 간다');
{
  seq = 0;
  const env = bootDash([
    T({ dueDate: '2026-07-30' }),                    // 지연
    T({ dueDate: '2026-07-31', status: '보류' }),     // 보류(마감일은 지났다)
  ]);
  check('지연 1건', cardCount(env.document, '지연된 업무') === 1);
  check('보류 칸이 있다', !!card(env.document, '보류'));
  check('보류 1건', cardCount(env.document, '보류') === 1);
  check('보류 건이 지연 칸엔 없다', !card(env.document, '지연된 업무').textContent.includes('업무 2'));
  check('보류 칸에는 있다', card(env.document, '보류').textContent.includes('업무 2'));
  check('보류에도 마감일은 보인다', card(env.document, '보류').textContent.includes('2026-07-31'));
}

section('보류에는 📅 를 안 붙인다');
{
  seq = 0;
  const env = bootDash([T({ dueDate: '2026-07-31', status: '보류' })]);
  check('보류 칸에 📅 없음', $$(card(env.document, '보류'), '.due-move').length === 0);
  check('지연 칸은 비었다', cardCount(env.document, '지연된 업무') === 0);
}

section('보류는 오늘·이번 주 칸에도 안 뜬다');
{
  seq = 0;
  const env = bootDash([
    T({ dueDate: TODAY, status: '보류' }),
    T({ dueDate: '2026-08-08', status: '보류' }),
  ]);
  check('오늘 칸 0건', cardCount(env.document, '오늘') === 0);
  check('이번 주 칸 0건', cardCount(env.document, '이번 주') === 0);
  check('보류 칸 2건', cardCount(env.document, '보류') === 2);
}

section('보류 칸에서도 눌러서 편집할 수 있다');
{
  seq = 0;
  const env = bootDash([T({ dueDate: '2026-07-31', status: '보류' })]);
  click($(card(env.document, '보류'), '.dash-item'));
  await tick();
  check('편집이 열린다', !$(env.document, '#modalOverlay').classList.contains('hidden'));
  env.app.closeModal();
}

section('보류를 풀면 다시 지연으로 돌아온다');
{
  seq = 0;
  const todo = T({ dueDate: '2026-07-30', status: '보류' });
  const env = bootDash([todo]);
  check('처음엔 보류', cardCount(env.document, '보류') === 1 && cardCount(env.document, '지연된 업무') === 0);
  todo.status = '진행중';
  env.app.renderDashboard();
  check('풀면 지연으로', cardCount(env.document, '지연된 업무') === 1);
  check('보류 칸은 빈다', cardCount(env.document, '보류') === 0);
}

section('업무 표 — 보류 행은 지연 색으로 칠하지 않는다');
{
  seq = 0;
  const env = bootApp();
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }],
    todos: [T({ dueDate: '2026-07-30' }), T({ dueDate: '2026-07-30', status: '보류' })],
    events: [], channels: ['마리오'], subMaster: [], settings: {},
  });
  env.app.renderTodos();
  const rows = $$(env.document, '#todoTableBody tr');
  check('행 2개', rows.length === 2);
  check('진행중 행은 지연 표시', rows[0].className.includes('row-overdue'));
  check('보류 행은 지연 표시 없음', !rows[1].className.includes('row-overdue'));
}

/* ---------- 서버(아침 브리핑·주간 리포트) ---------- */

section('아침 브리핑 — 보류는 지연에서 빠진다');
{
  const { computeSummary, computeStuckChannels } = await import(API + 'push/_send.js');
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const past = '2020-01-01';
  const docs = { main: JSON.stringify({ todos: [
    { id: 'a', text: '밀린 일', dueDate: past, status: '진행중' },
    { id: 'b', text: '보류한 일', dueDate: past, status: '보류' },
    { id: 'c', text: '오늘 일', dueDate: today, status: '보류' },
  ], events: [] }) };
  const s = await computeSummary({ DB: mockDB(docs) });
  check('지연 1건', s.overdue === 1);
  check('보류 건은 목록에 없다', !s.overdueList.some((t) => t.id === 'b'));
  check('오늘 마감도 보류면 안 센다', s.dueToday === 0);

  // 밀리는 분류 경고도 같은 규칙
  const mk = (id, st) => ({ id, text: 't' + id, channel: '마리오', dueDate: past, status: st });
  check('지연 3건이면 경고',
    computeStuckChannels([mk(1, '진행중'), mk(2, '진행중'), mk(3, '진행중')], today, 3, 5).length === 1);
  check('보류로 돌리면 경고가 사라진다',
    computeStuckChannels([mk(1, '진행중'), mk(2, '보류'), mk(3, '보류')], today, 3, 5).length === 0);
}

section('주간 리포트 — 아직 지연에 보류는 안 넣는다');
{
  const { computeWeekly } = await import(API + 'push/_send.js');
  const docs = { main: JSON.stringify({ todos: [
    { id: 'a', text: '밀린 일', dueDate: '2020-01-01', status: '진행중' },
    { id: 'b', text: '보류한 일', dueDate: '2020-01-01', status: '보류' },
  ], events: [] }) };
  const w = await computeWeekly({ DB: mockDB(docs) }, '2026-08-07');
  check('아직 지연 1건', w.late === 1);
  check('보류는 빠진다', !w.lateList.some((t) => t.id === 'b'));
}

section('앱과 서버가 같은 규칙을 쓴다');
{
  const server = readFileSync(new URL('../functions/api/push/_send.js', import.meta.url), 'utf8');
  check('앱에 todoIsHeld 가 있다', /function todoIsHeld\(t\) \{ return todoStatus\(t\) === '보류'; \}/.test(src));
  check('서버에 isHeld 가 있다', /function isHeld\(t\) \{ return \(t\.status \|\| ''\) === '보류'; \}/.test(server));
  check('둘 다 보류만 본다 — 완료/지연완료는 isDone 몫',
    !/todoIsHeld[\s\S]{0,80}완료/.test(src.slice(src.indexOf('function todoIsHeld'))));
}
