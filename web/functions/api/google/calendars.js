// GET  /api/google/calendars — 내 구글 캘린더 목록 + 현재 "읽기 전용 가져오기" 선택 상태
// POST /api/google/calendars — 가져올 캘린더 선택 저장 ({ ids: [calendarId...] })
//
// 여기서 고른 캘린더는 **읽기만** 한다. SCLM이 그 캘린더에 쓰거나 지우는 일은 없다.
// 양방향으로 쓰는 캘린더는 전용 "SCLM" 하나뿐이다(sync.js).
import { authed, unauthorized, readGoogleDoc, writeGoogleDoc, getAccessToken } from './_util.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const MAX_READ_CALENDARS = 8;   // 동기화 한 번에 도는 요청 수를 묶어 두기 위한 상한

export async function onRequestGet(context) {
  if (!authed(context)) return unauthorized();
  const tok = await getAccessToken(context.env);
  if (!tok) return Response.json({ error: 'not_connected' }, { status: 400 });

  const r = await fetch(`${CAL}/users/me/calendarList?maxResults=250`, {
    headers: { Authorization: 'Bearer ' + tok.access_token }
  });
  if (!r.ok) return Response.json({ error: 'calendar_list_failed', status: r.status }, { status: 502 });
  const list = await r.json();

  const gdoc = await readGoogleDoc(context.env);
  const selected = Array.isArray(gdoc.readCalendars) ? gdoc.readCalendars : [];
  const selectedIds = selected.map((c) => c.id);

  // 양방향으로 쓰는 SCLM 캘린더는 고를 대상이 아니다(이미 동기화 중)
  const items = (list.items || [])
    .filter((c) => c.summary !== 'SCLM' && c.id !== gdoc.calendarId)
    .map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      primary: !!c.primary,
      color: c.backgroundColor || '',
      selected: selectedIds.includes(c.id)
    }));

  return Response.json({ ok: true, items, max: MAX_READ_CALENDARS, sclmCalendarId: gdoc.calendarId || null });
}

export async function onRequestPost(context) {
  if (!authed(context)) return unauthorized();
  const tok = await getAccessToken(context.env);
  if (!tok) return Response.json({ error: 'not_connected' }, { status: 400 });

  let body = {};
  try { body = await context.request.json(); } catch (e) {}
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && x) : [];
  if (ids.length > MAX_READ_CALENDARS) {
    return Response.json({ error: 'too_many', max: MAX_READ_CALENDARS }, { status: 400 });
  }

  // 이름을 함께 저장해 둔다 — 동기화할 때마다 목록을 다시 부르지 않으려고(서브리퀘스트 절약)
  const r = await fetch(`${CAL}/users/me/calendarList?maxResults=250`, {
    headers: { Authorization: 'Bearer ' + tok.access_token }
  });
  const list = r.ok ? await r.json() : { items: [] };
  const byId = new Map((list.items || []).map((c) => [c.id, c.summaryOverride || c.summary || c.id]));

  const gdoc = await readGoogleDoc(context.env);
  gdoc.readCalendars = ids.map((id) => ({ id, name: byId.get(id) || id }));
  await writeGoogleDoc(context.env, gdoc);

  return Response.json({ ok: true, readCalendars: gdoc.readCalendars });
}
