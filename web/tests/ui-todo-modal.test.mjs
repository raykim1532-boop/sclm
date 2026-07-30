// 할 일 모달 — 실제 DOM 위에서 버튼을 눌러 본다.
// 순수 함수 테스트로는 못 잡는 것(버튼 배선·이벤트 전파·즉시 저장)을 여기서 본다.
// 2026-07-30: 이 계열 버그가 실제로 두 번 났다 — 핸들러 선택자 충돌, 로그 저장 시점.
import { check, section } from './_helpers.mjs';
import { bootApp, $, $$, click, tick } from './_dom.mjs';

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const P = { id: 'p1', name: '영업', color: '#1a73e8' };
const mkTodo = (o) => Object.assign({
  id: 't1', no: 1, text: '테스트 업무', projectId: 'p1', channel: '마리오', subChannel: '',
  priority: '', assignee: '', registeredDate: TODAY, dueDate: '', status: '진행중',
  needsCheck: '', completedDate: '', progress: '', remarks: '', links: [], files: [], logs: []
}, o);
const mkState = (todos) => ({ projects: [P], todos, events: [], channels: ['마리오'], subMaster: [], settings: {} });

section('업무 로그 — 기존 할 일은 적는 즉시 저장');
{
  const todo = mkTodo({});
  const env = bootApp();
  env.app.setState(mkState([todo]));
  env.app.openTodoModal(todo);

  check('로그 입력칸이 있다', !!$(env.document, '#f-log-text') && !!$(env.document, '#f-log-add'));
  check('날짜가 오늘로 채워져 있다', $(env.document, '#f-log-date').value === TODAY);
  check('안내 문구가 "바로 저장"', ($(env.document, '.hint-inline') || {}).textContent === '적으면 바로 저장돼요');

  $(env.document, '#f-log-text').value = '담당자 메일 발송';
  click($(env.document, '#f-log-add'));
  await tick();

  check('줄이 추가된다', $$(env.document, '#f-logs .log-row').length === 1);
  check('입력칸이 비워진다', $(env.document, '#f-log-text').value === '');
  check('todo.logs 에 반영', todo.logs.length === 1 && todo.logs[0].text === '담당자 메일 발송');
  check('날짜가 붙는다', todo.logs[0].at === TODAY);
  check('즉시 저장이 불렸다', env.saves.length === 1);
  check('저장된 데이터에도 들어 있다', env.saves[0].todos[0].logs[0].text === '담당자 메일 발송');

  // 두 번째
  $(env.document, '#f-log-text').value = '회신 완료';
  click($(env.document, '#f-log-add'));
  await tick();
  check('두 번째도 즉시 저장', env.saves.length === 2 && todo.logs.length === 2);
  check('최신이 위로 온다', $$(env.document, '#f-logs .log-row')[0].dataset.text === '회신 완료');

  // 삭제
  click($(env.document, '#f-logs .lr-del'));
  await tick();
  check('✕ 로 지우면 즉시 저장', env.saves.length === 3 && todo.logs.length === 1);
  check('남은 것이 맞다', todo.logs[0].text === '담당자 메일 발송');

  // [취소] 해도 로그는 남는다 — 이게 즉시저장으로 바꾼 이유다
  env.app.closeModal();
  check('취소해도 로그 유지', todo.logs.length === 1);
}

section('업무 로그 — 빈 입력·Enter');
{
  const todo = mkTodo({});
  const env = bootApp();
  env.app.setState(mkState([todo]));
  env.app.openTodoModal(todo);

  $(env.document, '#f-log-text').value = '   ';
  click($(env.document, '#f-log-add'));
  await tick();
  check('공백만 있으면 아무 일 없음', $$(env.document, '#f-logs .log-row').length === 0 && env.saves.length === 0);

  // Enter 는 폼 제출이 아니라 로그 추가여야 한다
  const ti = $(env.document, '#f-log-text');
  ti.value = '엔터로 기록';
  let defaultPrevented = false;
  ti.dispatchEvent(Object.assign(new env.window.Event('keydown', { bubbles: true, cancelable: true }), { key: 'Enter' }));
  await tick();
  check('Enter 로도 기록된다', $$(env.document, '#f-logs .log-row').length === 1);
  check('Enter 기록도 저장된다', env.saves.length === 1);
}

section('업무 로그 — 새로 만드는 할 일은 [저장] 때 함께');
{
  const env = bootApp();
  env.app.setState(mkState([]));
  env.app.openTodoModal(null);

  check('안내 문구가 다르다', ($(env.document, '.hint-inline') || {}).textContent === '한 줄 적으면 날짜가 붙어 쌓여요');
  $(env.document, '#f-log-text').value = '새 건 로그';
  click($(env.document, '#f-log-add'));
  await tick();
  check('화면에는 쌓인다', $$(env.document, '#f-logs .log-row').length === 1);
  check('아직 저장하지 않는다', env.saves.length === 0);

  // 저장하면 새 할 일에 로그가 함께 들어간다
  $(env.document, '#f-text').value = '새 업무';
  click($(env.document, '#modalSaveBtn'));
  await tick();
  const st = env.app.getState();
  check('할 일이 만들어졌다', st.todos.length === 1);
  check('로그도 함께 들어갔다', st.todos[0].logs.length === 1 && st.todos[0].logs[0].text === '새 건 로그');
}

section('마감일을 바꾸면 이력이 남는다');
{
  const todo = mkTodo({ dueDate: '2026-07-24' });
  const env = bootApp();
  env.app.setState(mkState([todo]));
  env.app.openTodoModal(todo);

  $(env.document, '#f-due').value = '2026-07-31';
  click($(env.document, '#modalSaveBtn'));
  await tick();

  check('마감일이 바뀌었다', todo.dueDate === '2026-07-31');
  check('이력이 한 줄 남았다', env.app.todoDueHistory(todo).length === 1);
  check('from/to 가 맞다', todo.dueHistory[0].from === '2026-07-24' && todo.dueHistory[0].to === '2026-07-31');
  check('밀린 횟수 1', env.app.dueMoveCount(todo) === 1);
  check('배지가 생긴다', env.app.dueBadgeHtml(todo).includes('⟳1'));
}

section('마감일을 처음 넣는 건 변경이 아니다');
{
  const todo = mkTodo({ dueDate: '' });
  const env = bootApp();
  env.app.setState(mkState([todo]));
  env.app.openTodoModal(todo);
  $(env.document, '#f-due').value = '2026-08-01';
  click($(env.document, '#modalSaveBtn'));
  await tick();
  check('이력이 안 생긴다', env.app.todoDueHistory(todo).length === 0);
  check('배지도 없다', env.app.dueBadgeHtml(todo) === '');
}
