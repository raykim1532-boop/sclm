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
        let r = await put(Object.assign({}, data, baseVersion ? { baseVersion } : {}));
        if (r.status === 401) { logout(); location.reload(); return false; }

        // 409 = 내가 읽은 뒤 다른 곳에서 먼저 저장했다. 조용히 덮어쓰지 않고 사용자에게 묻는다.
        if (r.status === 409) {
          const info = await r.json().catch(() => ({}));
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

        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (typeof j.version === 'number') baseVersion = j.version;
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
    getVersion: () => baseVersion,
    token: () => token || '',
    pending: pendingGet,
    clearPending: pendingClear,
    wasOnline: () => lastLoadOnline
  };
})();
