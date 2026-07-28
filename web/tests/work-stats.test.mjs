// 대시보드 처리 지표 — MySchedulerApp.html의 computeWorkStats를 추출해 검증한다.
// (앱이 단일 HTML이라 import가 불가능하므로 소스에서 떼어내 실행)
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const html = readFileSync(new URL('../../MySchedulerApp.html', import.meta.url), 'utf8');
const m = html.match(/function computeWorkStats\([\s\S]*?\n}/);
if (!m) throw new Error('함수 추출 실패: computeWorkStats');
const computeWorkStats = new Function(m[0] + '; return computeWorkStats;')();

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
