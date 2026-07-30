// 대시보드 '분류 Top' 집계 — src/app.js 에서 computeTaxoTop 을 추출해 검증한다.
// 대·중·소 세 축이 같은 함수를 쓰므로, pick 만 바꿔 끼우면 축별 동작이 다 확인된다.
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const src = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('함수 추출 실패: ' + name); return m[0]; };
const computeTaxoTop = new Function(
  grab(/function computeTaxoTop\([\s\S]*?\r?\n}/, 'computeTaxoTop') + '; return computeTaxoTop;'
)();

const isDone = (t) => t.status === '완료';
const T = (channel, sub, status) => ({ channel, subChannel: sub, status });
const mid = (t) => t.channel || '';
const sub = (t) => t.subChannel || '';

section('축별 집계 — 전체·완료·미완료');
{
  const rows = computeTaxoTop([
    T('마리오아울렛', '하프클럽', '완료'),
    T('마리오아울렛', '패션플러스', '진행중'),
    T('마리오아울렛', '하프클럽', '대기'),
    T('사방넷', '하프클럽', '완료')
  ], mid, isDone);

  const mario = rows.find((r) => r.name === '마리오아울렛');
  check('전체 건수', mario.total === 3);
  check('완료 건수', mario.done === 1);
  check('미완료 건수', mario.open === 2);
  check('total = done + open', rows.every((r) => r.total === r.done + r.open));
  check('축이 다르면 집계도 다르다', computeTaxoTop([
    T('마리오아울렛', '하프클럽', '완료'),
    T('사방넷', '하프클럽', '완료')
  ], sub, isDone).length === 1);
}

section('정렬 — 남은 일이 많은 순');
{
  const rows = computeTaxoTop([
    T('A', '', '완료'), T('A', '', '완료'), T('A', '', '완료'),   // 전체 3, 남음 0
    T('B', '', '진행중'), T('B', '', '대기'),                      // 전체 2, 남음 2
    T('C', '', '진행중')                                            // 전체 1, 남음 1
  ], mid, isDone);
  check('남은 일 많은 축이 위로', rows.map((r) => r.name).join(',') === 'B,C,A');

  const tie = computeTaxoTop([
    T('적게', '', '진행중'),
    T('많이', '', '진행중'), T('많이', '', '완료')
  ], mid, isDone);
  check('남은 수가 같으면 전체가 많은 쪽이 위로', tie[0].name === '많이');
}

section('(미지정) 처리');
{
  const rows = computeTaxoTop([
    T('마리오아울렛', '', '진행중'),
    T('', '', '진행중'), T('', '', '진행중'), T('', '', '진행중')
  ], mid, isDone);
  check('빈 값은 한 줄로 모인다', rows.filter((r) => !r.name).length === 1);
  check('미지정 건수 집계', rows.find((r) => !r.name).total === 3);
  check('남은 일이 더 많아도 미지정은 맨 아래', rows[rows.length - 1].name === '');

  const onlyNone = computeTaxoTop([T('', '', '대기')], mid, isDone);
  check('전부 미지정이어도 한 줄은 나온다', onlyNone.length === 1 && onlyNone[0].total === 1);
}

section('공백·상한·빈 입력');
{
  const rows = computeTaxoTop([T('  마리오아울렛  ', '', '대기'), T('마리오아울렛', '', '대기')], mid, isDone);
  check('앞뒤 공백은 같은 분류로 합친다', rows.length === 1 && rows[0].total === 2);

  const many = [];
  for (let i = 0; i < 12; i++) many.push(T('CH' + i, '', '진행중'));
  check('limit 만큼만 돌려준다', computeTaxoTop(many, mid, isDone, 8).length === 8);
  check('limit 없으면 전부', computeTaxoTop(many, mid, isDone).length === 12);

  check('빈 배열 안전', computeTaxoTop([], mid, isDone).length === 0);
  check('배열이 아니어도 안전', computeTaxoTop(null, mid, isDone).length === 0);
}

