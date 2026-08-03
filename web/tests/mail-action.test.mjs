// /api/mail-action — 메일에서 앱을 열지 않고 완료 처리하는 서명 링크.
//
// ⚠️ 이 파일에서 가장 중요한 절은 'GET 은 상태를 바꾸지 않는다'이다.
//    회사 메일 보안 장치(아웃룩 Safe Links 등)가 메일 속 링크를 사람 대신 미리 열어 보는데,
//    GET 이 완료 처리를 하면 메일이 도착하자마자 전 항목이 완료로 바뀐다.
import { API, check, section, mockDB, mockRequest } from './_helpers.mjs';

const { onRequestGet, onRequestPost, actionUrl, expiryIso } = await import(API + 'mail-action.js');
const { signParts, verifyParts } = await import(API + '_sign.js');

const PW = 'app-secret-pw';
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const day = (n) => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const T = (o) => Object.assign({ id: 't1', text: '엔터식스 공문 발송', dueDate: TODAY, status: '대기', channel: '엔터식스', subChannel: '운영' }, o);

function ctx(docs, url, method) {
  return { env: { APP_PASSWORD: PW, DB: mockDB(docs) }, request: mockRequest({}, {}, url) };
}
const todos = (docs) => JSON.parse(docs.main).todos;
const first = (docs) => todos(docs)[0];
const body = async (res) => await res.text();

/* 테스트용 링크 — 실제 코드와 같은 방식으로 서명한다 */
async function link(a, id, opts) {
  return await actionUrl({ APP_PASSWORD: PW }, a, id, opts);
}

section('서명 — 위조 불가');
{
  const sig = await signParts(PW, ['done', 't1', '2026-08-10', '']);
  check('서명이 만들어진다', typeof sig === 'string' && sig.length > 20);
  check('URL 에 안전한 문자만', /^[A-Za-z0-9_-]+$/.test(sig));
  check('같은 입력 → 같은 서명', sig === await signParts(PW, ['done', 't1', '2026-08-10', '']));
  check('id 가 다르면 서명도 다르다', sig !== await signParts(PW, ['done', 't2', '2026-08-10', '']));
  check('동작이 다르면 서명도 다르다', sig !== await signParts(PW, ['undo', 't1', '2026-08-10', '']));
  check('만료일이 다르면 서명도 다르다', sig !== await signParts(PW, ['done', 't1', '2026-08-11', '']));
  check('키가 다르면 서명도 다르다', sig !== await signParts('other-pw', ['done', 't1', '2026-08-10', '']));
  check('검증 통과', await verifyParts(PW, ['done', 't1', '2026-08-10', ''], sig) === true);
  check('한 글자만 바꿔도 실패', await verifyParts(PW, ['done', 't1', '2026-08-10', ''], sig.slice(0, -1) + 'X') === false);
  check('서명이 없으면 실패', await verifyParts(PW, ['done', 't1', '2026-08-10', ''], '') === false);
  check('키가 없으면 실패', await verifyParts('', ['done', 't1', '2026-08-10', ''], sig) === false);
  // 구분자가 없으면 ['a','bc'] 와 ['ab','c'] 가 같은 서명이 된다
  check('필드 경계가 서명에 반영된다', await signParts(PW, ['ab', 'c']) !== await signParts(PW, ['a', 'bc']));

  check('링크에 비밀번호가 실리지 않는다', !(await link('done', 't1')).includes(PW));
  check('만료일 기본 7일', expiryIso() === day(7));
}

section('GET 은 상태를 바꾸지 않는다 (메일 보안 스캐너 대비)');
{
  const docs = { main: JSON.stringify({ todos: [T({})] }) };
  const url = await link('done', 't1');
  const res = await onRequestGet(ctx(docs, url));
  const html = await body(res);

  check('200 응답', res.status === 200);
  check('상태 그대로 대기', first(docs).status === '대기');
  check('완료일도 안 생김', !first(docs).completedDate);
  check('로그도 안 남음', !(first(docs).logs || []).length);
  check('확인 버튼을 보여 준다', html.includes('<form method="post"') && html.includes('완료로 표시'));
  check('업무 내용이 보인다', html.includes('엔터식스 공문 발송'));
  check('현재 상태를 알려 준다', html.includes('현재 대기'));
  check('검색엔진 차단', html.includes('noindex'));
}

section('POST 에서만 실제로 바뀐다');
{
  const docs = { main: JSON.stringify({ todos: [T({})] }) };
  const res = await onRequestPost(ctx(docs, await link('done', 't1')));
  const html = await body(res);
  const t = first(docs);

  check('완료로 바뀜', t.status === '완료');
  check('done 플래그도 맞춤', t.done === true);
  check('완료일이 오늘', t.completedDate === TODAY);
  check('출처를 로그로 남김', (t.logs || []).some((l) => l.text === '메일에서 완료 처리' && l.at === TODAY));
  check('결과 화면', html.includes('완료로 표시했어요'));
  check('되돌리기 링크 제공', html.includes('되돌리기') && html.includes('a=undo'));
}

