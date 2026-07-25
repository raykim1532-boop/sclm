// GET /api/google/callback — 구글이 브라우저를 이 주소로 리다이렉트. state로 위조 방지 후 토큰 교환.
import { readGoogleDoc, writeGoogleDoc, redirectUri } from './_util.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const back = (s) => Response.redirect(`${url.origin}/?google=${s}`, 302);

  if (url.searchParams.get('error')) return back('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  const doc = await readGoogleDoc(env);
  if (!code || !state || !doc.state || state !== doc.state) return back('state_error');

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(request)
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!r.ok) return back('token_error');
  const j = await r.json();

  if (j.refresh_token) doc.refresh_token = j.refresh_token;
  doc.connected_at = Date.now();
  delete doc.state;
  await writeGoogleDoc(env, doc);

  if (!doc.refresh_token) return back('no_refresh');
  return back('connected');
}
