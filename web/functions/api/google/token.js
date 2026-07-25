// GET /api/google/token — 프론트가 구글 캘린더 API를 직접 호출할 때 쓸 단기 access_token 발급(앱 비밀번호 보호).
import { authed, unauthorized, getAccessToken } from './_util.js';

export async function onRequestGet(context) {
  if (!authed(context)) return unauthorized();
  const tok = await getAccessToken(context.env);
  if (!tok) return Response.json({ error: 'not_connected' }, { status: 400 });
  return Response.json(tok);
}
