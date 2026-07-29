// AI 비서 도구 — Gemini 호출 없이 runTool만 직접 검증한다.
// (모델이 어떤 도구를 고르는지는 검증 대상이 아니고, 도구가 내놓는 숫자가 맞는지가 핵심)
import { check, section } from './_helpers.mjs';
import { runTool } from '../functions/api/assistant.js';

// kstToday()가 오늘을 보므로 테스트도 오늘 기준으로 상대 날짜를 만든다
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const shift = (n) => {
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const thisMonth = today.slice(0, 7);

const state = () => ({
  projects: [{ id: 'p1', name: '정산' }, { id: 'p2', name: '영업' }],
  channels: ['엔터식스', '쿠팡'],
  subMaster: ['월정산', '행낭', '수수료'],
  events: [],
  todos: [
    { id: '1', text: '엔터식스 정산 마감', projectId: 'p1', channel: '엔터식스', subChannel: '월정산', assignee: '김성철', priority: '긴급', registeredDate: shift(-20), dueDate: shift(-3), status: '진행중' },
    { id: '2', text: '엔터식스 행낭 종료', projectId: 'p1', channel: '엔터식스', subChannel: '행낭', assignee: '김성철', priority: '보통', registeredDate: shift(-15), dueDate: shift(2), status: '대기' },
    { id: '3', text: '쿠팡 수수료 검증', projectId: 'p1', channel: '쿠팡', subChannel: '수수료', assignee: '박대리', priority: '중요', registeredDate: shift(-30), dueDate: shift(-1), status: '대기' },
    { id: '4', text: '신규 입점 제안', projectId: 'p2', channel: '쿠팡', assignee: '김성철', priority: '보통', registeredDate: shift(-40), dueDate: shift(10), status: '진행중' },
    { id: '5', text: '지난달 정산 완료건', projectId: 'p1', channel: '엔터식스', subChannel: '월정산', assignee: '김성철', registeredDate: shift(-25), dueDate: shift(-10), completedDate: shift(-8), status: '완료', done: true },
    { id: '6', text: '마감 없는 잡무', projectId: 'p2', channel: '', assignee: '', registeredDate: shift(-5), dueDate: '', status: '대기' }
  ]
});

section('search_todos — 조건으로 찾기');
{
  const s = state();
  const ch = runTool('search_todos', { channel: '엔터식스' }, s).result;
  check('채널로 미완료만 찾음', ch.총건수 === 2);
  check('완료 건은 기본 제외', !ch.목록.some((x) => x.상태 === '완료'));
  check('대분류·담당자도 함께 반환', ch.목록[0].대분류 === '정산' && ch.목록[0].담당 === '김성철');

  check('완료 포함 옵션', runTool('search_todos', { channel: '엔터식스', include_done: true }, s).result.총건수 === 3);
  check('키워드 부분 일치', runTool('search_todos', { keyword: '정산' }, s).result.총건수 === 1);
  check('대분류로 찾기', runTool('search_todos', { project_name: '영업' }, s).result.총건수 === 2);
  check('담당자로 찾기', runTool('search_todos', { assignee: '박대리' }, s).result.총건수 === 1);
  check('우선순위로 찾기', runTool('search_todos', { priority: '긴급' }, s).result.총건수 === 1);
  check('지연만 보기', runTool('search_todos', { only_overdue: true }, s).result.총건수 === 2);

  const range = runTool('search_todos', { due_from: today, due_to: shift(30) }, s).result;
  check('마감일 구간 필터', range.총건수 === 2);
  check('마감일 없는 건은 구간에서 제외', !range.목록.some((x) => x.업무 === '마감 없는 잡무'));

  const cap = runTool('search_todos', { limit: 1 }, s).result;
  check('limit으로 목록만 자르고 총건수는 유지', cap.총건수 === 5 && cap.보여준건수 === 1);
  check('잘렸을 때 안내 포함', typeof cap.안내 === 'string');
  check('조건 없으면 미완료 전체', runTool('search_todos', {}, s).result.총건수 === 5);
  check('상태 지정 시 완료도 조회 가능', runTool('search_todos', { status: '완료' }, s).result.총건수 === 1);
}

section('count_todos — 숫자만 세기');
{
  const s = state();
  check('조건 없이 미완료 건수', runTool('count_todos', {}, s).result.건수 === 5);
  check('목록은 반환하지 않음', runTool('count_todos', {}, s).result.목록 === undefined);
  check('채널 조건 건수', runTool('count_todos', { channel: '쿠팡' }, s).result.건수 === 2);

  const byCh = runTool('count_todos', { group_by: 'channel' }, s).result;
  check('채널별 집계', byCh.분류별['엔터식스'] === 2 && byCh.분류별['쿠팡'] === 2);
  check('빈 값은 (없음)으로', byCh.분류별['(없음)'] === 1);

  const byProj = runTool('count_todos', { group_by: 'project' }, s).result;
  check('대분류별 집계', byProj.분류별['정산'] === 3 && byProj.분류별['영업'] === 2);

  const byMonth = runTool('count_todos', { group_by: 'completed_month', include_done: true, status: '완료' }, s).result;
  check('완료월별 집계', Object.values(byMonth.분류별).reduce((a, b) => a + b, 0) === 1);

  const byDue = runTool('count_todos', { group_by: 'due_month' }, s).result;
  check('마감일 없는 건은 별도 키로', byDue.분류별['(마감일 없음)'] === 1);
}

section('work_stats — 처리 지표');
{
  const s = state();
  const r = runTool('work_stats', {}, s).result;
  check('평균 완료 소요일 계산', r.평균완료소요일 === 17);          // -25 등록 → -8 완료
  check('기한 준수율 = 0% (마감 -10, 완료 -8)', r.기한준수율 === 0);
  check('준수율 기준 건수 보고', r.기한준수_기준건수 === 1);
  check('지연 2건', r.지연건수 === 2);
  check('평균 지연일', r.평균지연일 === 2);                          // (3일 + 1일) / 2
  check('미완료 전체 5건', r.미완료전체 === 5);
  check('마감일 없는 미완료 1건 보고', r.데이터누락.마감일없는미완료 === 1);
  check('이번 달 완료 집계', typeof r.이번달완료 === 'number');

  // 완료일이 비어 있으면 지표에서 빠지는 것을 그대로 보고한다
  const s2 = state();
  s2.todos.push({ id: '7', text: '완료일 없는 완료', projectId: 'p1', registeredDate: shift(-9), dueDate: shift(-2), status: '완료', done: true });
  const r2 = runTool('work_stats', {}, s2).result;
  check('완료일 없는 완료 건을 누락으로 보고', r2.데이터누락.완료일없는완료 === 1);
  check('그 건은 소요일 평균에 섞이지 않음', r2.평균완료소요일 === 17);
}

section('monthly_report');
{
  const s = state();
  const r = runTool('monthly_report', {}, s).result;
  check('기간이 이번 달', r.기간.startsWith(thisMonth));
  check('이번 달 미완료에 지연 표시', r.이번달미완료.every((x) => typeof x.지연 === 'boolean'));
  check('대분류별 요약 포함', typeof r.대분류별 === 'object');
  check('상태를 바꾸지 않음(조회 전용)', runTool('monthly_report', {}, s).changed === false);
}

section('분류(대·중·소) 변경');
{
  const s = state();
  const before = s.subMaster ? s.subMaster.length : 0;
  const out = runTool('update_todo', { text_contains: '쿠팡 수수료', new_channel: '11번가', new_sub_channel: '정산검증' }, s);
  const t = s.todos.find((x) => x.text === '쿠팡 수수료 검증');
  check('중분류 변경', t.channel === '11번가');
  check('소분류 변경', t.subChannel === '정산검증');
  check('무엇을 바꿨는지 보고', out.result.변경.중분류 === '11번가' && out.result.변경.소분류 === '정산검증');
  check('새 중분류가 목록에 등록됨', s.channels.includes('11번가'));
  check('새 소분류가 목록에 등록됨', s.subMaster.includes('정산검증'));

  // 대분류는 기존 목록에서만 — 임의 생성 금지(칸반·캘린더 색을 공유하는 고정 축)
  const s2 = state();
  const ok = runTool('update_todo', { text_contains: '쿠팡 수수료', new_project: '영업' }, s2);
  const t2 = s2.todos.find((x) => x.text === '쿠팡 수수료 검증');
  check('기존 대분류로 이동', t2.projectId === 'p2' && ok.result.변경.대분류 === '영업');

  const s3 = state();
  const bad = runTool('update_todo', { text_contains: '쿠팡 수수료', new_project: '없는분류' }, s3);
  const t3 = s3.todos.find((x) => x.text === '쿠팡 수수료 검증');
  check('없는 대분류는 만들지 않음', s3.projects.length === 2 && t3.projectId === 'p1');
  check('실패 사유를 알려줌', typeof bad.result.변경.대분류_실패 === 'string');

  // 같은 값 재지정은 중복 등록하지 않는다
  const s4 = state();
  runTool('update_todo', { text_contains: '쿠팡 수수료', new_channel: '쿠팡' }, s4);
  check('이미 있는 중분류는 목록에 중복 추가 안 함', s4.channels.filter((c) => c === '쿠팡').length === 1);
}

section('리포트 분류 꼬리표');
{
  const s = state();
  const w = runTool('weekly_report', {}, s).result;
  const m = runTool('monthly_report', {}, s).result;
  const all = [].concat(w.이번주완료 || [], w.다음주예정 || [], w.지연 || [], m.이번달완료 || [], m.이번달미완료 || []);
  check('분류 꼬리표에 소분류까지 포함', all.length === 0 || all.every((x) => typeof x.분류 === 'string'));
  const sample = all.find((x) => (x.분류 || '').split('/').length === 3);
  check('대/중/소 3단으로 표기', !!sample || all.length === 0);
}

section('삭제 시 첨부 정리');
{
  const s = state();
  s.todos[0].files = [{ key: 'ms4i5j0s/q7alzj4x.xlsx', name: '정산서.xlsx', size: 10 }, { key: 'ms4a63bc/5zpdf2b2.pdf', name: '공문.pdf', size: 20 }];
  const out = runTool('delete_todo', { text_contains: '엔터식스 정산 마감' }, s);
  check('할 일 삭제됨', out.changed === true && !s.todos.some((t) => t.text === '엔터식스 정산 마감'));
  check('지울 첨부 키를 함께 반환', Array.isArray(out.deleteFiles) && out.deleteFiles.length === 2);
  check('키 값이 정확', out.deleteFiles[0] === 'ms4i5j0s/q7alzj4x.xlsx');
  check('사용자 응답에도 건수 표시', out.result.첨부삭제 === 2);

  const s2 = state();
  const out2 = runTool('delete_todo', { text_contains: '쿠팡 수수료' }, s2);
  check('첨부 없으면 빈 배열', Array.isArray(out2.deleteFiles) && out2.deleteFiles.length === 0);
  check('첨부 없으면 응답에 표시하지 않음', out2.result.첨부삭제 === undefined);

  const s3 = state();
  const out3 = runTool('delete_todo', { text_contains: '없는업무' }, s3);
  check('대상 없으면 삭제도 첨부 정리도 없음', out3.changed === false && out3.deleteFiles === undefined);
}

section('조회 도구는 데이터를 바꾸지 않는다');
{
  const s = state();
  const before = JSON.stringify(s.todos);
  ['search_todos', 'count_todos', 'work_stats', 'monthly_report'].forEach((n) => runTool(n, {}, s));
  check('todos 원본 무변경', JSON.stringify(s.todos) === before);
  check('changed 플래그 false', ['search_todos', 'count_todos', 'work_stats'].every((n) => runTool(n, {}, s).changed === false));
}
