// 월간 정기업무 — src/app.js 에서 순수 함수를 추출해 검증한다.
// 배경: 정산·지출결의서처럼 매달 같은 일을 손으로 다시 등록하고 있었다(2026-08-03 아침에만 4건).
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const src = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('추출 실패: ' + name); return m[0]; };
const F = new Function([
  grab(/let _uidSeq = 0;\r?\nconst uid = [^\r\n]*/, 'uid'),
  grab(/function monthKey\([^\r\n]*/, 'monthKey'),
  grab(/function addMonth\([\s\S]*?\r?\n}/, 'addMonth'),
  grab(/function fillMonthTokens\([\s\S]*?\r?\n}/, 'fillMonthTokens'),
  grab(/function dayInMonth\([\s\S]*?\r?\n}/, 'dayInMonth'),
  grab(/function dueTemplatesFor\([\s\S]*?\r?\n}/, 'dueTemplatesFor'),
  grab(/function todoFromTemplate\([\s\S]*?\r?\n}/, 'todoFromTemplate'),
  'return { monthKey, addMonth, fillMonthTokens, dayInMonth, dueTemplatesFor, todoFromTemplate };'
].join('\n'))();

const TPL = (o) => Object.assign({ id: 'r1', text: '{전월} 법인카드 사용내역 품의', projectId: 'p1', channel: '기타', subChannel: '지출결의서', priority: '중요', assignee: '김성철', createDay: 1, dueDay: 10, active: true }, o);

section('월 계산');
{
  check('다음 달', F.addMonth('2026-08', 1) === '2026-09');
  check('지난 달', F.addMonth('2026-08', -1) === '2026-07');
  check('해를 넘어 앞으로', F.addMonth('2026-12', 1) === '2027-01');
  check('해를 넘어 뒤로', F.addMonth('2026-01', -1) === '2025-12');
  check('monthKey', F.monthKey('2026-08-03') === '2026-08');
}

section('제목의 월 자리표시자');
{
  const f = (t) => F.fillMonthTokens(t, '2026-08-03');
  check('{전월} → 26.07', f('{전월} 법인카드 사용내역 품의') === '26.07 법인카드 사용내역 품의');
  check('{당월} → 26.08', f('{당월} 정산') === '26.08 정산');
  check('{전월M} → 7월', f('{전월M} 엔터식스 프로모션 비용') === '7월 엔터식스 프로모션 비용');
  check('{당월M} → 8월', f('{당월M} 도급비') === '8월 도급비');
  check('여러 개도 바뀐다', f('{전월} / {당월M}') === '26.07 / 8월');
  check('자리표시자가 없으면 그대로', f('그냥 제목') === '그냥 제목');
  check('연초에도 맞다', F.fillMonthTokens('{전월}', '2026-01-05') === '25.12');
  check('빈 값 안전', f('') === '' && F.fillMonthTokens(null, '2026-08-03') === '');
}

section('날짜 만들기 — 말일 처리');
{
  check('평범한 날', F.dayInMonth('2026-08', 10) === '2026-08-10');
  check('말일 넘으면 말일로', F.dayInMonth('2026-02', 31) === '2026-02-28');
  check('30일 달', F.dayInMonth('2026-09', 31) === '2026-09-30');
  check('윤년 2월', F.dayInMonth('2028-02', 31) === '2028-02-29');
  check('0이나 음수는 1일로', F.dayInMonth('2026-08', 0) === '2026-08-01');
}

section('이번 달에 만들 템플릿 고르기');
{
  const t = TPL({ createDay: 1 });
  check('생성일이 지났으면 대상', F.dueTemplatesFor([t], '2026-08-03').length === 1);

  const later = TPL({ createDay: 25 });
  check('생성일 전이면 아직 아님', F.dueTemplatesFor([later], '2026-08-03').length === 0);
  check('생성일 당일이면 대상', F.dueTemplatesFor([later], '2026-08-25').length === 1);

  check('이번 달에 이미 만들었으면 제외', F.dueTemplatesFor([TPL({ lastRunMonth: '2026-08' })], '2026-08-03').length === 0);
  check('지난 달에 만든 건 이번 달 대상', F.dueTemplatesFor([TPL({ lastRunMonth: '2026-07' })], '2026-08-03').length === 1);

  check('꺼둔 건 제외', F.dueTemplatesFor([TPL({ active: false })], '2026-08-03').length === 0);
  check('제목이 비면 제외', F.dueTemplatesFor([TPL({ text: '  ' })], '2026-08-03').length === 0);
  check('배열이 아니어도 안전', F.dueTemplatesFor(null, '2026-08-03').length === 0);
}

section('템플릿 → 할 일');
{
  const t = F.todoFromTemplate(TPL({}), '2026-08-03', 62);
  check('제목이 채워진다', t.text === '26.07 법인카드 사용내역 품의');
  check('등록일은 오늘', t.registeredDate === '2026-08-03');
  check('마감일', t.dueDate === '2026-08-10');
  check('분류가 옮겨온다', t.projectId === 'p1' && t.channel === '기타' && t.subChannel === '지출결의서');
  check('담당자·우선순위', t.assignee === '김성철' && t.priority === '중요');
  check('상태는 대기', t.status === '대기' && t.done === false);
  check('번호가 붙는다', t.no === 62);
  check('어느 템플릿에서 왔는지 남는다', t.fromTemplate === 'r1');
  check('로그·첨부는 빈 상태', t.logs.length === 0 && t.files.length === 0);

  // 마감일이 생성일보다 앞이면 다음 달 마감
  const cross = F.todoFromTemplate(TPL({ createDay: 25, dueDay: 5 }), '2026-08-25', 1);
  check('말일 즈음 생성 → 다음 달 마감', cross.dueDate === '2026-09-05');

  // 마감일을 안 주면 생성일과 같은 날
  const noDue = F.todoFromTemplate(TPL({ createDay: 3, dueDay: undefined }), '2026-08-03', 1);
  check('마감일 없으면 생성일과 같게', noDue.dueDate === '2026-08-03');

  check('id 가 매번 다르다',
    F.todoFromTemplate(TPL({}), '2026-08-03', 1).id !== F.todoFromTemplate(TPL({}), '2026-08-03', 2).id);
}

section('실제 쓰시는 4건 그대로');
{
  // 2026-08-03 아침에 손으로 만든 것들
  const real = [
    TPL({ id: 'a', text: '{전월} 법인카드 사용내역 품의', channel: '기타', subChannel: '지출결의서' }),
    TPL({ id: 'b', text: '{전월} 쇼멘토 광고비', channel: '기타', subChannel: '광고비' }),
    TPL({ id: 'c', text: '{전월} 동진특송 물류비 지출결의서', channel: '엔터식스', subChannel: '동진특송' }),
    TPL({ id: 'd', text: '{전월} 대백 알바비 정산', channel: '대구백화점', subChannel: '지출결의서' }),
  ];
  const due = F.dueTemplatesFor(real, '2026-08-03');
  check('4건 모두 대상', due.length === 4);
  const made = due.map((t, i) => F.todoFromTemplate(t, '2026-08-03', 100 + i));
  check('제목이 실제와 같다', made[0].text === '26.07 법인카드 사용내역 품의');
  check('두 번째도', made[1].text === '26.07 쇼멘토 광고비');
  check('중분류가 각각 다르게 붙는다', made[2].channel === '엔터식스' && made[3].channel === '대구백화점');
  check('번호가 안 겹친다', new Set(made.map((t) => t.no)).size === 4);
}
