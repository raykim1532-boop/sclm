// 표에서 마감일 빠르게 옮기기 — 날짜 계산과 실제 클릭 동작을 함께 본다.
// 배경: 마감일을 바꾸려면 행을 열고→날짜 고르고→저장해야 해서 아무도 안 옮겼다
//       (2026-08-03 기준 61건 중 0건). 지연 건수가 실제보다 부풀고 마감일이 신호를 잃었다.
import { check, section } from './_helpers.mjs';
import { readFileSync } from 'node:fs';
import { bootApp, $, $$, click, tick } from './_dom.mjs';

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const day = (n) => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let seq = 0;
const T = (o) => Object.assign({
  id: 't' + (++seq), no: seq, text: '업무 ' + seq, projectId: 'p1', channel: '마리오', subChannel: '',
  priority: '', assignee: '', registeredDate: day(-10), dueDate: day(-3), status: '진행중',
  needsCheck: '', completedDate: '', progress: '', remarks: '', links: [], files: []
}, o);

function boot(todos) {
  const env = bootApp();
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }],
    todos, events: [], channels: ['마리오'], subMaster: [], settings: {},
  });
  env.app.renderTodos();
  return env;
}

section('다음 주 월요일 계산');
{
  const env = bootApp();
  const nm = env.app.nextMonday;
  // 2026-08-03 은 월요일
  check('월요일이면 다음 주 월요일', nm('2026-08-03') === '2026-08-10');
  check('화요일 → 그 주 월요일이 아니라 다음 월요일', nm('2026-08-04') === '2026-08-10');
  check('일요일 → 바로 다음 날', nm('2026-08-09') === '2026-08-10');
  check('토요일', nm('2026-08-08') === '2026-08-10');
  check('달을 넘어가도', nm('2026-08-31') === '2026-09-07');
}

section('메뉴 항목이 계산하는 날짜');
{
  const env = bootApp();
  const by = (k) => env.app.DUE_MOVES.find((m) => m.key === k);
  check('메뉴 4개', env.app.DUE_MOVES.length === 4);
  check('오늘', by('today').calc('2026-07-20', '2026-08-03') === '2026-08-03');
  check('내일', by('tomorrow').calc('2026-07-20', '2026-08-03') === '2026-08-04');
  check('다음 주 월요일', by('nextmon').calc('2026-07-20', '2026-08-03') === '2026-08-10');
  check('일주일 미루기는 현재 마감일 기준', by('plus7').calc('2026-07-20', '2026-08-03') === '2026-07-27');
  check('마감일이 없으면 오늘 기준', by('plus7').calc('', '2026-08-03') === '2026-08-10');
}

section('표에서 버튼을 눌러 메뉴가 열린다');
{
  seq = 0;
  const env = boot([T({}), T({})]);
  check('행마다 버튼이 있다', $$(env.document, '#todoTableBody .due-move').length === 2);

  click($(env.document, '#todoTableBody .due-move'));
  await tick();
  const menu = $(env.document, '.due-menu');
  check('메뉴가 열린다', !!menu);
  check('항목 5개(빠른 4 + 직접 고르기)', $$(menu, 'button').length === 5);
  check('각 항목에 날짜가 미리 보인다', menu.textContent.includes('/'));
  check('직접 고르기 항목', menu.textContent.includes('직접 고르기'));

  env.app.closeDueMenu();
  check('닫으면 사라진다', !$(env.document, '.due-menu'));
}

section('마감일 버튼이 편집 화면을 열지 않는다');
{
  seq = 0;
  const env = boot([T({})]);
  const row = $(env.document, '#todoTableBody tr');
  click($(row, '.due-move'));
  await tick();
  check('편집 모달은 안 열린다', $(env.document, '#modalOverlay').classList.contains('hidden'));
  check('대신 메뉴가 열린다', !!$(env.document, '.due-menu'));
  env.app.closeDueMenu();

  // 행의 다른 곳을 누르면 편집이 열린다
  click($(row, '.col-title'));
  await tick();
  check('행 클릭은 그대로 편집', !$(env.document, '#modalOverlay').classList.contains('hidden'));
  env.app.closeModal();
}

