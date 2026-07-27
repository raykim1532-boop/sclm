// GET  /api/google/sheet-config — 동기화 대상 시트 설정 조회
// POST /api/google/sheet-config — 대상 시트 저장({url} 또는 {spreadsheetId,gid}). 앱 비밀번호 보호.
import { authed, unauthorized, readGoogleDoc, writeGoogleDoc } from './_util.js';
import { parseSheetUrl } from './_sheets.js';

export async function onRequestGet(context) {
  if (!authed(context)) return unauthorized();
  const d = await readGoogleDoc(context.env);
  const s = d.sheet || {};
  return Response.json({
    configured: !!s.spreadsheetId,
    spreadsheetId: s.spreadsheetId || '',
    gid: s.gid || 0,
    title: s.title || '',
    lastSync: s.lastSync || null,
  });
}

export async function onRequestPost(context) {
  if (!authed(context)) return unauthorized();
  const body = await context.request.json().catch(() => ({}));
  let { spreadsheetId, gid, url } = body;
  if (url) { const p = parseSheetUrl(url); spreadsheetId = p.spreadsheetId; gid = p.gid; }
  if (!spreadsheetId) return Response.json({ error: 'sheet_url_invalid' }, { status: 400 });

  const d = await readGoogleDoc(context.env);
  const prev = d.sheet || {};
  // 대상 시트가 바뀌면 이전 스냅샷/제목은 무효 → 초기화
  const changed = prev.spreadsheetId !== spreadsheetId || Number(prev.gid || 0) !== Number(gid || 0);
  d.sheet = {
    spreadsheetId,
    gid: Number(gid || 0),
    title: changed ? '' : (prev.title || ''),
    snap: changed ? {} : (prev.snap || {}),
    lastSync: changed ? null : (prev.lastSync || null),
  };
  await writeGoogleDoc(context.env, d);
  return Response.json({ ok: true, spreadsheetId, gid: Number(gid || 0) });
}