section('마감이 지난 건은 지연완료 (앱과 같은 규칙)');
{
  const docs = { main: JSON.stringify({ todos: [T({ dueDate: day(-3) })] }) };
  await onRequestPost(ctx(docs, await link('done', 't1')));
  check('지연완료로 기록', first(docs).status === '지연완료');
  check('완료일은 오늘', first(docs).completedDate === TODAY);

  // 마감일이 없으면 지연 판정 자체가 불가 → 그냥 완료
  const d2 = { main: JSON.stringify({ todos: [T({ dueDate: '' })] }) };
  await onRequestPost(ctx(d2, await link('done', 't1')));
  check('마감일 없으면 완료', first(d2).status === '완료');
}

section('되돌리기');
{
  const docs = { main: JSON.stringify({ todos: [T({ status: '진행중' })] }) };
  await onRequestPost(ctx(docs, await link('done', 't1')));
  check('완료됨', first(docs).status === '완료');

  await onRequestPost(ctx(docs, await link('undo', 't1', { prev: '진행중' })));
  check('이전 상태로 복원', first(docs).status === '진행중');
  check('완료 플래그 해제', first(docs).done === false);
  check('완료일 비움', first(docs).completedDate === '');
  check('되돌린 것도 로그로 남김', (first(docs).logs || []).some((l) => l.text === '메일에서 되돌림'));

  // 이전 상태를 모르면 대기로
  const d2 = { main: JSON.stringify({ todos: [T({ status: '완료', done: true, completedDate: TODAY })] }) };
  await onRequestPost(ctx(d2, await link('undo', 't1')));
  check('이전 상태가 없으면 대기', first(d2).status === '대기');
}

section('위조·만료 차단');
{
  const docs = { main: JSON.stringify({ todos: [T({})] }) };
  const good = await link('done', 't1');

  const tampered = good.replace('id=t1', 'id=t9');
  const r1 = await onRequestPost(ctx(docs, tampered));
  check('id 를 바꾸면 403', r1.status === 403);
  check('바꿔치기해도 데이터 무변경', first(docs).status === '대기');

  const badSig = good.replace(/s=[^&]+$/, 's=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  check('서명이 틀리면 403', (await onRequestPost(ctx(docs, badSig))).status === 403);

  const noSig = good.replace(/&s=[^&]+$/, '');
  check('서명이 없으면 403', (await onRequestPost(ctx(docs, noSig))).status === 403);

  // 만료: 어제까지였던 링크
  const expired = await link('done', 't1', { exp: day(-1) });
  const r2 = await onRequestPost(ctx(docs, expired));
  check('만료 링크는 통과하지만 처리 안 함', r2.status === 200);
  check('만료 안내를 보여 준다', (await body(r2)).includes('만료'));
  check('만료 링크로는 안 바뀜', first(docs).status === '대기');

  // 오늘이 만료일이면 아직 유효
  const lastDay = await link('done', 't1', { exp: TODAY });
  await onRequestPost(ctx(docs, lastDay));
  check('만료 당일까지는 유효', first(docs).status === '완료');

  // 알 수 없는 동작
  const weird = good.replace('a=done', 'a=delete');
  check('모르는 동작은 거부', (await onRequestPost(ctx(docs, weird))).status === 200);
}

section('없는 업무 · 이미 완료된 업무');
{
  const docs = { main: JSON.stringify({ todos: [T({})] }) };
  const gone = await link('done', 'nope');
  const r = await onRequestGet(ctx(docs, gone));
  check('지워진 업무는 안내만', (await body(r)).includes('찾지 못했어요'));

  const d2 = { main: JSON.stringify({ todos: [T({ status: '완료', done: true, completedDate: day(-2) })] }) };
  const r2 = await onRequestGet(ctx(d2, await link('done', 't1')));
  check('이미 완료면 확인 버튼을 안 띄운다', !(await body(r2)).includes('<form method="post"'));

  // 그래도 강제로 POST 하면 완료일은 덮어쓰지 않는다
  await onRequestPost(ctx(d2, await link('done', 't1')));
  check('기존 완료일 보존', first(d2).completedDate === day(-2));
}

section('다른 업무는 건드리지 않는다');
{
  const docs = { main: JSON.stringify({
    todos: [T({}), T({ id: 't2', text: '다른 업무', status: '진행중' })],
    events: [{ id: 'e1', title: '회의' }], projects: [{ id: 'p1' }],
  }) };
  await onRequestPost(ctx(docs, await link('done', 't1')));
  const s = JSON.parse(docs.main);
  check('대상만 완료', s.todos[0].status === '완료' && s.todos[1].status === '진행중');
  check('일정은 그대로', s.events.length === 1);
  check('다른 항목도 그대로', s.projects.length === 1);
}

section('HTML 이스케이프');
{
  const docs = { main: JSON.stringify({ todos: [T({ text: '<img src=x onerror=1> "따옴표"' })] }) };
  const html = await body(await onRequestGet(ctx(docs, await link('done', 't1'))));
  check('업무 내용의 태그는 이스케이프', !html.includes('<img src=x') && html.includes('&lt;img'));
  check('onerror 가 그대로 남지 않음', !/onerror=1>/.test(html));
}
