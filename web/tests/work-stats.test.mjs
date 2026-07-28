// 대시보드 처리 지표 — src/app.js 에서 함수를 추출해 검증한다.
// (브라우저용 조각이라 import가 불가능하므로 소스에서 떼어내 실행)
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const html = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = html.match(re); if (!m) throw new Error('함수 추출 실패: ' + name); return m[0]; };
const computeWorkStats = new Function(grab(/function computeWorkStats\([\s\S]*?\n}/, 'computeWorkStats') + '; return computeWorkStats;')();
const computeTrend = new Function(grab(/function computeTrend\([\s\S]*?\n}/, 'computeTrend') + '; return computeTrend;')();
const computeDataIssues = new Function(grab(/function computeDataIssues\([\s\S]*?\n}/, 'computeDataIssues') + '; return computeDataIssues;')();

const TODAY = '2026-07-28';
const T = (o) => Object.assign({ id: Math.random().toString(36).slice(2), text: '업무' }, o);

section('평균 완료 소요일');
{
  const s = computeWorkStats([
    T({ status: '완료', registeredDate: '2026-07-01', completedDate: '2026-07-08' }),   // 7일
    T({ status: '지연완료', registeredDate: '2026-07-02', completedDate: '2026-07-12' }) // 10일
  ], TODAY);
  check('완료 2건 평균 8.5일', s.avgLead === 8.5);

  const none = computeWorkStats([T({ status: '진행중', registeredDate: '2026-07-01' })], TODAY);
  check('완료 건이 없으면 null', none.avgLead === null);

  const rev = computeWorkStats([
    T({ status: '완료', registeredDate: '2026-07-10', completedDate: '2026-07-01' })     // 날짜 역전
  ], TODAY);
  check('등록일보다 완료일이 빠른 건은 제외', rev.avgLead === null);
}

section('기한 준수율');
{
  const s = computeWorkStats([
    T({ status: '완료', dueDate: '2026-07-10', completedDate: '2026-07-08' }),  // 준수
    T({ status: '완료', dueDate: '2026-07-10', completedDate: '2026-07-10' }),  // 당일 = 준수
    T({ status: '지연완료', dueDate: '2026-07-05', completedDate: '2026-07-09' }) // 초과
  ], TODAY);
  check('3건 중 2건 → 67%', s.onTimeRate === 67);
  check('기준 건수도 함께 보고', s.onTimeBase === 3);

  const noDue = computeWorkStats([T({ status: '완료', completedDate: '2026-07-08' })], TODAY);
  check('마감일 없는 완료 건은 분모에서 제외', noDue.onTimeRate === null && noDue.onTimeBase === 0);
}

section('이번 달 완료 · 전월 대비');
{
  const s = computeWorkStats([
    T({ status: '완료', completedDate: '2026-07-08' }),
    T({ status: '완료', completedDate: '2026-07-20' }),
    T({ status: '완료', completedDate: '2026-06-28' })
  ], TODAY);
  check('이번 달 2건', s.doneThisMonth === 2);
  check('전월 1건', s.donePrevMonth === 1);
  check('증감 +1', s.monthDelta === 1);

  // 연초 경계: 1월의 전월은 작년 12월
  const jan = computeWorkStats([
    T({ status: '완료', completedDate: '2026-01-05' }),
    T({ status: '완료', completedDate: '2025-12-30' })
  ], '2026-01-15');
  check('1월의 전월은 전년 12월', jan.doneThisMonth === 1 && jan.donePrevMonth === 1);
}

section('지연 중');
{
  const s = computeWorkStats([
    T({ status: '진행중', dueDate: '2026-07-20' }),   // 8일 지연
    T({ status: '대기', dueDate: '2026-07-24' }),     // 4일 지연
    T({ status: '대기', dueDate: '2026-07-28' }),     // 오늘 = 지연 아님
    T({ status: '완료', dueDate: '2026-07-01', completedDate: '2026-07-30' }) // 완료 = 제외
  ], TODAY);
  check('지연 2건', s.overdueCount === 2);
  check('평균 6일 경과', s.avgLate === 6);

  const clean = computeWorkStats([T({ status: '대기', dueDate: '2026-08-30' })], TODAY);
  check('지연 없으면 평균은 null', clean.overdueCount === 0 && clean.avgLate === null);
}

