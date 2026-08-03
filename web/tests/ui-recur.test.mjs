// 월간 정기업무 — 설정 화면에서 실제로 등록하고, 앱을 열 때 생성되는지 본다.
// 순수 함수(recur-templates.test.mjs)와 달리 여기서는 DOM·저장·중복 방지까지 확인한다.
import { check, section } from './_helpers.mjs';
import { bootApp, $, $$, click, tick } from './_dom.mjs';

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const CUR_MONTH = TODAY.slice(0, 7);
const TODAY_DAY = parseInt(TODAY.slice(8, 10), 10);

function boot(templates, todos) {
  const env = bootApp();
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }, { id: 'p2', name: '정산', color: '#0f9d58' }],
    todos: todos || [], events: [], channels: ['기타'], subMaster: ['지출결의서'], settings: {},
    recurTemplates: templates || [],
  });
  return env;
}
const TPL = (o) => Object.assign({
  id: 'r1', text: '{전월} 법인카드 사용내역 품의', projectId: 'p1', channel: '기타', subChannel: '지출결의서',
  priority: '중요', assignee: '김성철', createDay: 1, dueDay: 10, active: true, lastRunMonth: '',
}, o);

section('설정 화면 — 목록 렌더');
{
  const env = boot([TPL({}), TPL({ id: 'r2', text: '{전월M} 도급비', active: false })]);
  env.app.renderRecurList();
  const rows = $$(env.document, '#recurList .recur-row');
  check('2줄이 그려진다', rows.length === 2);
  check('제목의 자리표시자가 채워져 보인다', rows[0].textContent.includes('법인카드') && !rows[0].textContent.includes('{전월}'));
  check('꺼진 건 표시된다', rows[1].className.includes('off') && rows[1].textContent.includes('꺼짐'));
  check('분류가 보인다', rows[0].textContent.includes('영업') && rows[0].textContent.includes('지출결의서'));
  check('생성일·마감일 표시', rows[0].textContent.includes('1일 생성') && rows[0].textContent.includes('10일'));

  const empty = boot([]);
  empty.app.renderRecurList();
  check('없으면 안내 문구', $(empty.document, '#recurList').textContent.includes('없어요'));
}

section('설정 화면 — 추가');
{
  const env = boot([]);
  env.app.setupRecur();
  click($(env.document, '#recurAddBtn'));
  await tick();

  check('모달이 열린다', !!$(env.document, '#rc-text'));
  $(env.document, '#rc-text').value = '{전월} 쇼멘토 광고비';
  $(env.document, '#rc-channel').value = '기타';
  $(env.document, '#rc-subchannel').value = '광고비';
  $(env.document, '#rc-createday').value = '3';
  $(env.document, '#rc-dueday').value = '15';
  click($(env.document, '#modalSaveBtn'));
  await tick();

  const tpls = env.app.getState().recurTemplates;
  check('1건 등록됐다', tpls.length === 1);
  check('내용이 맞다', tpls[0].text === '{전월} 쇼멘토 광고비');
  check('생성일·마감일', tpls[0].createDay === 3 && tpls[0].dueDay === 15);
  check('새 소분류가 마스터에 편입된다', env.app.getState().subMaster.includes('광고비'));
  check('저장까지 갔다', env.saves.length >= 1);
  check('목록이 다시 그려진다', $$(env.document, '#recurList .recur-row').length === 1);
}

section('설정 화면 — 빈 제목은 막는다');
{
  const env = boot([]);
  env.app.setupRecur();
  click($(env.document, '#recurAddBtn'));
  await tick();
  $(env.document, '#rc-text').value = '   ';
  click($(env.document, '#modalSaveBtn'));
  await tick();
  check('등록되지 않는다', (env.app.getState().recurTemplates || []).length === 0);
  check('모달이 닫히지 않는다', !$(env.document, '#modalOverlay').classList.contains('hidden'));
}

section('앱을 열 때 이번 달치가 만들어진다');
{
  const env = boot([TPL({ createDay: 1 }), TPL({ id: 'r2', text: '{전월} 동진특송 물류비', createDay: 1 })]);
  const n = await env.app.runMonthlyTemplates();

  check('2건 만들어졌다', n === 2);
  const todos = env.app.getState().todos;
  check('할 일에 들어갔다', todos.length === 2);
  check('제목이 채워졌다', !todos[0].text.includes('{전월}'));
  check('어느 템플릿에서 왔는지 남는다', todos[0].fromTemplate === 'r1');
  check('번호가 안 겹친다', todos[0].no !== todos[1].no);
  check('저장됐다', env.saves.length >= 1);
  check('템플릿에 이번 달 표시', env.app.getState().recurTemplates.every((t) => t.lastRunMonth === CUR_MONTH));
}

