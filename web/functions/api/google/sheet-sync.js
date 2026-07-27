// POST /api/google/sheet-sync — 구글 시트(업무 트래커) ↔ SCLM todos 양방향 동기화.
// 스냅샷(직전 동기화 상태) 기준 3-way 병합: 한쪽만 바뀌면 그 값으로, 양쪽 다 바뀌면 시트 우선.
// 각 행 우측 SCLM_ID 열로 행↔todo를 안정적으로 매칭한다. 호출은 읽기1+쓰기1로 subrequest 여유.
import { authed, unauthorized, readGoogleDoc, writeGoogleDoc, getAccessToken } from './_util.js';
import { COLUMNS, ID_HEADER, getSheetTitle, readGrid, writeGrid, clearRange } from './_sheets.js';

const rid = (p) => p + Math.random().toString(36).slice(2, 9);
const norm = (v) => (v == null ? '' : String(v)).trim();
const isDoneStatus = (s) => s === '완료' || s === '지연완료';
const colLetter = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// HTTP 엔드포인트: 앱 비밀번호 보호 → 공용 runSheetSync 호출.
export async function onRequestPost(context) {
  if (!authed(context)) return unauthorized();
  const out = await runSheetSync(context.env);
  if (out.error) {
    const status = out.error === 'no_sheet_configured' || out.error === 'not_connected' ? 400 : (out.status || 500);
    return Response.json({ error: out.error }, { status });
  }
  return Response.json(out);
}

