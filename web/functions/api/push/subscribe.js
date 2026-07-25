// /api/push/subscribe — 푸시 구독 저장/삭제. 앱 비밀번호 보호.
import { authed, unauthorized } from '../_auth.js';

export async function onRequestPost(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();
  let body = {};
  try { body = await context.request.json(); } catch (e) {}
  const sub = body.subscription || body;
  const endpoint = sub && sub.endpoint;
  const keys = sub && sub.keys;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return Response.json({ error: 'bad_subscription' }, { status: 400 });
  }
  await env.DB.prepare(
    "INSERT INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?1,?2,?3,?4) " +
    "ON CONFLICT(endpoint) DO UPDATE SET p256dh=?2, auth=?3"
  ).bind(endpoint, keys.p256dh, keys.auth, Date.now()).run();
  return Response.json({ ok: true });
}

export async function onRequestDelete(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();
  let body = {};
  try { body = await context.request.json(); } catch (e) {}
  const endpoint = (body.subscription && body.subscription.endpoint) || body.endpoint;
  if (endpoint) {
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(endpoint).run();
  }
  return Response.json({ ok: true });
}