section('두 번 열어도 한 번만 만든다');
{
  const env = boot([TPL({ createDay: 1 })]);
  await env.app.runMonthlyTemplates();
  const after1 = env.app.getState().todos.length;
  const n2 = await env.app.runMonthlyTemplates();
  check('첫 번째에 1건', after1 === 1);
  check('두 번째는 0건', n2 === 0);
  check('할 일도 안 늘어난다', env.app.getState().todos.length === 1);
}

section('생성일이 아직 안 됐으면 안 만든다');
{
  // 오늘보다 뒤인 날짜로 잡는다(오늘이 28일 이후면 이 절은 의미가 없으므로 건너뛴다)
  if (TODAY_DAY < 28) {
    const env = boot([TPL({ createDay: TODAY_DAY + 1 })]);
    const n = await env.app.runMonthlyTemplates();
    check('아직 안 만든다', n === 0 && env.app.getState().todos.length === 0);
  } else {
    check('오늘이 말일 근처라 건너뜀', true);
  }
}

section('꺼둔 템플릿과 지난달 기록');
{
  const env = boot([
    TPL({ id: 'off', active: false, createDay: 1 }),
    TPL({ id: 'old', createDay: 1, lastRunMonth: '2020-01' }),
  ]);
  const n = await env.app.runMonthlyTemplates();
  check('꺼진 건 빼고 1건만', n === 1);
  check('만들어진 건 지난달 기록이 있던 쪽', env.app.getState().todos[0].fromTemplate === 'old');
}

section('템플릿이 없으면 아무 일도 안 한다');
{
  const env = boot([]);
  const n = await env.app.runMonthlyTemplates();
  check('0건', n === 0);
  check('저장도 안 한다', env.saves.length === 0);
}

section('이번 달은 건너뛰기 — 값 계산');
{
  const env = bootApp();
  const f = env.app.skipToLastRun;
  check('켜면 이번 달로 표시', f(true, '', '2026-08') === '2026-08');
  check('켜면 지난 기록도 이번 달로', f(true, '2026-07', '2026-08') === '2026-08');
  check('끄면 이번 달 표시를 지운다', f(false, '2026-08', '2026-08') === '');
  check('끄더라도 지난달 기록은 그대로', f(false, '2026-07', '2026-08') === '2026-07');
  check('원래 없었으면 그대로 없음', f(false, '', '2026-08') === '');
}

section('새로 등록할 땐 기본으로 켜져 있다');
{
  const env = boot([]);
  env.app.setupRecur();
  click($(env.document, '#recurAddBtn'));
  await tick();
  check('체크박스가 있다', !!$(env.document, '#rc-skip'));
  check('기본으로 켜져 있다', $(env.document, '#rc-skip').checked === true);

  $(env.document, '#rc-text').value = '{전월} 법인카드 사용내역 품의';
  $(env.document, '#rc-createday').value = '1';
  click($(env.document, '#modalSaveBtn'));
  await tick(40);

  const tpls = env.app.getState().recurTemplates;
  check('등록됐다', tpls.length === 1);
  check('이번 달 표시가 붙는다', tpls[0].lastRunMonth === CUR_MONTH);
  check('할 일은 안 만들어진다', env.app.getState().todos.length === 0);
}

section('건너뛰기를 끄고 저장하면 바로 만들어진다');
{
  const env = boot([]);
  env.app.setupRecur();
  click($(env.document, '#recurAddBtn'));
  await tick();
  $(env.document, '#rc-text').value = '{전월} 동진특송 물류비';
  $(env.document, '#rc-createday').value = '1';
  $(env.document, '#rc-skip').checked = false;
  click($(env.document, '#modalSaveBtn'));
  await tick(60);

  const st = env.app.getState();
  check('할 일이 바로 생겼다', st.todos.length === 1, st.todos.length + '건');
  check('제목이 채워졌다', st.todos[0].text.indexOf('동진특송') > -1 && st.todos[0].text.indexOf('{전월}') === -1);
  check('그 뒤엔 이번 달 표시가 붙는다', st.recurTemplates[0].lastRunMonth === CUR_MONTH);
}

section('이미 만든 템플릿을 열면 체크가 켜져 있고, 끄면 다시 만들어진다');
{
  const env = boot([TPL({ createDay: 1, lastRunMonth: CUR_MONTH })]);
  env.app.setupRecur();
  click($$(env.document, '#recurList .recur-row')[0]);
  await tick();
  check('체크가 켜져 있다', $(env.document, '#rc-skip').checked === true);

  $(env.document, '#rc-skip').checked = false;
  click($(env.document, '#modalSaveBtn'));
  await tick(60);
  check('끄고 저장하니 만들어진다', env.app.getState().todos.length === 1);
}
