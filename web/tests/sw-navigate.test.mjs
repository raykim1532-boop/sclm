// 서비스 워커의 문서(내비게이션) 처리.
//
// ⚠️ 2026-08-03 발견한 버그: /api/mail-action 처럼 **HTML 을 돌려주는 엔드포인트**도
//    링크로 열면 내비게이션이라, 그 확인 화면이 앱 셸('/') 캐시를 덮어썼다.
//    그 상태로 오프라인에서 앱을 열면 앱 대신 "완료로 표시" 화면이 뜬다.
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const src = readFileSync(new URL('../static/sw.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('추출 실패: ' + name); return m[0]; };

/* 캐시 모의 — put/match 만 있으면 된다 */
function makeCaches() {
  const store = new Map();
  return {
    store,
    open: async () => ({
      put: async (k, v) => { store.set(typeof k === 'string' ? k : k.url, v); },
      match: async (k) => store.get(typeof k === 'string' ? k : k.url) || undefined,
    }),
  };
}
const res = (body, ok) => ({ ok: ok !== false, status: ok === false ? 500 : 200, body, clone() { return this; } });

function load(fetchImpl, cachesImpl) {
  return new Function('caches', 'fetch', 'SHELL_CACHE',
    grab(/async function handleNavigate\([\s\S]*?\r?\n}/, 'handleNavigate') + '; return handleNavigate;'
  )(cachesImpl, fetchImpl, 'sclm-shell-test');
}

section('앱 셸은 캐시한다');
{
  const c = makeCaches();
  const handleNavigate = load(async () => res('<html>앱</html>'), c);
  const out = await handleNavigate({ url: 'https://sclm.pages.dev/' });
  check('응답은 그대로 돌려준다', out.body === '<html>앱</html>');
  check("'/' 로 캐시됨", (c.store.get('/') || {}).body === '<html>앱</html>');

  // 딥링크(?todo=…)도 앱 셸이다
  const c2 = makeCaches();
  await load(async () => res('<html>앱</html>'), c2)({ url: 'https://sclm.pages.dev/?todo=abc' });
  check('딥링크도 앱 셸로 캐시', !!c2.store.get('/'));
}

section('/api/ 문서는 앱 셸을 덮어쓰지 않는다');
{
  const c = makeCaches();
  const handleNavigate = load(async () => res('<html>완료로 표시</html>'), c);
  const out = await handleNavigate({ url: 'https://sclm.pages.dev/api/mail-action?a=done&id=x&s=Y' });

  check('확인 화면은 정상적으로 보여 준다', out.body === '<html>완료로 표시</html>');
  check("앱 셸('/') 을 건드리지 않는다", c.store.get('/') === undefined);

  // 이미 캐시된 앱 셸이 있어도 덮어쓰면 안 된다
  const c2 = makeCaches();
  c2.store.set('/', res('<html>진짜 앱</html>'));
  await load(async () => res('<html>완료로 표시</html>'), c2)({ url: 'https://sclm.pages.dev/api/mail-action?a=done' });
  check('기존 앱 셸이 살아남는다', c2.store.get('/').body === '<html>진짜 앱</html>');
}

section('오프라인');
{
  // 앱 셸은 캐시된 앱을 준다
  const c = makeCaches();
  c.store.set('/', res('<html>진짜 앱</html>'));
  const off = await load(async () => { throw new Error('offline'); }, c)({ url: 'https://sclm.pages.dev/' });
  check('앱 셸은 캐시로 폴백', off.body === '<html>진짜 앱</html>');

  // /api/ 문서에 앱 셸을 주면 엉뚱한 화면이 뜬다 — 안내만 한다
  const c2 = makeCaches();
  c2.store.set('/', res('<html>진짜 앱</html>'));
  const apiOff = await load(async () => { throw new Error('offline'); }, c2)({ url: 'https://sclm.pages.dev/api/mail-action?a=done' });
  check('/api/ 는 앱 셸로 폴백하지 않는다', apiOff.status === 503);
  const msg = await apiOff.text();
  check('앱 화면이 아니라 안내 문구를 준다', msg.includes('오프라인') && !msg.includes('진짜 앱'));
  check('무엇을 하면 되는지 알려 준다', msg.includes('다시 눌러'));

  // 캐시가 아예 없으면
  const c3 = makeCaches();
  const none = await load(async () => { throw new Error('offline'); }, c3)({ url: 'https://sclm.pages.dev/' });
  check('캐시가 없으면 503', none.status === 503);
}

section('실패 응답은 캐시하지 않는다');
{
  const c = makeCaches();
  await load(async () => res('<html>500</html>', false), c)({ url: 'https://sclm.pages.dev/' });
  check('ok 가 아니면 캐시 안 함', c.store.get('/') === undefined);
}

section('주소를 못 읽어도 죽지 않는다');
{
  const c = makeCaches();
  let ok = true;
  try { await load(async () => res('<html>앱</html>'), c)({ url: 'not-a-url' }); } catch (e) { ok = false; }
  check('예외 없음', ok);
}
