// To-do List 표 — 렌더·필터·검색·정렬·일괄지정·CSV 를 실제 DOM 에서 확인한다.
// 수동 체크리스트로 돌리던 것들을 옮겨 온 것.
import { check, section } from './_helpers.mjs';
import { bootApp, $, $$, click, tick } from './_dom.mjs';

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const day = (n) => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let seq = 0;
const T = (o) => Object.assign({
  id: 't' + (++seq), no: seq, text: '업무 ' + seq, projectId: 'p1', channel: '마리오', subChannel: '패션플러스',
  priority: '보통', assignee: '김성철', registeredDate: day(-5), dueDate: day(1), status: '대기',
  needsCheck: '', completedDate: '', progress: '', remarks: '', links: [], files: []
}, o);

function boot(todos) {
  const env = bootApp();
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }, { id: 'p2', name: '정산', color: '#0f9d58' }],
    todos, events: [], channels: ['마리오', '사방넷'], subMaster: ['패션플러스', '하프클럽'], settings: {},
  });
  env.app.renderTodos();
  return env;
}
const rows = (doc) => $$(doc, '#todoTableBody tr');

section('표 렌더 — 건수와 행');
{
  seq = 0;
  const env = boot([T({}), T({ status: '완료', completedDate: day(-1) }), T({ channel: '사방넷' })]);
  check('3행이 그려진다', rows(env.document).length === 3);
  check('건수 표시', $(env.document, '#todoCount').textContent.includes('3'));
  check('중분류 칩이 보인다', $(env.document, '#todoTableBody').innerHTML.includes('마리오'));
  check('소분류 칸', $$(env.document, '#todoTableBody .col-sub')[0].textContent === '패션플러스');
}

section('표 렌더 — 마감일 ⟳ 배지와 진행사항 최신 로그');
{
  seq = 0;
  const env = boot([
    T({ dueHistory: [{ from: day(-3), to: day(1), at: day(-3) }, { from: day(1), to: day(4), at: day(-1) }] }),
    T({ logs: [{ at: day(-2), text: '자료 요청' }, { at: day(-1), text: '회신 완료' }] }),
    T({ progress: '옛 진행사항만 있음' }),
  ]);
  const html = $(env.document, '#todoTableBody').innerHTML;
  check('밀린 횟수 배지', html.includes('⟳2'));
  check('로그가 있으면 최신 한 줄', $$(env.document, '#todoTableBody .col-notes')[2].textContent.includes('회신 완료'));
  check('나머지 개수 배지', html.includes('+1'));
  check('로그가 없으면 옛 진행사항', $$(env.document, '#todoTableBody .col-notes')[4].textContent.includes('옛 진행사항'));
}

section('필터 — 대·중·소 분류');
{
  seq = 0;
  const env = boot([
    T({ channel: '마리오', subChannel: '패션플러스', projectId: 'p1' }),
    T({ channel: '사방넷', subChannel: '하프클럽', projectId: 'p1' }),
    T({ channel: '마리오', subChannel: '하프클럽', projectId: 'p2' }),
  ]);
  const set = (id, v) => { $(env.document, '#' + id).value = v; };

  set('todoMidFilter', '마리오'); env.app.renderTodos();
  check('중분류 필터', rows(env.document).length === 2);

  set('todoSubFilter', '하프클럽'); env.app.renderTodos();
  check('중·소분류 AND 로 겹친다', rows(env.document).length === 1);

  set('todoProjectFilter', 'p1'); env.app.renderTodos();
  check('대분류까지 걸면 0건', rows(env.document).length === 0);

  set('todoProjectFilter', 'all'); set('todoMidFilter', 'all'); set('todoSubFilter', 'all');
  env.app.renderTodos();
  check('전체로 되돌리면 3건', rows(env.document).length === 3);
}

section('검색 — 업무로그도 걸린다');
{
  seq = 0;
  const env = boot([
    T({ text: '마리오 상품 품번 추출' }),
    T({ text: '엔터식스 정산', logs: [{ at: day(-1), text: '김 차장 자료 전달' }] }),
    T({ text: '사방넷 미팅', progress: '아젠다 전달' }),
  ]);
  const search = (q) => { $(env.document, '#todoSearch').value = q; env.app.renderTodos(); return rows(env.document).length; };
  check('제목으로 검색', search('품번') === 1);
  check('로그 내용으로도 검색된다', search('자료 전달') === 1);
  check('진행사항으로도 검색', search('아젠다') === 1);
  check('없는 말은 0건', search('없는말없는말') === 0);
}

