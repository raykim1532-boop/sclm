// 일정에서 할 일 만들기 — 실제 모달을 열고 버튼을 눌러 본다.
// 배경: 일정 240건 : 할 일 61건인데 둘이 전혀 안 이어져 있었다.
// ⚠️ 실제 일정은 대부분 구글에서 가져온 **읽기 전용**이라, 그쪽 모달이 핵심 경로다.
import { check, section } from './_helpers.mjs';
import { bootApp, $, $$, click, tick } from './_dom.mjs';

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const RO = (o) => Object.assign({
  id: 'e1', title: '대표님+전략사업부_주간회의', start: '2026-08-05', end: '2026-08-05',
  allDay: false, startTime: '10:00', endTime: '11:00', projectId: 'p1',
  roCal: 'work@group.calendar.google.com', roCalName: '세정글로벌(유통사업파트)', readOnly: true, source: 'google-ro',
}, o);
const OWN = (o) => Object.assign({
  id: 'e2', title: '내부 회의', start: '2026-08-06', end: '', allDay: true,
  startTime: '', endTime: '', projectId: 'p2', color: '', notes: '',
}, o);

function boot(events) {
  const env = bootApp();
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }, { id: 'p2', name: '정산', color: '#0f9d58' }],
    todos: [], events: events || [], channels: [], subMaster: [], settings: {},
  });
  return env;
}

section('일정 → 할 일 초안');
{
  const env = bootApp();
  const p = env.app.todoPresetFromEvent(RO({}), TODAY);
  check('제목은 비워 둔다', p.text === '');
  check('마감일은 일정 날짜', p.dueDate === '2026-08-05');
  check('등록일은 오늘', p.registeredDate === TODAY);
  check('대분류를 물려받는다', p.projectId === 'p1');
  check('출처 id', p.fromEvent === 'e1');
  check('출처 제목', p.fromEventTitle === '대표님+전략사업부_주간회의');

  const noDate = env.app.todoPresetFromEvent({ id: 'x', title: 'T', start: '' }, TODAY);
  check('날짜가 없으면 오늘로', noDate.dueDate === TODAY);
  check('일정이 이상해도 안 죽는다', !!env.app.todoPresetFromEvent(null, TODAY));
  check('긴 제목은 잘린다', env.app.todoPresetFromEvent({ id: 'x', title: 'ㄱ'.repeat(200) }, TODAY).fromEventTitle.length === 80);
}

section('읽기 전용 일정 모달에 버튼이 있다');
{
  const ev = RO({});
  const env = boot([ev]);
  env.app.openReadOnlyEventModal(ev);
  check('모달이 열린다', !$(env.document, '#modalOverlay').classList.contains('hidden'));
  check('제목이 보인다', $(env.document, '#modalBody').textContent.includes('주간회의'));
  check('출처 캘린더도', $(env.document, '#modalBody').textContent.includes('세정글로벌'));
  check('할 일 만들기 버튼', !!$(env.document, '#evToTodoBtn'));
}

section('버튼을 누르면 할 일 모달이 채워져 열린다');
{
  const ev = RO({});
  const env = boot([ev]);
  env.app.openReadOnlyEventModal(ev);
  click($(env.document, '#evToTodoBtn'));
  await tick(40);

  check('할 일 모달로 바뀐다', !!$(env.document, '#f-text'));
  check('제목은 비어 있다', $(env.document, '#f-text').value === '');
  check('마감일이 일정 날짜로 채워짐', $(env.document, '#f-due').value === '2026-08-05');
  check('대분류가 물려받아짐', $(env.document, '#f-project').value === 'p1');
  check('어느 일정에서 왔는지 보인다', $(env.document, '.from-event') !== null);
  check('일정 제목이 표시된다', $(env.document, '.from-event').textContent.includes('주간회의'));
}

section('저장하면 출처가 함께 남는다');
{
  const ev = RO({});
  const env = boot([ev]);
  env.app.openReadOnlyEventModal(ev);
  click($(env.document, '#evToTodoBtn'));
  await tick(40);

  $(env.document, '#f-text').value = '회의 자료 정리';
  click($(env.document, '#modalSaveBtn'));
  await tick(40);

  const todos = env.app.getState().todos;
  check('할 일이 만들어졌다', todos.length === 1);
  check('내용이 맞다', todos[0].text === '회의 자료 정리');
  check('마감일', todos[0].dueDate === '2026-08-05');
  check('출처 id 가 남는다', todos[0].fromEvent === 'e1');
  check('출처 제목도 남는다', todos[0].fromEventTitle === '대표님+전략사업부_주간회의');
  check('저장까지 갔다', env.saves.length >= 1);

  // 다시 열면 출처 줄이 보인다
  env.app.openTodoModal(todos[0]);
  check('다시 열어도 출처가 보인다', $(env.document, '.from-event') !== null);
}

section('내가 만든 일정(수정 가능)에도 버튼이 있다');
{
  const ev = OWN({});
  const env = boot([ev]);
  env.app.openEventModal(ev);
  check('일정 수정 모달', !!$(env.document, '#f-title'));
  check('할 일 만들기 버튼', !!$(env.document, '#evToTodoBtn'));

  click($(env.document, '#evToTodoBtn'));
  await tick(40);
  check('할 일 모달로 바뀐다', !!$(env.document, '#f-text'));
  check('마감일', $(env.document, '#f-due').value === '2026-08-06');
  check('대분류', $(env.document, '#f-project').value === 'p2');
}

section('새 일정을 만드는 중에는 버튼이 없다');
{
  // 아직 저장 전이라 연결할 대상이 없다
  const env = boot([]);
  env.app.openEventModal(null, '2026-08-07');
  check('일정 추가 모달', !!$(env.document, '#f-title'));
  check('버튼이 없다', !$(env.document, '#evToTodoBtn'));
}

section('그냥 만든 할 일에는 출처 줄이 없다');
{
  const env = boot([]);
  env.app.openTodoModal(null);
  check('출처 줄 없음', !$(env.document, '.from-event'));
}