// 공용 동기화 로직(크론/데일리에서도 재사용). 설정 없으면 {skipped} 반환, 실패 시 {error}.
export async function runSheetSync(env) {
  const tok = await getAccessToken(env);
  if (!tok) return { error: 'not_connected' };
  const token = tok.access_token;

  const gdoc = await readGoogleDoc(env);
  const cfg = gdoc.sheet || {};
  if (!cfg.spreadsheetId) return { error: 'no_sheet_configured' };

  // 앱 상태 로드
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let state = {};
  try { state = JSON.parse(row.data); } catch (e) {}
  state.todos = Array.isArray(state.todos) ? state.todos : [];
  state.projects = Array.isArray(state.projects) ? state.projects : [];
  const defProj = state.projects[0] ? state.projects[0].id : 'default';

  // 프로젝트 이름 <-> id (없는 이름은 새 프로젝트로 생성)
  const projName = (id) => { const p = state.projects.find((x) => x.id === id); return p ? p.name : ''; };
  const projId = (name) => {
    const nm = norm(name);
    if (!nm) return defProj;
    const p = state.projects.find((x) => x.name === nm);
    if (p) return p.id;
    const np = { id: rid('cat-'), name: nm, color: '#9e9e9e' };
    state.projects.push(np);
    return np.id;
  };

  // todo → 시트 필드 오브젝트(대분류는 이름)
  const appFields = (t) => ({
    no: t.no == null ? '' : t.no,
    registeredDate: t.registeredDate || '',
    project: projName(t.projectId),
    channel: t.channel || '',
    priority: t.priority || '',
    text: t.text || '',
    assignee: t.assignee || '',
    dueDate: t.dueDate || '',
    status: t.status || '',
    needsCheck: t.needsCheck || '',
    completedDate: t.completedDate || '',
    progress: t.progress || '',
    remarks: t.remarks || '',
  });
  const sig = (f) => JSON.stringify(COLUMNS.map((c) => norm(f[c.key])));
  // 시트 필드 → 기존 todo에 적용(또는 신규 todo 생성)
  const applyFields = (base, f) => ({
    ...base,
    no: norm(f.no) === '' ? base.no : Number(f.no) || base.no,
    registeredDate: f.registeredDate || '',
    projectId: projId(f.project),
    channel: f.channel || '',
    priority: f.priority || '',
    text: f.text || '',
    assignee: f.assignee || '',
    dueDate: f.dueDate || '',
    status: f.status || '',
    needsCheck: f.needsCheck || '',
    completedDate: f.completedDate || '',
    progress: f.progress || '',
    remarks: f.remarks || '',
    done: isDoneStatus(f.status),
  });

  try {
    // 탭 제목 확보(최초 1회 조회 후 저장)
    let title = cfg.title;
    if (!title) { title = await getSheetTitle(token, cfg.spreadsheetId, cfg.gid); cfg.title = title; }

    // ---- 시트 읽기 ----
    const grid = await readGrid(token, cfg.spreadsheetId, title);
    const header = (grid[0] ? grid[0].slice() : []).map((h) => norm(h));
    const idxOf = {};
    header.forEach((h, i) => { if (idxOf[h] == null) idxOf[h] = i; });
    // 누락 헤더 보강
    for (const c of COLUMNS) if (idxOf[c.header] == null) { idxOf[c.header] = header.length; header.push(c.header); }
    let idCol = idxOf[ID_HEADER];
    if (idCol == null) { idCol = header.length; idxOf[ID_HEADER] = idCol; header.push(ID_HEADER); }
    const width = header.length;
    const pad = (r) => { const a = (r || []).slice(); while (a.length < width) a.push(''); return a; };
    const readFields = (r) => { const f = {}; for (const c of COLUMNS) f[c.key] = r[idxOf[c.header]] != null ? r[idxOf[c.header]] : ''; return f; };
    const hasContent = (f) => norm(f.text) !== '' || norm(f.dueDate) !== '';

    const dataRows = grid.slice(1);
    const sheetById = new Map();   // id -> { row, fields }
    const sheetNewRows = [];       // SCLM_ID 없는 신규 행
    for (const raw of dataRows) {
      const r = pad(raw);
      const id = norm(r[idCol]);
      const fields = readFields(r);
      if (id) sheetById.set(id, { row: r, fields });
      else if (hasContent(fields)) sheetNewRows.push({ row: r, fields });
    }

    const todoById = new Map(state.todos.map((t) => [t.id, t]));
    const snap = (cfg.snap && typeof cfg.snap === 'object') ? cfg.snap : {};

    const finalTodos = [];
    const rowBaseById = new Map(); // 시트 재작성 시 미지의 컬럼 보존용(기존 행 배열)
    let pushed = 0, pulled = 0, deletedLocal = 0, deletedRemote = 0;
    const conflicts = [];

    const allIds = new Set([...todoById.keys(), ...sheetById.keys(), ...Object.keys(snap)]);
    for (const id of allIds) {
      const t = todoById.get(id);
      const sh = sheetById.get(id);
      const snapSig = snap[id];
      if (sh) rowBaseById.set(id, sh.row);

      if (t && sh) {
        const aSig = sig(appFields(t));
        const sSig = sig(sh.fields);
        if (aSig === sSig) { finalTodos.push(t); continue; }
        const appChanged = aSig !== snapSig;
        const shChanged = sSig !== snapSig;
        if (appChanged && !shChanged) { finalTodos.push(t); pushed++; }        // 앱 변경 → 시트로
        else if (shChanged && !appChanged) { finalTodos.push(applyFields(t, sh.fields)); pulled++; } // 시트 변경 → 앱으로
        else { finalTodos.push(applyFields(t, sh.fields)); pulled++; conflicts.push(t.text || id); } // 충돌 → 시트 우선
      } else if (t && !sh) {
        if (snapSig != null) { deletedLocal++; }               // 시트에서 삭제됨 → 앱에서도 제거
        else { finalTodos.push(t); pushed++; }                  // 앱 신규 → 시트로
      } else if (!t && sh) {
        if (snapSig != null) { deletedRemote++; }              // 앱에서 삭제됨 → 시트 행 제거
        else { finalTodos.push(applyFields({ id }, sh.fields)); pulled++; } // 알 수 없는 id지만 내용 있음 → 가져오기
      }
      // !t && !sh (스냅샷에만 존재) → 양쪽 삭제, 무시
    }

    // SCLM_ID 없는 신규 시트 행 → 앱으로 가져오고 새 id 부여(재작성 시 기록)
    for (const nr of sheetNewRows) {
      const id = rid('sh');
      const t = applyFields({ id }, nr.fields);
      finalTodos.push(t);
      rowBaseById.set(id, nr.row);
      pulled++;
    }

    // no 비어있는 항목에 다음 번호 부여
    let maxNo = 0;
    for (const t of finalTodos) { const n = Number(t.no); if (Number.isFinite(n)) maxNo = Math.max(maxNo, n); }
    for (const t of finalTodos) { if (t.no == null || norm(t.no) === '') t.no = ++maxNo; }

    // 시트 정렬(No 오름차순, 없으면 뒤로)
    const forSheet = finalTodos.slice().sort((a, b) => {
      const na = Number(a.no), nb = Number(b.no);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      if (Number.isFinite(na)) return -1; if (Number.isFinite(nb)) return 1; return 0;
    });

    // ---- 시트 재작성(미지의 컬럼은 기존 행에서 보존) ----
    const values = [header];
    const newSnap = {};
    for (const t of forSheet) {
      const base = rowBaseById.get(t.id);
      const r = base ? pad(base) : new Array(width).fill('');
      const f = appFields(t);
      for (const c of COLUMNS) r[idxOf[c.header]] = norm(f[c.key]);
      r[idCol] = t.id;
      values.push(r);
      newSnap[t.id] = sig(f);
    }
    await writeGrid(token, cfg.spreadsheetId, title, values);
    // 이전보다 행이 줄었으면 하단 잔여행 비우기
    const oldLast = 1 + dataRows.length;
    const newLast = 1 + forSheet.length;
    if (oldLast > newLast) {
      const a1 = `'${title.replace(/'/g, "''")}'!A${newLast + 1}:${colLetter(width - 1)}${oldLast}`;
      try { await clearRange(token, cfg.spreadsheetId, a1); } catch (e) {}
    }

    // ---- 앱 상태 저장 ----
    state.todos = finalTodos;
    await env.DB
      .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
      .bind(JSON.stringify(state), Date.now())
      .run();

    // ---- 설정/스냅샷 저장 ----
    cfg.snap = newSnap;
    cfg.lastSync = Date.now();
    gdoc.sheet = cfg;
    await writeGoogleDoc(env, gdoc);

    return { ok: true, pushed, pulled, deletedLocal, deletedRemote, conflicts, total: finalTodos.length, title };
  } catch (err) {
    return { error: String((err && err.message) || err), status: (err && err.status) || 500 };
  }
}
