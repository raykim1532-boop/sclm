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