section('빠른보기 · 기간 필터');
{
  seq = 0;
  const env = boot([
    T({ status: '대기' }), T({ status: '진행중' }),
    T({ status: '완료', completedDate: day(-1) }), T({ status: '보류' }),
  ]);
  const quick = (v) => {
    $$(env.document, '#todoQuickView .segmented-btn').forEach((b) => b.classList.toggle('active', b.dataset.qv === v));
    env.app.renderTodos(); return rows(env.document).length;
  };
  check('진행·대기', quick('active') === 2);
  check('완료', quick('done') === 1);
  check('보류', quick('hold') === 1);
  check('전체', quick('all') === 4);

  $(env.document, '#todoDateFrom').value = day(0);
  $(env.document, '#todoDateTo').value = day(2);
  env.app.renderTodos();
  check('마감일 기간으로 거른다', rows(env.document).length === 4);
  $(env.document, '#todoDateFrom').value = day(5);
  $(env.document, '#todoDateTo').value = day(9);
  env.app.renderTodos();
  check('범위 밖이면 0건', rows(env.document).length === 0);
}

section('정렬 키');
{
  const env = bootApp();
  env.app.setState({ projects: [{ id: 'p1', name: '영업' }], todos: [], events: [], channels: [], subMaster: [], settings: {} });
  const a = T({ dueDate: '2026-07-01', priority: '긴급' });
  const b = T({ dueDate: '2026-08-01', priority: '보통' });
  check('마감일 정렬', env.app.todoSortValue(a, 'dueDate') < env.app.todoSortValue(b, 'dueDate'));
  check('우선순위는 긴급이 앞', env.app.todoSortValue(a, 'priority') < env.app.todoSortValue(b, 'priority'));
}

section('일괄 지정');
{
  seq = 0;
  const env = boot([T({ subChannel: '' }), T({ subChannel: '' }), T({ subChannel: '하프클럽' })]);
  const st = env.app.getState();
  // 앞 2건 선택
  $$(env.document, '#todoTableBody .todo-check').slice(0, 2).forEach((c) => { c.checked = true; c.dispatchEvent(new env.window.Event('change', { bubbles: true })); });
  await tick();

  env.app.bulkAssign('subChannel', '패션플러스', '소분류');
  await tick();
  check('선택한 2건에만 들어간다', st.todos[0].subChannel === '패션플러스' && st.todos[1].subChannel === '패션플러스');
  check('선택 안 한 건은 그대로', st.todos[2].subChannel === '하프클럽');
  check('저장까지 갔다', env.saves.length >= 1);

  // (비우기)
  $$(env.document, '#todoTableBody .todo-check').slice(0, 1).forEach((c) => { c.checked = true; c.dispatchEvent(new env.window.Event('change', { bubbles: true })); });
  await tick();
  env.app.bulkAssign('subChannel', '__clear__', '소분류');
  await tick();
  check('(비우기)로 지워진다', st.todos[0].subChannel === '');
}

section('CSV 내보내기 — 새 열이 들어간다');
{
  seq = 0;
  const env = boot([
    T({ text: '로그 있는 건', logs: [{ at: day(-2), text: '자료 요청' }, { at: day(-1), text: '회신 완료' }] }),
    T({ text: '마감 밀린 건', dueHistory: [{ from: day(-3), to: day(1), at: day(-3) }] }),
    T({ text: '쉼표, 들어간 건' }),
  ]);
  const csv = env.app.buildTodosCsv(env.app.filterTodos());
  const lines = csv.split('\r\n');
  const head = lines[0].replace('﻿', '').split(',');

  check('BOM 으로 시작', csv.charCodeAt(0) === 0xFEFF);
  check('열 17개', head.length === 17, head.length + '개');
  check('업무로그 열', head[15] === '업무로그');
  check('마감변경 열', head[16] === '마감변경');
  check('행 수 = 할 일 수', lines.length === 4);
  check('로그가 날짜순으로 들어간다', lines[1].includes('자료 요청 / ') && lines[1].includes('회신 완료'));
  check('마감 변경 이력이 들어간다', lines[2].includes('→'));
  check('쉼표 든 값은 따옴표로 감싼다', lines[3].includes('"쉼표, 들어간 건"'));
}
