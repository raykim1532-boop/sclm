// 업무 로그 · 마감일 변경 이력 — src/app.js 에서 순수 함수를 추출해 검증한다.
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const src = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('함수 추출 실패: ' + name); return m[0]; };
const F = new Function([
  grab(/function todoLogs\([\s\S]*?\r?\n}/, 'todoLogs'),
  grab(/function todoLogLatest\([\s\S]*?\r?\n}/, 'todoLogLatest'),
  grab(/function todoProgressCell\([\s\S]*?\r?\n}/, 'todoProgressCell'),
  grab(/function mmddDot\([\s\S]*?\r?\n}/, 'mmddDot'),
  grab(/function todoLogsText\([\s\S]*?\r?\n}/, 'todoLogsText'),
  grab(/function todoDueHistory\([\s\S]*?\r?\n}/, 'todoDueHistory'),
  grab(/function dueMoveCount\([\s\S]*?\r?\n}/, 'dueMoveCount'),
  grab(/function dueHistoryText\([\s\S]*?\r?\n}/, 'dueHistoryText'),
  grab(/function pushDueHistory\([\s\S]*?\r?\n}/, 'pushDueHistory'),
  'return { todoLogs, todoLogLatest, todoProgressCell, mmddDot, todoLogsText, todoDueHistory, dueMoveCount, dueHistoryText, pushDueHistory };'
].join('\n'))();

section('업무 로그 — 읽기와 정규화');
{
  const t = { logs: [{ at: '2026-07-20', text: '자료 요청' }, { at: '2026-07-23', text: '대표님 보고' }] };
  check('2건', F.todoLogs(t).length === 2);
  check('최신은 날짜가 큰 쪽', F.todoLogLatest(t).text === '대표님 보고');

  check('logs 없으면 빈 배열', F.todoLogs({}).length === 0);
  check('logs 가 배열이 아니어도 안전', F.todoLogs({ logs: 'x' }).length === 0);
  check('빈 텍스트는 걸러진다', F.todoLogs({ logs: [{ at: '2026-07-20', text: '  ' }, { at: '2026-07-21', text: 'ok' }] }).length === 1);
  check('로그 없으면 최신도 null', F.todoLogLatest({}) === null);

  const sameDay = { logs: [{ at: '2026-07-23', text: '먼저' }, { at: '2026-07-23', text: '나중' }] };
  check('같은 날이면 나중에 적은 것이 최신', F.todoLogLatest(sameDay).text === '나중');
}

section('표에 보일 문자열');
{
  check('로그가 있으면 최신 로그',
    F.todoProgressCell({ logs: [{ at: '2026-07-23', text: '대표님 보고' }] }) === '07/23 대표님 보고');
  check('로그가 없으면 옛 progress 그대로',
    F.todoProgressCell({ progress: '7/21 담당자 소통' }) === '7/21 담당자 소통');
  check('둘 다 있으면 로그 우선',
    F.todoProgressCell({ progress: '옛 기록', logs: [{ at: '2026-07-23', text: '새 기록' }] }) === '07/23 새 기록');
  check('둘 다 없으면 빈 문자열', F.todoProgressCell({}) === '');

  check('mmddDot 변환', F.mmddDot('2026-07-30') === '07/30');
  check('mmddDot 잘못된 값은 빈 문자열', F.mmddDot('') === '' && F.mmddDot('7/30') === '');
  check('검색용 전체 이어붙이기',
    F.todoLogsText({ logs: [{ at: '2026-07-20', text: 'A' }, { at: '2026-07-23', text: 'B' }] }) === '07/20 A 07/23 B');
}

section('마감일 변경 이력 — 기록 규칙');
{
  const t = { dueDate: '2026-07-24' };
  check('처음 값이 있고 바뀌면 기록', F.pushDueHistory(t, '2026-07-31', '2026-07-24') === true);
  check('이력 내용', t.dueHistory.length === 1 && t.dueHistory[0].from === '2026-07-24' && t.dueHistory[0].to === '2026-07-31');

  t.dueDate = '2026-07-31';
  check('같은 값이면 기록 안 함', F.pushDueHistory(t, '2026-07-31', '2026-07-31') === false);
  check('이력 그대로 1건', t.dueHistory.length === 1);

  const fresh = { dueDate: '' };
  check('마감일을 처음 넣는 건 변경이 아니다', F.pushDueHistory(fresh, '2026-08-01', '2026-07-30') === false);
  check('이력이 생기지 않는다', !fresh.dueHistory);

  const cleared = { dueDate: '2026-08-01' };
  F.pushDueHistory(cleared, '', '2026-07-30');
  check('마감일을 지운 것도 기록', cleared.dueHistory.length === 1 && cleared.dueHistory[0].to === '');
}

section('밀림 횟수 — 뒤로 민 것만 센다');
{
  const t = {
    dueHistory: [
      { from: '2026-07-20', to: '2026-07-24', at: '2026-07-20' },   // 미룸
      { from: '2026-07-24', to: '2026-07-22', at: '2026-07-23' },   // 당김
      { from: '2026-07-22', to: '2026-07-31', at: '2026-07-24' }    // 미룸
    ]
  };
  check('미룬 것만 2회', F.dueMoveCount(t) === 2);
  check('이력 자체는 3건 다 남는다', F.todoDueHistory(t).length === 3);
  check('이력 없으면 0', F.dueMoveCount({}) === 0);
  check('배열이 아니어도 안전', F.dueMoveCount({ dueHistory: 'x' }) === 0);

  const txt = F.dueHistoryText(t);
  check('툴팁에 변경 3줄', txt.split('\n').length === 3);
  check('툴팁 형식', txt.split('\n')[0] === '07/20 → 07/24  (07/20 변경)');
  check('빈 값은 "없음"', F.dueHistoryText({ dueHistory: [{ from: '2026-08-01', to: '', at: '2026-07-30' }] }).indexOf('→ 없음') > 0);
}