/* ---- 행 마크업 ---- */
const taxoRowHtml = new Function('escapeHtml',
  grab(/function taxoRowHtml\([\s\S]*?\r?\n}/, 'taxoRowHtml') + '; return taxoRowHtml;'
)((v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'));

section('행 마크업 — 2중 막대');
{
  const html = taxoRowHtml({ name: '마리오아울렛', total: 26, done: 19, open: 7 }, '#1a73e8', 26);
  check('바깥 막대 = 전체/최댓값', html.includes('width:100%;background:color-mix(in srgb, #1a73e8 22%, transparent)'));
  check('안쪽 막대 = 완료 비율', html.includes('width:73%;background:#1a73e8'));
  check('남은 건수 표시', html.includes('<b>7</b> 남음'));
  check('전체·완료율 표시', html.includes('/ 26 · 73%'));

  const half = taxoRowHtml({ name: '사방넷', total: 13, done: 0, open: 13 }, '#eb5757', 26);
  check('전체가 절반이면 바깥 막대도 절반', half.includes('width:50%;background:color-mix'));
  check('완료 0이면 안쪽 막대 0', half.includes('width:0%;background:#eb5757'));
}

section('행 마크업 — (미지정)과 이스케이프');
{
  const none = taxoRowHtml({ name: '', total: 49, done: 0, open: 49 }, '#9b9a97', 49);
  check('미지정 클래스', none.includes('an-row-none'));
  check('미지정 라벨', none.includes('(미지정)'));

  const evil = taxoRowHtml({ name: '<img src=x>"', total: 1, done: 1, open: 0 }, '#000', 1);
  check('이름의 태그는 이스케이프된다', !evil.includes('<img') && evil.includes('&lt;img'));
  check('title 속성 안에도 날 태그가 없다', !/title="[^"]*</.test(evil));

  check('전체 0이어도 죽지 않는다', taxoRowHtml({ name: 'X', total: 0, done: 0, open: 0 }, '#000', 0).includes('0%'));
}

section('핸들러 선택자 충돌 방지');
{
  // 2026-07-29: 추이 카드의 기간 토글이 .an-seg-btn 전체를 잡는 바람에, 같은 클래스를 쓰는
  //             분류 탭의 onclick 을 나중에 덮어써서 탭이 통째로 죽었다. 같은 실수 재발 방지.
  const body = grab(/function renderDashAnalytics\([\s\S]*?\r?\n}/, 'renderDashAnalytics');
  check('기간 토글은 [data-months] 로만 잡는다', body.includes("querySelectorAll('[data-months]')"));
  check('공용 클래스(.an-seg-btn)로 핸들러를 걸지 않는다', !body.includes("querySelectorAll('.an-seg-btn')"));
  check('분류 탭은 [data-taxo] 로 잡는다', body.includes("querySelectorAll('[data-taxo]')"));

  // 두 선택자가 실제로 겹치지 않는지 — 탭 버튼 마크업에 data-months 가 섞여 있으면 안 된다
  const tabMarkup = (body.match(/data-taxo="[^"]*"[^>]*>/) || [''])[0];
  check('분류 탭 버튼에 data-months 가 없다', !!tabMarkup && !tabMarkup.includes('data-months'));
}

section('밀리는 분류 (computeStuckTaxo)');
{
  const computeStuckTaxo = new Function(
    grab(/function computeStuckTaxo\([\s\S]*?\r?\n}/, 'computeStuckTaxo') + '; return computeStuckTaxo;'
  )();

  const TODAY = '2026-07-29';
  const AX = [{ label: '중분류', pick: (t) => t.channel || '' }];
  const T = (ch, due, status) => ({ id: Math.random().toString(36).slice(2), text: '업무', channel: ch, dueDate: due, status: status || '대기' });

  // 엔터식스: 지연 3건 / 쿠팡: 지연 1건 / 11번가: 표본 2건뿐
  const todos = [
    T('엔터식스', '2026-07-10'), T('엔터식스', '2026-07-20'), T('엔터식스', '2026-07-25'),
    T('엔터식스', '2026-08-10'), T('엔터식스', '2026-07-01', '완료'),
    T('쿠팡', '2026-07-20'), T('쿠팡', '2026-08-01'), T('쿠팡', '2026-08-02'),
    T('11번가', '2026-07-01'), T('11번가', '2026-07-02')
  ];
  const r = computeStuckTaxo(todos, AX, TODAY, 3, 5);
  check('지연 2건 이상만 잡는다', r.length === 1 && r[0].name === '엔터식스');
  check('지연 건수 정확', r[0].overdue === 3);
  check('평균 지연일 정확', r[0].avgLate === 10.7);           // (19+9+4)/3 = 10.67
  check('완료율 함께 보고', r[0].donePct === 20);              // 5건 중 1건 완료
  check('축 이름 표시', r[0].axis === '중분류');
  check('표본 3건 미만은 제외', !r.some((x) => x.name === '11번가'));
  check('지연 1건짜리는 제외', !r.some((x) => x.name === '쿠팡'));

  // (미지정)은 데이터 점검 몫이라 여기서 다루지 않는다
  const blanks = [T('', '2026-07-01'), T('', '2026-07-02'), T('', '2026-07-03')];
  check('빈 분류는 대상 아님', computeStuckTaxo(blanks, AX, TODAY, 3, 5).length === 0);

  // '기타'도 분류가 아니라 잡동사니 — 서로 무관한 건이 모여 경고가 행동으로 이어지지 않는다
  const etc = [T('기타', '2026-07-01'), T('기타', '2026-07-02'), T('기타', '2026-07-03')];
  check("'기타'는 대상 아님", computeStuckTaxo(etc, AX, TODAY, 3, 5).length === 0);
  check("'기타'는 앞뒤 공백이 있어도 제외", computeStuckTaxo(
    [T(' 기타 ', '2026-07-01'), T('기타', '2026-07-02'), T('기타', '2026-07-03')], AX, TODAY, 3, 5
  ).length === 0);
  // 다른 값에 '기타'가 섞여 있을 뿐이면 정상 대상이다(부분일치로 지우지 않는다)
  const etcish = [T('기타업무', '2026-07-01'), T('기타업무', '2026-07-02'), T('기타업무', '2026-07-03')];
  const re = computeStuckTaxo(etcish, AX, TODAY, 3, 5);
  check("'기타'가 포함된 다른 이름은 살린다", re.length === 1 && re[0].name === '기타업무');
  // '기타'를 뺀 자리에 다른 분류가 정상적으로 남는지 — 통째로 죽지 않는다
  const mixed = [
    T('기타', '2026-07-01'), T('기타', '2026-07-02'), T('기타', '2026-07-03'),
    T('쿠팡', '2026-07-01'), T('쿠팡', '2026-07-02'), T('쿠팡', '2026-07-03')
  ];
  const rm = computeStuckTaxo(mixed, AX, TODAY, 3, 5);
  check("'기타'만 빠지고 나머지는 남는다", rm.length === 1 && rm[0].name === '쿠팡');

  // 정렬: 지연 많은 순 → 평균 지연일 순
  const two = [
    T('A', '2026-07-27'), T('A', '2026-07-28'), T('A', '2026-07-26'),
    T('B', '2026-07-01'), T('B', '2026-07-02'), T('B', '2026-07-03')
  ];
  const s2 = computeStuckTaxo(two, AX, TODAY, 3, 5);
  check('지연 수가 같으면 오래 밀린 쪽이 위로', s2[0].name === 'B');

  check('빈 입력도 안전', computeStuckTaxo([], AX, TODAY, 3, 5).length === 0);
  check('축이 없으면 빈 결과', computeStuckTaxo(todos, [], TODAY, 3, 5).length === 0);
  check('limit 적용', computeStuckTaxo(two, AX, TODAY, 3, 1).length === 1);
}
