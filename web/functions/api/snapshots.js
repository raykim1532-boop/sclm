// /api/snapshots — 상태 스냅샷(백업) 목록/생성/복원. 앱 비밀번호 보호.
// GET   : 목록(데이터 제외)
// POST  : { action:'restore', id } → 복원 / 그 외 → 생성({reason, force})
import { authed, unauthorized } from './_auth.js';

const KEEP = 20;

function summarize(dataStr) {
  try {
    const d = JSON.parse(dataStr);
    return `할일 ${(d.todos || []).length} · 일정 ${(d.events || []).length} · 프로젝트 ${(d.projects || []).length} · 채널 ${(d.channels || []).length}`;
  } catch (e) { return ''; }
}
// KST 기준 날짜 키(하루 1회 자동백업 판정용)
function dayKey(ts) { return new Date(ts + 9 * 3600e3).toISOString().slice(0, 10); }

async function prune(env) {
  await env.DB.prepare(
    `DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY created_at DESC LIMIT ${KEEP})`
  ).run();
}

async function snapshotCurrent(env, reason) {
  const cur = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  if (!cur || !cur.data) return null;
  const now = Date.now();
  const id = 'snap_' + now + '_' + Math.random().toString(36).slice(2, 6);
  await env.DB.prepare("INSERT INTO snapshots (id, created_at, reason, summary, data) VALUES (?1,?2,?3,?4,?5)")
    .bind(id, now, String(reason || 'auto').slice(0, 40), summarize(cur.data), cur.data).run();
  await prune(env);
  return { id, created_at: now };
}

export async function onRequestGet(context) {
  if (!authed(context)) return unauthorized();
  const rows = await context.env.DB
    .prepare("SELECT id, created_at, reason, summary FROM snapshots ORDER BY created_at DESC LIMIT 50")
    .all();
  return Response.json({ snapshots: rows.results || [] });
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();
  let body = {};
  try { body = await context.request.json(); } catch (e) {}

  // 복원
  if (body.action === 'restore') {
    if (!body.id) return Response.json({ error: 'no_id' }, { status: 400 });
    const snap = await env.DB.prepare("SELECT data FROM snapshots WHERE id = ?1").bind(body.id).first();
    if (!snap) return Response.json({ error: 'not_found' }, { status: 404 });

    // 금고(vault) 보호: 복원해도 현재 금고 암호문은 그대로 둔다.
    // 금고 생성 이전 스냅샷으로 되돌리면 암호문이 통째로 사라지는데,
    // 금고는 마스터 비밀번호가 있어도 암호문이 없으면 복구할 방법이 없다.
    // (할 일/일정을 되돌리려다 저장해둔 계정을 잃는 사고를 막는다)
    let restoreData = snap.data;
    let vaultKept = false;
    const cur = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
    let curVault;
    if (cur && cur.data) { try { curVault = JSON.parse(cur.data).vault; } catch (e) {} }
    if (curVault) {
      try {
        const d = JSON.parse(snap.data);
        if (JSON.stringify(d.vault) !== JSON.stringify(curVault)) {
          d.vault = curVault;
          restoreData = JSON.stringify(d);
          vaultKept = true;
        }
      } catch (e) {} // 스냅샷이 깨져 있으면 원본 그대로 복원(기존 동작 유지)
    }

    // 복원 전 현재 상태 자동 백업(복원도 되돌릴 수 있게)
    await snapshotCurrent(env, 'pre-restore');
    await env.DB
      .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
      .bind(restoreData, Date.now()).run();
    return Response.json({ ok: true, restored: true, vaultKept });
  }

  // 생성 (force 아니면 하루 1회로 제한)
  const force = !!body.force;
  if (!force) {
    const last = await env.DB.prepare("SELECT created_at FROM snapshots ORDER BY created_at DESC LIMIT 1").first();
    if (last && dayKey(last.created_at) === dayKey(Date.now())) {
      return Response.json({ ok: true, skipped: true });
    }
  }
  const res = await snapshotCurrent(env, body.reason || 'auto');
  if (!res) return Response.json({ error: 'no_data' }, { status: 400 });
  return Response.json({ ok: true, id: res.id, created_at: res.created_at });
}
