/*
 * 클라우드 동기화 모듈.
 * 앱이 http(s)로 서빙되고 백엔드(/api)가 있으면 "클라우드 모드"로 전환한다.
 *  - 비밀번호로 로그인(토큰=비밀번호, HTTPS 전제) → 토큰을 localStorage에 보관
 *  - window.api.loadData/saveData 를 클라우드 REST 호출로 교체 (다른 기기와 같은 데이터 공유)
 *  - 로컬(file://)로 열면 detect()가 false → 기존 로컬 저장 그대로 (동작 변화 없음)
 */
(function () {
  'use strict';
  const TOKEN_KEY = 'myscheduler:cloud:token';
  const LS_DATA_KEY = 'myscheduler:data:v1';
  // 오프라인에서 저장한 변경분. 온라인 복귀 시 사용자에게 물어보고 반영/폐기한다.
  const PENDING_KEY = 'myscheduler:offline:pending';
  const localApi = window.api; // 로컬 저장 계층 (export/import 재사용, 재귀 방지)
  let token = null;
  let lastLoadOnline = false; // 마지막 loadData가 서버에서 온 것인지
  // 마지막으로 읽어온 서버 버전(=documents.updated_at). 저장할 때 함께 보내
  // 그 사이 다른 기기/탭이 먼저 저장했는지 서버가 판단하게 한다.
  let baseVersion = 0;
  // 충돌이 났을 때 앱에 알리는 콜백 (app.js가 등록). 등록 전이면 그냥 실패 처리.
  let onConflict = null;
  // 마지막으로 서버와 맞춘 상태의 사본. 3자 병합의 기준점(base)이다.
  // 저장에 성공할 때마다, 그리고 불러올 때마다 갱신한다.
  let baseSnapshot = null;
  // 병합으로 조용히 넘어간 것들을 앱에 알리는 콜백(토스트용).
  let onMerged = null;
  const snap = (d) => { try { return JSON.parse(JSON.stringify(d)); } catch (e) { return null; } };

  const isHttp = () => location.protocol === 'http:' || location.protocol === 'https:';

  /* 서버에서 받은 상태를 앱이 기대하는 모양으로 맞춘다.
     ⚠️ **모르는 키는 절대 버리지 말 것** — 여기서 화이트리스트로 새 객체를 만들면
     나중에 추가된 필드(subMaster·channelColors 등)가 앱을 열 때마다 조용히 사라지고,
     다음 저장 때 서버에서도 지워진다. 2026-07-29 소분류 목록이 이렇게 없어졌다.
     그래서 원본을 먼저 펼치고(Object.assign) 아는 키만 보정한다. */
  function ensureShape(d) {
    d = d || {};
    return Object.assign({}, d, {
      settings: Object.assign({ theme: 'light', accent: '#1a73e8' }, d.settings || {}),
      projects: Array.isArray(d.projects) && d.projects.length ? d.projects : [{ id: 'default', name: '일반', color: '#1a73e8' }],
      events: Array.isArray(d.events) ? d.events : [],
      todos: Array.isArray(d.todos) ? d.todos : [],
      channels: Array.isArray(d.channels) ? d.channels : uniqueChannels(d.todos),
      tasks: Array.isArray(d.tasks) ? d.tasks : [],
      vault: d.vault || undefined // 계정 금고(암호문). 있으면 그대로 보존.
    });
  }

  /* ---------- 3자 병합 ----------
     두 기기를 동시에 켜 두면 충돌은 예외가 아니라 필연이다(앱이 연 뒤로 서버를 다시 안 읽으므로).
     그런데 실제로 부딪히는 건 드물다 — 대개 서로 **다른 할 일**을 고친다.
     그래서 "내가 읽어온 시점(base) · 내 것(mine) · 서버 것(theirs)" 셋을 비교해
     한쪽만 바꾼 건 그대로 반영하고, 같은 걸 양쪽에서 바꾼 것만 충돌로 돌려준다.

     ⚠️ **모르는 키도 반드시 살린다** — 2026-07-29 화이트리스트 때문에 소분류 목록이 통째로
        사라진 적이 있다. 아래는 키 이름을 열거하지 않고 세 쪽의 키를 모두 훑는다.
     ⚠️ 금고(vault)는 통짜 암호문이라 합칠 수 없다. 한쪽만 바뀌었으면 그쪽, 양쪽 다 바뀌었으면
        충돌로 올려 사용자에게 묻는다(조용히 하나를 버리면 계정이 사라진다). */

  // id 로 짝지어 비교하는 배열. **id 가 있는 배열을 state 에 새로 추가하면 여기에도 넣을 것** —
  // 안 넣으면 통짜로 비교돼 두 기기에서 각각 추가한 항목 중 하나가 사라진다.
  const RECORD_KEYS = ['todos', 'events', 'projects', 'recurTemplates'];
  const LIST_KEYS = ['channels', 'subMaster'];             // 단순 문자열 목록

  const eq = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const byId = (arr) => {
    const m = new Map();
    (Array.isArray(arr) ? arr : []).forEach((x) => { if (x && x.id != null) m.set(String(x.id), x); });
    return m;
  };

  /* 레코드 배열 하나를 병합. 순서는 theirs 를 기준으로 두고 내가 새로 만든 것을 뒤에 붙인다. */
  function mergeRecords(baseArr, mineArr, theirsArr, kind, conflicts) {
    const b = byId(baseArr), m = byId(mineArr), t = byId(theirsArr);
    const ids = [];
    (Array.isArray(theirsArr) ? theirsArr : []).forEach((x) => { if (x && x.id != null) ids.push(String(x.id)); });
    (Array.isArray(mineArr) ? mineArr : []).forEach((x) => { if (x && x.id != null && !ids.includes(String(x.id))) ids.push(String(x.id)); });

    const out = [];
    ids.forEach((id) => {
      const B = b.get(id), M = m.get(id), T = t.get(id);
      const mineChanged = !eq(B, M);
      const theirsChanged = !eq(B, T);
      let pick;
      if (!mineChanged) pick = T;                 // 나는 안 건드림 → 서버 따름(추가·수정·삭제 모두)
      else if (!theirsChanged) pick = M;          // 서버가 안 건드림 → 내 것
      else if (M === undefined && T === undefined) pick = undefined;   // 양쪽 다 삭제
      else if (M === undefined || T === undefined) {
        // 한쪽은 지우고 한쪽은 고쳤다 → 남기는 쪽을 택한다. 지우는 건 다시 할 수 있지만 잃은 건 못 되돌린다.
        pick = M === undefined ? T : M;
        conflicts.push({ kind: kind, id: id, why: 'deleted-vs-edited', label: recLabel(pick) });
      } else {
        // 같은 항목을 양쪽에서 고쳤다 → 지금 저장을 누른 이 창의 의도를 택하고 반드시 알린다.
        pick = M;
        conflicts.push({ kind: kind, id: id, why: 'both-edited', label: recLabel(M), theirs: T });
      }
      if (pick !== undefined) out.push(pick);
    });
    return out;
  }

  function recLabel(r) {
    if (!r) return '';
    return String(r.text || r.title || r.name || r.id || '').slice(0, 40);
  }

  /* 문자열 목록: 서버 것에서 내가 지운 것을 빼고, 내가 더한 것을 붙인다. */
  function mergeList(baseArr, mineArr, theirsArr) {
    const B = Array.isArray(baseArr) ? baseArr : [];
    const M = Array.isArray(mineArr) ? mineArr : [];
    const T = Array.isArray(theirsArr) ? theirsArr : [];
    const removedByMe = B.filter((v) => !M.includes(v));
    const addedByMe = M.filter((v) => !B.includes(v));
    const out = T.filter((v) => !removedByMe.includes(v));
    addedByMe.forEach((v) => { if (!out.includes(v)) out.push(v); });
    return out;
  }

  /* base=내가 읽어온 것, mine=지금 저장하려는 것, theirs=서버 최신.
     → { data, conflicts, needsAsk }. needsAsk 는 금고가 양쪽에서 바뀐 경우처럼 자동으로 못 정하는 때만 true. */
  function mergeStates(base, mine, theirs) {
    base = base || {}; mine = mine || {}; theirs = theirs || {};
    const conflicts = [];
    let needsAsk = false;
    const out = {};
    const keys = [];
    [theirs, mine, base].forEach((o) => Object.keys(o).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));

    keys.forEach((k) => {
      if (RECORD_KEYS.indexOf(k) > -1) { out[k] = mergeRecords(base[k], mine[k], theirs[k], k, conflicts); return; }
      if (LIST_KEYS.indexOf(k) > -1) { out[k] = mergeList(base[k], mine[k], theirs[k]); return; }

      const mineChanged = !eq(base[k], mine[k]);
      const theirsChanged = !eq(base[k], theirs[k]);
      if (k === 'vault') {
        if (mineChanged && theirsChanged) { needsAsk = true; conflicts.push({ kind: 'vault', why: 'both-edited', label: '계정 금고' }); out[k] = theirs[k]; }
        else out[k] = mineChanged ? mine[k] : theirs[k];
        return;
      }
      // 그 밖의 모든 키(설정·모르는 키 포함): 한쪽만 바뀌었으면 그쪽, 둘 다면 내 것.
      out[k] = mineChanged ? mine[k] : theirs[k];
      if (mineChanged && theirsChanged) conflicts.push({ kind: k, why: 'both-edited', label: k });
    });

    Object.keys(out).forEach((k) => { if (out[k] === undefined) delete out[k]; });
    return { data: out, conflicts: conflicts, needsAsk: needsAsk };
  }

  function authHeaders(extra) {
    return Object.assign({}, extra || {}, token ? { Authorization: 'Bearer ' + token } : {});
  }

  async function detect() {
    if (!isHttp()) return false;
    try {
      const r = await fetch('/api/health', { method: 'GET' });
      if (!r.ok) return false;
      const j = await r.json();
      return !!(j && j.cloud === true);
    } catch (e) { return false; }
  }

  /* true=확인됨, false=거부, 'offline'=서버에 물어볼 수 없음(비밀번호 검증 불가) */
  async function verify(tok) {
    try {
      const r = await fetch('/api/data', { headers: { Authorization: 'Bearer ' + tok } });
      // 서비스워커가 캐시로 응답한 경우 비밀번호가 맞는지 알 수 없다 → 통과시키지 않는다
      if (r.headers.get('X-SCLM-Offline') === '1') return 'offline';
      return r.status === 200;
    } catch (e) { return 'offline'; }
  }

  function logout() {
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  /* 로그인 게이트 오버레이. 로그인 성공 시 resolve. */
  function showLoginGate() {
    return new Promise((resolve) => {
      const gate = document.createElement('div');
      gate.className = 'cloud-gate';
      gate.innerHTML = `
        <form class="cloud-gate-box" autocomplete="off">
          <div class="cloud-gate-emoji">🔒</div>
          <h2>SCLM <small>(스케줄 관리)</small></h2>
          <p>비밀번호를 입력하면 이 기기에서 클라우드 데이터를 볼 수 있어요.</p>
          <input type="password" id="cloudPw" placeholder="비밀번호" autocomplete="current-password" />
          <button type="submit" class="btn btn-primary">로그인</button>
          <div class="cloud-gate-error" id="cloudPwError"></div>
        </form>`;
      document.body.appendChild(gate);
      const input = gate.querySelector('#cloudPw');
      const err = gate.querySelector('#cloudPwError');
      const form = gate.querySelector('form');
      setTimeout(() => input.focus(), 30);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pw = input.value.trim();
        if (!pw) return;
        err.textContent = '';
        form.classList.add('loading');
        const ok = await verify(pw);
        form.classList.remove('loading');
        if (ok === true) {
          token = pw;
          try { localStorage.setItem(TOKEN_KEY, token); } catch (e2) {}
          gate.remove();
          resolve(true);
        } else if (ok === 'offline') {
          err.textContent = '오프라인이라 비밀번호를 확인할 수 없어요. 연결 후 다시 시도해 주세요.';
        } else {
          err.textContent = '비밀번호가 올바르지 않아요.';
          input.select();
        }
      });
    });
  }

  async function ensureAuth() {
    try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }
    if (token) {
      const v = await verify(token);
      // 오프라인이면 저장된 토큰을 그대로 신뢰한다(저장 시점에 검증됨). 지우면 재로그인이 불가능해짐.
      if (v === true || v === 'offline') return true;
    }
    logout();
    return showLoginGate();
  }

  /* 오프라인 변경분 보관/조회 */
  function pendingGet() {
    try { const raw = localStorage.getItem(PENDING_KEY); return raw ? JSON.parse(raw) : null; }
    catch (e) { return null; }
  }
  function pendingClear() { try { localStorage.removeItem(PENDING_KEY); } catch (e) {} }

  /* 서버의 현재 버전만 확인한다(저장하기 전에 baseVersion 을 확보하기 위한 것).
     서비스워커 캐시 응답은 '서버에서 왔다'고 보지 않는다 — 그걸 기준으로 삼으면
     오프라인 사본을 최신인 양 믿게 된다. */
  async function probeServer() {
    try {
      const r = await fetch('/api/data', { headers: authHeaders() });
      if (!r.ok || r.headers.get('X-SCLM-Offline') === '1') return { online: false };
      const j = await r.json();
      return {
        online: true,
        hasData: !!(j && j.data),
        version: j && typeof j.version === 'number' ? j.version : 0,
        data: j && j.data ? ensureShape(j.data) : null
      };
    } catch (e) { return { online: false }; }
  }

  const cloudApi = {
    loadData: async () => {
      lastLoadOnline = false;
      try {
        const r = await fetch('/api/data', { headers: authHeaders() });
        if (r.status === 401) { logout(); location.reload(); return ensureShape(null); }
        // 서비스워커가 오프라인 캐시로 응답한 경우엔 '서버에서 왔다'고 보지 않는다
        lastLoadOnline = r.headers.get('X-SCLM-Offline') !== '1';
        const j = await r.json();
        if (lastLoadOnline && j && typeof j.version === 'number') baseVersion = j.version;
        if (j && j.data) {
          let data = ensureShape(j.data);
          // 서버에서 온 그대로를 병합 기준점으로 삼는다(내 미반영분을 얹기 전 상태여야 한다)
          if (lastLoadOnline) baseSnapshot = snap(data);
          // 오프라인 캐시 응답인데 이 기기에 미반영 변경분이 있으면 그쪽이 더 최신이다
          if (!lastLoadOnline) { const p = pendingGet(); if (p && p.data) data = ensureShape(p.data); }
          try { localStorage.setItem(LS_DATA_KEY, JSON.stringify(data)); } catch (e) {}
          return data;
        }
        // 클라우드가 비어있으면: 로컬 캐시(있으면)로 시드하고 업로드
        let seed = ensureShape(null);
        try { const raw = localStorage.getItem(LS_DATA_KEY); if (raw) seed = ensureShape(JSON.parse(raw)); } catch (e) {}
        await cloudApi.saveData(seed);
        return seed;
      } catch (e) {
        console.error('클라우드 불러오기 실패 — 로컬 캐시로 대체', e);
        const p = pendingGet();
        if (p && p.data) return ensureShape(p.data);
        try { const raw = localStorage.getItem(LS_DATA_KEY); if (raw) return ensureShape(JSON.parse(raw)); } catch (e2) {}
        return ensureShape(null);
      }
    },
    saveData: async (data) => {
      try { localStorage.setItem(LS_DATA_KEY, JSON.stringify(data)); } catch (e) {}
      // 서버 반영에 실패하면 '미반영 변경분'으로 남겨 두고, 온라인 복귀 때 물어본다
      const stash = () => {
        try { localStorage.setItem(PENDING_KEY, JSON.stringify({ at: new Date().toISOString(), data })); } catch (e) {}
      };
      const put = (payload) => fetch('/api/data', {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload)
      });
      try {
        // ⚠️ **baseVersion 없이 저장하지 않는다.** 안 실어 보내면 서버가 비교할 기준이 없어
        //    충돌 감지가 통째로 꺼지고, 그 저장은 3자 병합을 건너뛴 통짜 덮어쓰기가 된다.
        //    2026-08-03 메일 원클릭으로 완료 처리한 것이 이렇게 조용히 사라졌다.
        //    baseVersion 은 서비스워커 캐시로 데이터를 받으면(lastLoadOnline=false) 0으로 남고,
        //    네트워크가 한 번만 끊겨도 앱을 다시 열 때까지 계속 무방비가 된다.
        //    검증: sync-outofband.test.mjs
        let forceThis = false;
        if (!baseVersion) {
          const p = await probeServer();
          if (p.online && p.hasData) {
            if (baseSnapshot) {
              // 기준점이 있으니 409 → 3자 병합으로 안전하게 처리된다.
              // (지금은 baseVersion 과 baseSnapshot 이 늘 같이 세워져 이 갈래로 오지 않지만,
              //  둘이 어긋나게 되는 날에도 조용히 덮어쓰지 않도록 남겨 둔다.)
              baseVersion = p.version;
            } else {
              // 기준점이 없으면 무엇이 내 변경인지 가릴 수 없다 → 조용히 덮어쓰지 말고 묻는다
              const choice = onConflict ? await onConflict({ data: p.data, serverVersion: p.version }) : 'cancel';
              if (choice !== 'overwrite') {
                baseVersion = p.version;    // 서버 것을 따른다(앱이 다시 불러온다)
                pendingClear();
                return false;
              }
              forceThis = true;
            }
          }
        }

        let r = await put(Object.assign({}, data,
          forceThis ? { force: true } : (baseVersion ? { baseVersion } : {})));
        if (r.status === 401) { logout(); location.reload(); return false; }

        // 409 = 내가 읽은 뒤 다른 곳에서 먼저 저장했다.
        // 대개는 서로 **다른 항목**을 고친 것이므로 먼저 3자 병합을 시도하고,
        // 자동으로 못 정하는 경우(같은 금고를 양쪽에서 바꿈)에만 사용자에게 묻는다.
        if (r.status === 409) {
          const info = await r.json().catch(() => ({}));
          // 서버 원본은 기본값이 빠져 있을 수 있다. 기준점(base)은 이미 정규화돼 있으므로
          // 같은 모양으로 맞춰야 settings 같은 키가 엉뚱하게 충돌로 잡히지 않는다.
          const theirs = info && info.data ? ensureShape(info.data) : null;
          let handled = false;

          if (theirs && baseSnapshot) {
            const m = mergeStates(baseSnapshot, data, theirs);
            if (!m.needsAsk) {
              // 병합 결과를 서버 버전 위에 얹어 다시 저장한다(서버 것을 이미 반영했으므로 force).
              const merged = ensureShape(m.data);
              r = await put(Object.assign({}, merged, { force: true }));
              if (r.ok) {
                data = merged;
                try { localStorage.setItem(LS_DATA_KEY, JSON.stringify(merged)); } catch (e) {}
                if (onMerged) { try { onMerged(merged, m.conflicts); } catch (e) {} }
              }
              handled = true;
            }
          }

          if (!handled) {
            const choice = onConflict ? await onConflict(info) : 'cancel';
            if (choice === 'overwrite') {
              r = await put(Object.assign({}, data, { force: true }));
            } else {
              // 서버 것을 따른다 — 내 변경은 버리고 최신 버전으로 맞춘다
              if (typeof info.serverVersion === 'number') baseVersion = info.serverVersion;
              pendingClear();
              return false;
            }
          }
        }

        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (typeof j.version === 'number') baseVersion = j.version;
          baseSnapshot = snap(data);   // 지금 서버에 올린 것이 다음 병합의 기준점
          pendingClear();
        } else stash();
        return r.ok;
      } catch (e) {
        console.error('클라우드 저장 실패 (로컬에는 저장됨)', e);
        stash();
        return false;
      }
    },
    exportBackup: (d) => localApi.exportBackup(d),
    importBackup: () => localApi.importBackup(),
    // File System Access 동기화는 클라우드 모드에서 사용하지 않음
    startNewSyncFile: async () => ({ ok: false, error: '클라우드 모드에서는 사용하지 않아요.' }),
    openExistingSyncFile: async () => ({ ok: false, error: '클라우드 모드에서는 사용하지 않아요.' }),
    useLocalOnly: async () => ({ ok: true, dir: null, isDefault: true }),
    getSyncInfo: async () => ({ dir: '클라우드', isDefault: false })
  };

  // 앱 비밀번호(Bearer)로 보호된 엔드포인트 호출용 (구글 연동 등에서 사용)
  function authFetch(path, opts) {
    opts = opts || {};
    return fetch(path, Object.assign({}, opts, { headers: authHeaders(opts.headers) }));
  }

  window.CloudSync = {
    detect, ensureAuth, logout, api: cloudApi, authFetch,
    // 충돌 안내 UI 등록 — 'overwrite' | 'reload' 중 하나를 돌려주면 된다
    setConflictHandler: (fn) => { onConflict = fn; },
    // 자동 병합이 일어났을 때 알려 준다 — (병합된 데이터, 충돌목록)
    setMergeHandler: (fn) => { onMerged = fn; },
    mergeStates,                       // 테스트·디버그용
    getVersion: () => baseVersion,
    token: () => token || '',
    pending: pendingGet,
    clearPending: pendingClear,
    wasOnline: () => lastLoadOnline
  };
})();
