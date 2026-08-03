// /api/mail-action — 아침 브리핑 메일에서 앱을 열지 않고 바로 완료 처리하는 링크.
//
// 왜 만들었나 — 아침에 메일을 보면서 "이건 이미 끝냈지"를 체크하는 게 실제 동선인데,
// 지금까지는 딥링크로 앱을 열고 → 편집창을 띄우고 → 상태를 바꾸고 → 저장해야 했다.
//
// ⚠️ **GET 은 절대 상태를 바꾸지 않는다.** 회사 메일 보안 장치(아웃룩 Safe Links 등)가
//    메일 속 링크를 사람 대신 미리 열어 보기 때문이다. GET 이 완료 처리를 하면 메일이
//    도착하자마자 전 항목이 완료로 바뀐다. 그래서 GET 은 확인 화면만 그리고,
//    실제 변경은 사람이 버튼을 눌렀을 때의 POST 에서만 한다. 이 구조를 바꾸지 말 것.
//
// 인증은 로그인이 아니라 **서명**이다(메일 앱은 앱 토큰을 모른다). `_sign.js` 참고.
import { signParts, verifyParts } from './_sign.js';

const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const APP_URL = 'https://sclm.pages.dev';

/* 만료일(포함)까지 유효. 메일은 몇 년씩 남으므로 만료 없는 링크를 만들지 말 것. */
export const LINK_DAYS = 7;
export function expiryIso(days) {
  const d = new Date(Date.now() + 9 * 3600e3);
  d.setUTCDate(d.getUTCDate() + (days == null ? LINK_DAYS : days));
  return d.toISOString().slice(0, 10);
}

/* 서명 링크 만들기. p 는 되돌리기용 이전 상태(없으면 빈 값). */
export async function actionUrl(env, action, id, opts) {
  const o = opts || {};
  const exp = o.exp || expiryIso();
  const prev = o.prev || '';
  const sig = await signParts(env.APP_PASSWORD, [action, id, exp, prev]);
  const q = new URLSearchParams({ a: action, id: id, exp: exp, s: sig });
  if (prev) q.set('p', prev);
  return APP_URL + '/api/mail-action?' + q.toString();
}