section('뒤로 밀면 이력과 배지가 생긴다');
{
  seq = 0;
  const todo = T({ dueDate: day(-3) });
  const env = boot([todo]);
  const before = todo.dueDate;

  // ⚠️ 지연된 건을 "오늘"로 옮기는 것도 **뒤로 미는 것**이다(3일 전 → 오늘).
  const ok = await env.app.moveDueDate(todo, TODAY);
  check('옮겨졌다', ok === true && todo.dueDate === TODAY);
  check('이력이 남는다', env.app.todoDueHistory(todo).length === 1);
  check('from/to 가 맞다', todo.dueHistory[0].from === before && todo.dueHistory[0].to === TODAY);
  check('저장까지 갔다', env.saves.length >= 1);
  check('밀림 1회로 잡힌다', env.app.dueMoveCount(todo) === 1);
  check('배지가 표에 그려진다', $(env.document, '#todoTableBody .due-moved') !== null);

  await env.app.moveDueDate(todo, day(7));
  check('또 밀면 2회', env.app.dueMoveCount(todo) === 2);
  check('이력도 2건', env.app.todoDueHistory(todo).length === 2);
}

section('앞당긴 건 밀림으로 세지 않는다');
{
  seq = 0;
  const todo = T({ dueDate: day(7) });
  const env = boot([todo]);
  await env.app.moveDueDate(todo, TODAY);   // 일주일 뒤 → 오늘 (앞당김)
  check('마감일은 바뀐다', todo.dueDate === TODAY);
  check('이력에는 남는다', env.app.todoDueHistory(todo).length === 1);
  check('밀림 0회', env.app.dueMoveCount(todo) === 0);
  check('배지도 안 뜬다', env.app.dueBadgeHtml(todo) === '');
}

section('메뉴에서 눌러 옮기기');
{
  seq = 0;
  const todo = T({ dueDate: day(-3) });
  const env = boot([todo]);
  click($(env.document, '#todoTableBody .due-move'));
  await tick();

  const btns = $$(env.document, '.due-menu button');
  const todayBtn = btns.find((b) => b.textContent.startsWith('오늘'));
  click(todayBtn);
  await tick(40);

  check('오늘로 옮겨졌다', todo.dueDate === TODAY);
  check('메뉴가 닫힌다', !$(env.document, '.due-menu'));
  check('표가 다시 그려진다', $(env.document, '#todoTableBody .col-due').textContent.includes(TODAY));
}

section('같은 날짜를 고르면 아무 일도 안 한다');
{
  seq = 0;
  const todo = T({ dueDate: TODAY });
  const env = boot([todo]);
  const ok = await env.app.moveDueDate(todo, TODAY);
  check('false 를 돌려준다', ok === false);
  check('이력이 안 생긴다', env.app.todoDueHistory(todo).length === 0);
  check('저장도 안 한다', env.saves.length === 0);

  check('잘못된 날짜도 무시', (await env.app.moveDueDate(todo, 'abc')) === false);
}

section('마감일이 없던 건에 처음 넣는 건 이력에 안 남는다');
{
  seq = 0;
  const todo = T({ dueDate: '' });
  const env = boot([todo]);
  await env.app.moveDueDate(todo, TODAY);
  check('마감일은 들어간다', todo.dueDate === TODAY);
  check('이력은 안 남는다', env.app.todoDueHistory(todo).length === 0);
  check('배지도 없다', env.app.dueBadgeHtml(todo) === '');
}

section('버튼이 평소에도 보인다');
{
  // 회귀 방지: opacity 0 으로 두면 없는 것과 구분이 안 돼 아무도 안 쓴다(실제로 9일간 0회).
  // linkedom 은 스타일 계산을 안 하므로 CSS 원문을 본다.
  const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');
  const block = (css.match(/\.due-move \{[^}]*\}/) || [''])[0];
  const base = parseFloat((block.match(/opacity:\s*([\d.]+)/) || [0, 0])[1]);
  const hover = parseFloat((css.match(/tbody tr:hover \.due-move \{ opacity:\s*([\d.]+)/) || [0, 0])[1]);

  check('기본 opacity 가 0 이 아니다', base > 0, '기본 ' + base);
  check('평소에도 보일 만큼은 된다', base >= 0.25, '기본 ' + base);
  check('행에 올리면 더 또렷해진다', hover > base, 'hover ' + hover + ' > 기본 ' + base);
}
