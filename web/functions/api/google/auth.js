// GET /api/google/auth — 구글 동의 화면 URL 생성(앱 비밀번호로 보호). 프론트가 받아서 이동한다.
import { authed, unauthorized, readGoogleDoc, writeGoogleDoc, redirectUri, GOOGLE_SCOPE } from './_util.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!authed(context)) return unauthorized();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return Response.json({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 시크릿이 설정되지 않았어요.' }, { status: 400 });
  }
  const state = crypto.randomUUID();
  const doc = await readGoogleDoc(env);
  doc.state = state;
  await writeGoogleDoc(env, doc);

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state
  });
  return Response.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
}
