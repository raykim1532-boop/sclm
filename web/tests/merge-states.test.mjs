// 3자 병합(mergeStates) — src/cloud-sync.js 에서 함수를 추출해 검증한다.
// 두 기기를 동시에 켜 두면 충돌은 필연이지만, 대개 서로 다른 항목을 고친 것이라 자동으로 합칠 수 있다.
// ⚠️ 여기가 깨지면 다른 기기의 작업이 조용히 사라진다. 2026-07-29 소분류 실종과 같은 계열의 사고다.
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const src = readFileSync(new URL('../../src/cloud-sync.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('추출 실패: ' + name); return m[0]; };
const mergeStates = new Function([
  grab(/const RECORD_KEYS = [\s\S]*?\r?\n  const eq = [^\r\n]*/, '상수'),
  grab(/  const byId = \(arr\) => \{[\s\S]*?\r?\n  \};/, 'byId'),
  grab(/  function mergeRecords\([\s\S]*?\r?\n  \}/, 'mergeRecords'),
  grab(/  function recLabel\([\s\S]*?\r?\n  \}/, 'recLabel'),
  grab(/  function mergeList\([\s\S]*?\r?\n  \}/, 'mergeList'),
  grab(/  function mergeStates\([\s\S]*?\r?\n  \}/, 'mergeStates'),
  'return mergeStates;'
].join('\n'))();

const T = (id, o) => Object.assign({ id, text: '업무 ' + id, status: '대기' }, o);
const S = (todos, extra) => Object.assign({ todos, events: [], channels: [], subMaster: [] }, extra || {});

section('서로 다른 항목을 고쳤을 때 — 물어보지 않고 합친다');
{
  const base = S([T('a'), T('b')]);
  const mine = S([T('a', { status: '완료' }), T('b')]);          // 나는 a 만
  const theirs = S([T('a'), T('b', { status: '진행중' })]);       // 서버는 b 만
  const r = mergeStates(base, mine, theirs);
  const get = (id) => r.data.todos.find((t) => t.id === id);
  check('충돌 없음', r.conflicts.length === 0 && !r.needsAsk);
  check('내 변경 살아 있음', get('a').status === '완료');
  check('상대 변경 살아 있음', get('b').status === '진행중');
  check('건수 그대로', r.data.todos.length === 2);
}

section('추가·삭제');
{
  const base = S([T('a')]);
  check('내가 추가한 건 살아남는다',
    mergeStates(base, S([T('a'), T('new')]), S([T('a')])).data.todos.length === 2);
  check('상대가 추가한 건도 살아남는다',
    mergeStates(base, S([T('a')]), S([T('a'), T('x')])).data.todos.length === 2);

  const both = mergeStates(base, S([T('a'), T('mine')]), S([T('a'), T('theirs')]));
  check('양쪽이 각각 추가하면 둘 다', both.data.todos.length === 3);

  check('내가 지운 건 지워진다',
    mergeStates(base, S([]), S([T('a')])).data.todos.length === 0);
  check('상대가 지운 건도 지워진다',
    mergeStates(base, S([T('a')]), S([])).data.todos.length === 0);
  check('양쪽 다 지우면 지워진다',
    mergeStates(base, S([]), S([])).data.todos.length === 0);
}

section('한쪽은 지우고 한쪽은 고쳤을 때 — 남기는 쪽');
{
  const base = S([T('a')]);
  const r1 = mergeStates(base, S([]), S([T('a', { status: '완료' })]));
  check('내가 지웠고 상대가 고쳤으면 남긴다', r1.data.todos.length === 1);
  check('충돌로 보고된다', r1.conflicts.some((c) => c.why === 'deleted-vs-edited'));

  const r2 = mergeStates(base, S([T('a', { status: '완료' })]), S([]));
  check('반대 방향도 남긴다', r2.data.todos.length === 1 && r2.data.todos[0].status === '완료');
}

section('같은 항목을 양쪽에서 고쳤을 때 — 이 창의 것을 택하고 반드시 알린다');
{
  const base = S([T('a', { status: '대기' })]);
  const r = mergeStates(base, S([T('a', { status: '완료' })]), S([T('a', { status: '보류' })]));
  check('저장을 누른 쪽(mine)을 택한다', r.data.todos[0].status === '완료');
  check('충돌 목록에 올라온다', r.conflicts.length === 1 && r.conflicts[0].why === 'both-edited');
  check('상대 값도 함께 넘겨준다', r.conflicts[0].theirs.status === '보류');
  check('그래도 자동 진행한다', r.needsAsk === false);
}

section('분류 목록 — 지운 건 지워지고 더한 건 더해진다');
{
  const base = S([], { channels: ['마리오', '사방넷'], subMaster: ['하프클럽'] });
  const mine = S([], { channels: ['마리오'], subMaster: ['하프클럽', '패션플러스'] });      // 사방넷 삭제 + 패플 추가
  const theirs = S([], { channels: ['마리오', '사방넷', '엔터식스'], subMaster: ['하프클럽'] });
  const r = mergeStates(base, mine, theirs);
  check('내가 지운 건 빠진다', !r.data.channels.includes('사방넷'));
  check('상대가 더한 건 남는다', r.data.channels.includes('엔터식스'));
  check('내가 더한 건 남는다', r.data.subMaster.includes('패션플러스'));
  check('중복 없음', new Set(r.data.channels).size === r.data.channels.length);
}

section('금고(vault) — 합칠 수 없으므로 조심스럽게');
{
  const base = S([], { vault: { ct: 'BASE' } });
  check('나만 바꿨으면 내 것',
    mergeStates(base, S([], { vault: { ct: 'MINE' } }), S([], { vault: { ct: 'BASE' } })).data.vault.ct === 'MINE');
  check('상대만 바꿨으면 상대 것',
    mergeStates(base, S([], { vault: { ct: 'BASE' } }), S([], { vault: { ct: 'THEIRS' } })).data.vault.ct === 'THEIRS');

  const both = mergeStates(base, S([], { vault: { ct: 'MINE' } }), S([], { vault: { ct: 'THEIRS' } }));
  check('양쪽 다 바꿨으면 사용자에게 묻는다', both.needsAsk === true);
  check('묻기 전 기본값은 서버 것(계정 유실 방지)', both.data.vault.ct === 'THEIRS');

  const noVault = mergeStates(S([]), S([]), S([]));
  check('금고가 없어도 안전', !('vault' in noVault.data) || noVault.data.vault === undefined);
}

section('모르는 키를 절대 버리지 않는다');
{
  const base = S([], { 미래필드: { v: 1 }, settings: { theme: 'light' } });
  const mine = S([], { 미래필드: { v: 1 }, settings: { theme: 'dark' } });
  const theirs = S([], { 미래필드: { v: 2 }, settings: { theme: 'light' }, 서버만있는키: 'x' });
  const r = mergeStates(base, mine, theirs);
  check('상대만 바꾼 모르는 키는 상대 값', r.data.미래필드.v === 2);
  check('서버에만 있는 키도 살아남는다', r.data.서버만있는키 === 'x');
  check('내가 바꾼 설정은 내 것', r.data.settings.theme === 'dark');

  const onlyMine = mergeStates(S([]), S([], { 내키: 1 }), S([]));
  check('나만 추가한 키도 살아남는다', onlyMine.data.내키 === 1);
}

section('입력이 이상해도 죽지 않는다');
{
  check('전부 null', !!mergeStates(null, null, null).data);
  check('base 없음(첫 저장)', mergeStates(null, S([T('a')]), S([])).data.todos.length === 1);
  check('id 없는 레코드는 무시', mergeStates(S([]), S([{ text: 'no id' }]), S([])).data.todos.length === 0);
  check('todos 가 배열이 아니어도', Array.isArray(mergeStates(S([]), { todos: 'x' }, S([])).data.todos));
}

section('실전 시나리오 — 데스크탑과 노트북');
{
  // 아침: 둘 다 같은 상태로 열었다
  const morning = S([T('1'), T('2'), T('3')], { channels: ['마리오'], subMaster: [] });
  // 데스크탑: 1번 완료 처리하고 저장 (서버 반영)
  const desktop = S([T('1', { status: '완료' }), T('2'), T('3')], { channels: ['마리오'], subMaster: [] });
  // 노트북: 아침 상태에서 3번에 로그 달고 새 할 일 추가 → 저장 시도 → 409
  const laptop = S([T('1'), T('2'), T('3', { logs: [{ at: '2026-07-30', text: '메일 발송' }] }), T('4')],
    { channels: ['마리오'], subMaster: ['패션플러스'] });

  const r = mergeStates(morning, laptop, desktop);
  const g = (id) => r.data.todos.find((t) => t.id === id);
  check('물어보지 않는다', r.needsAsk === false && r.conflicts.length === 0);
  check('데스크탑의 완료 처리가 살아 있다', g('1').status === '완료');
  check('노트북의 로그가 살아 있다', g('3').logs[0].text === '메일 발송');
  check('노트북이 추가한 할 일도 있다', !!g('4'));
  check('노트북이 추가한 소분류도 있다', r.data.subMaster.includes('패션플러스'));
  check('총 4건', r.data.todos.length === 4);
}

section('정기업무 템플릿도 id 로 병합된다');
{
  // 새 최상위 키를 RECORD_KEYS 에 안 넣으면 통짜 비교가 돼 한쪽이 통째로 사라진다.
  const R = (id, o) => Object.assign({ id, text: '{전월} ' + id, createDay: 1, dueDay: 10, active: true }, o);
  const base = S([], { recurTemplates: [R('a')] });
  const mine = S([], { recurTemplates: [R('a'), R('mine')] });
  const theirs = S([], { recurTemplates: [R('a'), R('theirs')] });
  const r = mergeStates(base, mine, theirs);
  check('양쪽이 각각 추가한 템플릿이 다 남는다', r.data.recurTemplates.length === 3);
  check('내 것', r.data.recurTemplates.some((t) => t.id === 'mine'));
  check('상대 것', r.data.recurTemplates.some((t) => t.id === 'theirs'));

  const edited = mergeStates(base, S([], { recurTemplates: [R('a', { lastRunMonth: '2026-08' })] }), S([], { recurTemplates: [R('a')] }));
  check('한쪽만 고치면 그쪽', edited.data.recurTemplates[0].lastRunMonth === '2026-08');
}
