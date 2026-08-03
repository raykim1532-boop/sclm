// 딥링크 — 메일·카카오에서 항목을 눌렀을 때 실제로 그 창이 열리는지.
// 링크만 만들어 놓고 받는 쪽이 없으면 메일이 그냥 읽을거리로 끝난다.
import { check, section } from './_helpers.mjs';
import { bootApp, $, tick } from './_dom.mjs';

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const T = (o) => Object.assign({
  id: 't1', no: 1, text: '마리오 상품 품번 추출하기', projectId: 'p1', channel: '마리오', subChannel: '',
  priority: '', assignee: '', registeredDate: TODAY, dueDate: TODAY, status: '진행중',
  needsCheck: '', completedDate: '', progress: '', remarks: '', links: [], files: []
}, o);
const EV = (o) => Object.assign({ id: 'e1', title: '주간회의', start: TODAY, end: TODAY, allDay: true, projectId: 'p1' }, o);

/* location.search 를 바꿔 가며 부팅한다 */
function boot(search, todos, events) {
  const env = bootApp({ search });
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }],
    todos: todos || [], events: events || [], channels: ['마리오'], subMaster: [], settings: {},
  });
  return env;
}

section('?todo= 로 들어오면 그 할 일이 열린다');
{
  const todo = T({});
  const env = boot('?todo=t1', [todo]);
  env.app.setupNav();   // 화면 전환은 내비 배선이 있어야 동작한다(실제로는 init 이 해준다)
  const opened = env.app.openFromUrl();
  await tick();

  check('열렸다고 알린다', opened === true);
  check('할 일 편집창이 뜬다', !!$(env.document, '#f-text'));
  check('그 할 일 내용이다', $(env.document, '#f-text').value === '마리오 상품 품번 추출하기');
  check('할 일 화면으로 전환된다', $(env.document, '#view-todos').classList.contains('active'));
}

section('?event= 로 들어오면 그 일정이 열린다');
{
  const env = boot('?event=e1', [], [EV({})]);
  const opened = env.app.openFromUrl();
  await tick();
  check('열렸다고 알린다', opened === true);
  check('일정 창이 뜬다', !!$(env.document, '#f-title'));
  check('그 일정이다', $(env.document, '#f-title').value === '주간회의');
}

section('주소를 지운다 — 새로고침할 때 또 열리지 않게');
{
  const env = boot('?todo=t1', [T({})]);
  let replaced = null;
  env.window.history = { replaceState: (a, b, url) => { replaced = url; } };
  env.app.openFromUrl();
  await tick();
  check('replaceState 로 쿼리를 지운다', replaced !== null && !String(replaced).includes('todo='));
}

section('없는 항목이면 조용히 알린다');
{
  const env = boot('?todo=없는id', [T({})]);
  const opened = env.app.openFromUrl();
  await tick();
  check('열지 않는다', opened === false);
  check('편집창도 안 뜬다', !$(env.document, '#f-text'));
  check('안내를 띄운다', $(env.document, '#toast').textContent.includes('찾지 못했어요'));

  const ev = boot('?event=없는id', [], [EV({})]);
  check('일정도 마찬가지', ev.app.openFromUrl() === false);
}

section('파라미터가 없으면 아무 일도 안 한다');
{
  const env = boot('', [T({})]);
  check('false 를 돌려준다', env.app.openFromUrl() === false);
  check('창이 안 뜬다', $(env.document, '#modalOverlay').classList.contains('hidden'));

  const other = boot('?google=connected', [T({})]);
  check('상관없는 파라미터도 무시', other.app.openFromUrl() === false);
}

section('할 일이 일정보다 먼저');
{
  // 둘 다 있으면 할 일을 연다 — 메일에서 오는 건 대개 할 일이다
  const env = boot('?todo=t1&event=e1', [T({})], [EV({})]);
  env.app.openFromUrl();
  await tick();
  check('할 일 창', !!$(env.document, '#f-text'));
}
