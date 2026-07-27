// POST /api/google/sheet-sync — 구글 시트(업무 트래커) → SCLM 읽기 전용 가져오기.
// ⚠️ 시트에는 절대 쓰지 않는다(수식·구조 보존). 시트가 '진실의 원천'이라 todos를 시트 기준으로 갱신.
// 열은 고정 위치(아래 COL)로 매핑하고, 헤더 구조 가드로 확인 후에만 반영한다(구조가 다르면 중단).
import { authed, unauthorized, readGoogleDoc, writeGoogleDoc, getAccessToken } from './_util.js';
import { getSheetTitle, readGrid } from './_sheets.js';

// 업무리스트 탭 고정 열 위치(0-index). 14=D-Day, 15=소요일수는 수식이라 읽지 않음.
const COL = {
  no: 0, registeredDate: 1, dueDate: 2, completedDate: 3, assignee: 4,
  project: 5, channel: 6, priority: 7, status: 8, needsCheck: 9,
  text: 10, progress: 11, link: 12, remarks: 13,
};

const norm = (v) => (v == null ? '' : String(v)).trim();
const isDoneStatus = (s) => s === '완료' || s === '지연완료';

// 안정적 id: 등록일+업무내용 해시(시트 No가 재정렬돼도 유지 → 캘린더 연동 churn 최소화)
function hashId(reg, text) {
  const s = reg + '|' + text;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'sh_' + h.toString(36);
}

// HTTP 엔드포인트: 앱 비밀번호 보호.
export async function onRequestPost(context) {
  if (!authed(context)) return unauthorized();
  const out = await runSheetSync(context.env);
  if (out.error) {
    const status = out.error === 'no_sheet_configured' || out.error === 'not_connected' ? 400 : (out.status || 500);
    return Response.json({ error: out.error }, { status });
  }
  return Response.json(out);
}

// 공용 읽기 전용 동기화(크론/데일리에서도 재사용). 설정 없으면/실패 시 {error}.
export async function runSheetSync(env) {
  const tok = await getAccessToken(env);
  if (!tok) return { error: 'not_connected' };
  const token = tok.access_token;

  const gdoc = await readGoogleDoc(env);
  const cfg = gdoc.sheet || {};
  if (!cfg.spreadsheetId) return { error: 'no_sheet_configured' };

  try {
    let title = cfg.title;
    if (!title) { title = await getSheetTitle(token, cfg.spreadsheetId, cfg.gid); cfg.title = title; }
    const grid = await readGrid(token, cfg.spreadsheetId, title);

    // ---- 구조 가드: '대분류'(5열)+'업무내용'(10열) 헤더가 있는 행 탐지 ----
    let hIdx = -1;
    for (let i = 0; i < Math.min(grid.length, 6); i++) {
      const r = grid[i] || [];
      if (norm(r[COL.project]) === '대분류' && norm(r[COL.text]) === '업무내용') { hIdx = i; break; }
    }
    if (hIdx < 0) return { error: 'sheet_structure_unrecognized', status: 422 };

    // ---- 앱 상태 로드 ----
    const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
    let state = {};
    try { state = JSON.parse(row.data); } catch (e) {}
    state.todos = Array.isArray(state.todos) ? state.todos : [];
    state.projects = Array.isArray(state.projects) ? state.projects : [];
    const defProj = state.projects[0] ? state.projects[0].id : 'default';
    const projId = (name) => {
      const nm = norm(name);
      if (!nm) return defProj;
      const p = state.projects.find((x) => x.name === nm);
      if (p) return p.id;
      const np = { id: 'cat-' + Math.random().toString(36).slice(2, 8), name: nm, color: '#9e9e9e' };
      state.projects.push(np);
      return np.id;
    };

    // 기존 todo의 캘린더 연동 정보(googleId/gSig)를 id로 보존
    const prevById = new Map(state.todos.map((t) => [t.id, t]));

    // ---- 시트 행 파싱(위치 기반) ----
    const parsed = [];
    const seen = new Set();
    for (let i = hIdx + 1; i < grid.length; i++) {
      const r = grid[i] || [];
      const text = norm(r[COL.text]);
      if (!text) continue; // 업무내용 없는 행(빈 행/구분선) 스킵
      const reg = norm(r[COL.registeredDate]);
      let id = hashId(reg, text);
      while (seen.has(id)) id += 'x'; // 동일 등록일+내용 충돌 방지
      seen.add(id);
      const prev = prevById.get(id);
      const status = norm(r[COL.status]);
      const noRaw = norm(r[COL.no]);
      parsed.push({
        id,
        googleId: prev ? prev.googleId : undefined,
        gSig: prev ? prev.gSig : undefined,
        no: Number(noRaw) || noRaw || '',
        registeredDate: reg,
        dueDate: norm(r[COL.dueDate]),
        completedDate: norm(r[COL.completedDate]),
        assignee: norm(r[COL.assignee]),
        projectId: projId(r[COL.project]),
        channel: norm(r[COL.channel]),
        priority: norm(r[COL.priority]),
        status,
        needsCheck: norm(r[COL.needsCheck]),
        text,
        progress: norm(r[COL.progress]),
        link: norm(r[COL.link]),
        remarks: norm(r[COL.remarks]),
        done: isDoneStatus(status),
      });
    }
    if (parsed.length === 0) return { error: 'no_rows_parsed', status: 422 };

    // ---- 시트를 원천으로 todos 교체(googleId는 위에서 보존) ----
    const before = state.todos.length;
    state.todos = parsed;
    await env.DB
      .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
      .bind(JSON.stringify(state), Date.now())
      .run();

    cfg.lastSync = Date.now();
    gdoc.sheet = cfg;
    await writeGoogleDoc(env, gdoc);

    return { ok: true, mode: 'readonly', imported: parsed.length, before, title };
  } catch (err) {
    return { error: String((err && err.message) || err), status: (err && err.status) || 500 };
  }
}
