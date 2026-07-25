// 구글 캘린더 연동 공용 유틸. 파일명이 _로 시작하면 라우팅되지 않는다(Pages Functions 규칙).
// 토큰/연결정보는 D1 documents 테이블의 id='google' 단일 행(JSON)에 보관한다(단일 사용자).

export function getToken(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function authed(context) {
  const expected = context.env.APP_PASSWORD;
  const got = getToken(context.request);
  return !!expected && !!got && safeEqual(got, expected);
}

export const unauthorized = () =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json' }
  });

export async function readGoogleDoc(env) {
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'google'").first();
  if (row && row.data) { try { return JSON.parse(row.data); } catch (e) {} }
  return {};
}

export async function writeGoogleDoc(env, obj) {
  await env.DB
    .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('google', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
    .bind(JSON.stringify(obj), Date.now())
    .run();
}

export function redirectUri(request) {
  return `${new URL(request.url).origin}/api/google/callback`;
}

// 저장된 refresh_token으로 새 access_token 발급
export async function getAccessToken(env) {
  const doc = await readGoogleDoc(env);
  if (!doc.refresh_token) return null;
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: doc.refresh_token,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.access_token ? { access_token: j.access_token, expires_in: j.expires_in } : null;
}

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar';