section('월별 추이 (computeTrend)');
{
  const todos = [
    T({ status: '완료', registeredDate: '2026-05-03', completedDate: '2026-05-20' }),
    T({ status: '완료', registeredDate: '2026-05-10', completedDate: '2026-06-05' }), // 5월 등록 → 6월 완료
    T({ status: '진행중', registeredDate: '2026-06-15' }),                            // 계속 미완료
    T({ status: '완료', registeredDate: '2026-07-01', completedDate: '2026-07-08' })
  ];
  const t = computeTrend(todos, TODAY, 3);           // 5·6·7월
  const by = Object.fromEntries(t.rows.map((r) => [r.key, r]));

  check('요청한 개월 수만큼 반환', t.rows.length === 3);
  check('가장 오래된 달이 먼저', t.rows[0].key === '2026-05' && t.rows[2].key === '2026-07');
  check('마지막 달만 current', t.rows.filter((r) => r.current).length === 1 && t.rows[2].current === true);

  check('5월 등록 2건 · 완료 1건', by['2026-05'].reg === 2 && by['2026-05'].comp === 1);
  check('완료는 완료일 기준으로 6월에 집계', by['2026-06'].comp === 1 && by['2026-06'].reg === 1);
  check('순증감 = 등록 − 완료', by['2026-05'].delta === 1 && by['2026-06'].delta === 0);

  // 월말 잔량: 그 달 말까지 등록됐고 그때까지 완료되지 않은 건
  check('5월말 잔량 1건', by['2026-05'].backlog === 1);          // 5/10 등록 건이 미완료
  check('6월말 잔량 1건', by['2026-06'].backlog === 1);          // 6/15 등록 건
  check('7월말 잔량 1건', by['2026-07'].backlog === 1);          // 7월 건은 완료, 6월 건 남음

  check('합계와 순증감', t.totalReg === 4 && t.totalComp === 3 && t.net === 1);

  // 연도 경계
  const y = computeTrend([T({ status: '완료', registeredDate: '2025-12-05', completedDate: '2025-12-20' })], '2026-01-15', 2);
  check('12월 → 1월로 연도를 넘어감', y.rows[0].key === '2025-12' && y.rows[1].key === '2026-01');
  check('작년 12월 집계 정상', y.rows[0].reg === 1 && y.rows[0].comp === 1 && y.rows[0].backlog === 0);

  // 미래 등록 건은 과거 달 잔량에 포함되면 안 된다
  const fut = computeTrend([T({ status: '대기', registeredDate: '2026-07-20' })], TODAY, 3);
  check('등록 전 달의 잔량은 0', fut.rows[0].backlog === 0 && fut.rows[1].backlog === 0);
  check('등록된 달부터 잔량에 반영', fut.rows[2].backlog === 1);

  check('데이터가 없어도 빈 달을 채운다', computeTrend([], TODAY, 6).rows.length === 6);
}

section('데이터 점검 (computeDataIssues)');
{
  const todos = [
    T({ status: '완료', registeredDate: '2026-07-01', dueDate: '2026-07-10', completedDate: '2026-07-08' }), // 정상
    T({ status: '완료', registeredDate: '2026-06-01', dueDate: '2026-06-10' }),                              // 완료일 없음
    T({ status: '지연완료', registeredDate: '2026-05-01', dueDate: '2026-05-20' }),                          // 완료일 없음
    T({ status: '완료', registeredDate: '2026-07-10', dueDate: '2026-07-20', completedDate: '2026-07-01' }), // 날짜 역전
    T({ status: '진행중', registeredDate: '2026-07-02', dueDate: '2026-07-15', completedDate: '2026-07-09' }), // 완료일만 있음
    T({ status: '대기', registeredDate: '2026-07-03' })                                                       // 마감일 없음
  ];
  const i = computeDataIssues(todos);
  check('완료인데 완료일 없음 2건', i.doneNoDate.length === 2);
  check('지연완료도 완료로 본다', i.doneNoDate.some((t) => t.status === '지연완료'));
  check('날짜 역전 1건', i.reversed.length === 1);
  check('완료일만 있고 미완료 1건', i.dateButOpen.length === 1);
  check('미완료인데 마감일 없음 1건', i.openNoDue.length === 1);
  check('정상 건은 어디에도 안 잡힘', i.total === 5);

  check('결함 없으면 total 0', computeDataIssues([todos[0]]).total === 0);
  check('빈 배열도 안전', computeDataIssues([]).total === 0);
  check('배열이 아니어도 안전', computeDataIssues(null).total === 0);

  // 완료일 누락 건이 지표를 어떻게 왜곡하는지 — 점검 카드를 만든 이유
  const s = computeWorkStats(todos, TODAY);
  check('완료일 없는 완료 건은 소요일 분모에서 빠짐', s.avgLead === 7);         // 정상 1건만 계산
  check('완료일 없는 완료 건은 준수율 분모에서도 빠짐', s.onTimeBase === 2);    // 정상 + 역전 건
}

section('구형 데이터 호환');
{
  // status 없이 done 불린만 있던 초기 데이터
  const s = computeWorkStats([
    T({ done: true, registeredDate: '2026-07-01', completedDate: '2026-07-05', dueDate: '2026-07-10' }),
    T({ done: false, dueDate: '2026-07-20' })
  ], TODAY);
  check('done:true 를 완료로 인식', s.avgLead === 4 && s.onTimeRate === 100);
  check('done:false 는 지연 계산에 포함', s.overdueCount === 1);
}
