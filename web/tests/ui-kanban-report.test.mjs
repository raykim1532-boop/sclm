// 칸반 보드와 주간·월간 리포트 — 실제 DOM 에 그려 확인한다.
// 수동 체크리스트의 마지막 두 항목.
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

/* ⚠️ 리포트는 "이번 주(월~일)"와 "이번 달" 경계를 쓴다. day(-1) 같은 상대 날짜를 그냥 쓰면
   오늘이 월요일이거나 매달 1~2일일 때 지난주·지난달로 넘어가 테스트가 달력에 따라 깨진다.
   그래서 경계 안에 확실히 들어오는 날짜를 계산해서 쓴다. */
const THIS_WEEK_START = (() => {
  const d = new Date(TODAY + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;              // 월=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
})();
// 이번 주이면서 이번 달이기도 한 날 — 완료일 fixture 로 안전하다
const IN_THIS_WEEK_AND_MONTH = THIS_WEEK_START.slice(0, 7) === TODAY.slice(0, 7) ? THIS_WEEK_START : TODAY;

function boot(todos) {
  const env = bootApp();
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }, { id: 'p2', name: '정산', color: '#0f9d58' }],
    todos, events: [], channels: ['마리오', '사방넷'], subMaster: ['패션플러스'], settings: {},
  });
  return env;
}

section('칸반 — 상태별로 카드가 나뉜다');
{
  seq = 0;
  const env = boot([
    T({ status: '대기' }), T({ status: '대기' }),
    T({ status: '진행중' }),
    T({ status: '완료', completedDate: day(-1) }),
    T({ status: '보류' }),
  ]);
  env.app.setProjectView('p1');
  env.app.renderKanban();

  const cols = $$(env.document, '#kanbanBoard .kanban-col');
  check('칸반 열이 그려진다', cols.length >= 3, cols.length + '열');
  check('카드 총수 = 할 일 수', $$(env.document, '#kanbanBoard .kanban-card').length === 5);

  const counts = cols.map((c) => ({ label: $(c, '.kanban-col-header').textContent, n: $$(c, '.kanban-card').length }));
  counts.forEach((c) => console.log('      ' + c.label.replace(/\s+/g, ' ').trim() + ' → ' + c.n + '장'));
  check('열별 합이 전체와 같다', counts.reduce((a, b) => a + b.n, 0) === 5);
  check('완료 카드에 done 표시', $$(env.document, '#kanbanBoard .kanban-card.done').length === 1);
}

section('칸반 — 카드에 분류가 보인다');
{
  seq = 0;
  const env = boot([T({ channel: '사방넷', subChannel: '하프클럽' })]);
  env.app.setProjectView('p1');
  env.app.renderKanban();
  const html = $(env.document, '#kanbanBoard').innerHTML;
  check('중분류 표시', html.includes('사방넷'));
  check('소분류 표시', html.includes('하프클럽'));
}

// 리포트의 '다음 주'는 weekRange(today,1) 기준이라 그 범위 안의 날짜를 쓴다
let NEXT_WEEK = day(8);
section('주간 리포트');
{
  seq = 0;
  const env = boot([
    T({ status: '완료', completedDate: IN_THIS_WEEK_AND_MONTH, text: '이번 주 완료 건' }),
    T({ status: '대기', dueDate: NEXT_WEEK, text: '다음 주 예정 건' }),
    T({ status: '대기', dueDate: day(-4), text: '지연된 건' }),
  ]);
  NEXT_WEEK = env.app.weekRange(TODAY, 1).start;
  env.app.setState(Object.assign(env.app.getState(), { todos: env.app.getState().todos.map((t) => t.text === '다음 주 예정 건' ? Object.assign(t, { dueDate: NEXT_WEEK }) : t) }));
  env.app.openWeeklyReport();
  const body = $(env.document, '#modalBody').innerHTML;
  check('모달이 열린다', !$(env.document, '#modalOverlay').classList.contains('hidden'));
  check('완료 건이 들어간다', body.includes('이번 주 완료 건'));
  check('다음 주 예정 건이 들어간다', body.includes('다음 주 예정 건'));
  check('지연 건이 들어간다', body.includes('지연된 건'));
  check('분류 꼬리표가 붙는다', body.includes('영업') && body.includes('마리오'));
  env.app.closeModal();
}

section('월간 리포트 — 3축 요약');
{
  seq = 0;
  const env = boot([
    T({ status: '완료', completedDate: TODAY, projectId: 'p1', channel: '마리오', subChannel: '패션플러스' }),
    T({ status: '완료', completedDate: IN_THIS_WEEK_AND_MONTH, projectId: 'p2', channel: '사방넷', subChannel: '' }),
    T({ status: '대기', dueDate: day(1) }),
  ]);
  env.app.openMonthlyReport();
  const body = $(env.document, '#modalBody').innerHTML;
  check('모달이 열린다', !$(env.document, '#modalOverlay').classList.contains('hidden'));
  check('대분류 축', body.includes('대분류'));
  check('중분류 축', body.includes('중분류'));
  check('소분류 축', body.includes('소분류'));
  check('처리 지표가 들어간다', body.includes('소요') || body.includes('준수'));
  check('대시보드와 같은 막대를 쓴다', body.includes('an-bar'));
  env.app.closeModal();
}

section('리포트 — 데이터가 없어도 죽지 않는다');
{
  const env = boot([]);
  env.app.openWeeklyReport();
  check('주간 리포트 열림', !$(env.document, '#modalOverlay').classList.contains('hidden'));
  env.app.closeModal();
  env.app.openMonthlyReport();
  check('월간 리포트 열림', !$(env.document, '#modalOverlay').classList.contains('hidden'));
  env.app.closeModal();
}