function page(title, bodyHtml, status) {
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · SCLM</title>
<style>
  body{font-family:-apple-system,'Malgun Gothic','Segoe UI',sans-serif;background:#f7f7f5;color:#37352f;
       margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}
  .card{background:#fff;border:1px solid #e6e6e4;border-radius:12px;max-width:460px;width:100%;padding:26px 24px}
  h1{font-size:17px;margin:0 0 14px}
  .txt{font-size:14px;line-height:1.6;margin:0 0 6px}
  .tag{font-size:12px;color:#9b9a97;margin:0 0 18px}
  button{font:inherit;font-size:15px;font-weight:600;color:#fff;background:#1a73e8;border:0;
         border-radius:8px;padding:12px 18px;width:100%;cursor:pointer}
  .links{margin:18px 0 0;font-size:13px}
  a{color:#1a73e8;text-decoration:none}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
  return new Response(html, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const notice = (title, msg) => page(title,
  `<h1>${esc(title)}</h1><p class="txt">${esc(msg)}</p>
   <p class="links"><a href="${APP_URL}">SCLM 열기 →</a></p>`);

async function loadTodos(env) {
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let s = {}; try { s = JSON.parse(row.data); } catch (e) {}
  if (!Array.isArray(s.todos)) s.todos = [];
  return s;
}

/* 서명·만료 확인. 통과하면 { a, id, exp, prev } 를 돌려준다. */
async function check(context) {
  const url = new URL(context.request.url);
  const a = url.searchParams.get('a') || '';
  const id = url.searchParams.get('id') || '';
  const exp = url.searchParams.get('exp') || '';
  const prev = url.searchParams.get('p') || '';
  const sig = url.searchParams.get('s') || '';
  if (a !== 'done' && a !== 'undo') return { bad: notice('처리할 수 없어요', '알 수 없는 요청입니다.') };
  if (!(await verifyParts(context.env.APP_PASSWORD, [a, id, exp, prev], sig))) {
    return { bad: page('링크가 올바르지 않아요',
      `<h1>링크가 올바르지 않아요</h1>
       <p class="txt">주소가 잘리거나 바뀐 것 같습니다. 메일의 링크를 다시 눌러 주세요.</p>
       <p class="links"><a href="${APP_URL}">SCLM 열기 →</a></p>`, 403) };
  }
  if (exp && exp < todayKST()) {
    return { bad: notice('링크가 만료됐어요',
      `이 링크는 ${exp}까지 쓸 수 있었어요. 앱에서 직접 처리해 주세요.`) };
  }
  return { a, id, exp, prev };
}

/* GET — 확인 화면만. 상태는 절대 바꾸지 않는다(파일 첫머리 주의사항 참고). */
export async function onRequestGet(context) {
  const c = await check(context);
  if (c.bad) return c.bad;

  const s = await loadTodos(context.env);
  const t = s.todos.find((x) => x && x.id === c.id);
  if (!t) return notice('그 업무를 찾지 못했어요', '이미 지워졌거나 정리된 것 같습니다.');

  const cur = t.status || (t.done ? '완료' : '대기');
  const name = String(t.text || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
  const tag = [t.channel, t.subChannel].filter(Boolean).join(' · ');

  if (c.a === 'done' && (cur === '완료' || cur === '지연완료')) {
    return notice('이미 완료된 업무예요', name);
  }

  const q = new URL(context.request.url).search;
  const verb = c.a === 'done' ? '완료 처리' : '되돌리기';
  return page(verb, `
    <h1>${esc(name)}</h1>
    <p class="tag">${esc(tag || '분류 없음')}${t.dueDate ? ' · 마감 ' + esc(t.dueDate) : ''} · 현재 ${esc(cur)}</p>
    <form method="post" action="/api/mail-action${esc(q)}">
      <button type="submit">${c.a === 'done' ? '완료로 표시' : '되돌리기'}</button>
    </form>
    <p class="links"><a href="${APP_URL}/?todo=${encodeURIComponent(c.id)}">앱에서 열어 수정하기 →</a></p>`);
}

/* POST — 여기서만 실제로 바꾼다. */
export async function onRequestPost(context) {
  const { env } = context;
  const c = await check(context);
  if (c.bad) return c.bad;

  const s = await loadTodos(env);
  const t = s.todos.find((x) => x && x.id === c.id);
  if (!t) return notice('그 업무를 찾지 못했어요', '이미 지워졌거나 정리된 것 같습니다.');

  const before = t.status || (t.done ? '완료' : '대기');
  const name = String(t.text || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
  const today = todayKST();

  if (c.a === 'done') {
    // 마감이 지난 뒤 끝낸 건은 '지연완료' — 앱에서 손으로 완료할 때와 같은 규칙이라야
    // 기한 준수율 집계가 메일 경유인지 아닌지에 따라 달라지지 않는다.
    t.status = (t.dueDate && t.dueDate < today) ? '지연완료' : '완료';
    t.done = true;
    if (!t.completedDate) t.completedDate = today;
  } else {
    t.status = c.prev && c.prev !== '완료' && c.prev !== '지연완료' ? c.prev : '대기';
    t.done = false;
    t.completedDate = '';
  }

  // 어디서 바뀐 건지 남긴다 — 앱에서 보면 본인이 언제 뭘 했는지 추적이 된다
  if (!Array.isArray(t.logs)) t.logs = [];
  t.logs.push({ at: today, text: c.a === 'done' ? '메일에서 완료 처리' : '메일에서 되돌림' });

  await env.DB.prepare("INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
    .bind(JSON.stringify(s), Date.now()).run();

  if (c.a === 'undo') {
    return page('되돌렸어요', `
      <h1>되돌렸어요</h1>
      <p class="txt">${esc(name)}</p>
      <p class="tag">상태: ${esc(t.status)}</p>
      <p class="links"><a href="${APP_URL}/?todo=${encodeURIComponent(c.id)}">앱에서 열기 →</a></p>`);
  }

  const undo = await actionUrl(env, 'undo', c.id, { prev: before });
  return page('완료로 표시했어요', `
    <h1>✅ 완료로 표시했어요</h1>
    <p class="txt">${esc(name)}</p>
    <p class="tag">${esc(t.status)} · 완료일 ${esc(t.completedDate)}</p>
    <p class="links"><a href="${esc(undo)}">되돌리기</a> · <a href="${APP_URL}">SCLM 열기 →</a></p>`);
}
