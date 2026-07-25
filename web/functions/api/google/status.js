// GET /api/google/status — 연결 여부 조회 / DELETE — 연결 해제 (앱 비밀번호 보호).
import { authed, unauthorized, readGoogleDoc, writeGoogleDoc } from './_util.js';

export async function onRequestGet(context) {
  if (!authed(context)) return unauthorized();
  const doc = await readGoogleDoc(context.env);
  return Response.json({
    connected: !!doc.refresh_token,
    calendarId: doc.calendarId || 'primary',
    connected_at: doc.connected_at || null,
    hasClient: !!(context.env.GOOGLE_CLIENT_ID && context.env.GOOGLE_CLIENT_SECRET)
  });
}

export async function onRequestDelete(context) {
  if (!authed(context)) return unauthorized();
  await writeGoogleDoc(context.env, {});
  return Response.json({ ok: true });
}
