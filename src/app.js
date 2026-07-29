'use strict';

/* ---------- 전역 상태 ---------- */
let state = null;
let calendar = null;
let currentProjectViewId = null;
let draggedCardId = null;
let todoCal = null;
let todoLayoutMode = 'table';
let todoPage = 1;
let todoSort = { key: null, dir: 1 }; // 표 정렬 상태 (null이면 기본: No 순)

const PRIORITY_RANK = { '긴급': 0, '중요': 1, '보통': 2 };
const STATUS_RANK = { '대기': 0, '진행중': 1, '보류': 2, '완료': 3, '지연완료': 4 };
function todoSortValue(t, key) {
  switch (key) {
    case 'no': return t.no || 0;
    case 'registeredDate': return t.registeredDate || '9999-99-99';
    case 'dueDate': return t.dueDate || '9999-99-99';
    case 'completedDate': return t.completedDate || '9999-99-99';
    case 'project': { const p = byId(state.projects, t.projectId); return (p && p.name || '').toLowerCase(); }
    case 'channel': return (t.channel || '').toLowerCase();
    case 'subChannel': return (t.subChannel || '').toLowerCase();
    case 'priority': { const r = PRIORITY_RANK[normalizePriority(t.priority)]; return r === undefined ? 3 : r; }
    case 'text': return (t.text || '').toLowerCase();
    case 'assignee': return (t.assignee || '').toLowerCase();
    case 'status': { const r = STATUS_RANK[todoStatus(t)]; return r === undefined ? 9 : r; }
    default: return t.no || 0;
  }
}
function sortTodos(items) {
  if (!todoSort.key) return items;
  const { key, dir } = todoSort;
  return items.slice().sort((a, b) => {
    const va = todoSortValue(a, key), vb = todoSortValue(b, key);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return (a.no || 0) - (b.no || 0);
  });
}

/* 구글 캘린더의 기본 이벤트 색상 팔레트 (Tomato/Flamingo/Tangerine/Banana/Sage/Basil/Peacock/Blueberry/Lavender/Grape/Graphite) */
const PALETTE = ['#d50000', '#e67c73', '#f4511e', '#f6bf26', '#33b679', '#0b8043', '#039be5', '#3f51b5', '#7986cb', '#8e24aa', '#616161'];

/* 할 일 목록의 "진행상태" 옵션과 태그 색상 (구글시트 업무 트래커 양식과 동일하게 맞춤) */
const TODO_STATUS_OPTIONS = ['대기', '진행중', '완료', '지연완료', '보류'];
const TODO_STATUS_COLORS = {
  '완료': '#0f9d58',
  '지연완료': '#f4511e',
  '진행중': '#039be5',
  '대기': '#9b9a97',
  '보류': '#eb5757'
};
function todoStatus(t) { return t.status || (t.done ? '완료' : '대기'); }
function todoIsDone(t) { const s = todoStatus(t); return s === '완료' || s === '지연완료'; }
/* 우선순위 정규화: 긴급/중요/보통 중 하나로 (동의어 흡수), 그 외/공란은 '' */
function normalizePriority(v) {
  const s = String(v || '').trim();
  if (/긴급|urgent|critical|★|매우|최우선/i.test(s)) return '긴급';
  if (/중요|high|important/i.test(s)) return '중요';
  if (/보통|normal|낮음|low/i.test(s)) return '보통';
  return s === '' ? '' : s;
}
/* 캘린더에 할 일을 표시할 때 붙는 접두 아이콘: 긴급 🔴 · 중요 🟠 · 점검필요 ⚠ · 그 외 ✓ */
function todoCalendarPrefix(t) {
  if (todoIsDone(t)) return '✓ ';
  const p = normalizePriority(t.priority);
  let mark = p === '긴급' ? '🔴 ' : p === '중요' ? '🟠 ' : '✓ ';
  if (t.needsCheck === 'Y') mark += '⚠ ';
  return mark;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function byId(arr, id) { return arr.find((x) => x.id === id); }
function projectColor(projectId) {
  const p = byId(state.projects, projectId);
  return (p && p.color) || '#1a73e8';
}

// 중분류 색상: 명시 지정(state.channelColors)이 있으면 그 색, 없으면 이름 해시로 자동 배정
const CHANNEL_PALETTE = ['#1a73e8', '#0b8043', '#e8710a', '#8e24aa', '#00897b', '#c2185b', '#3f51b5', '#f9ab00', '#5d4037', '#00acc1', '#7cb342', '#d81b60'];
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function channelColor(name) {
  name = (name || '').trim();
  if (!name) return '#9b9a97';
  if (state.channelColors && state.channelColors[name]) return state.channelColors[name];
  return CHANNEL_PALETTE[hashStr(name) % CHANNEL_PALETTE.length];
}
function setChannelColor(name, color) {
  if (!state.channelColors) state.channelColors = {};
  state.channelColors[name] = color;
}
function channelChipHtml(name) {
  if (!name) return '';
  const c = channelColor(name);
  return `<span class="ch-chip" style="background:${c}1f;color:${c}">${escapeHtml(name)}</span>`;
}

/* 노션 스타일 파스텔 태그(연한 배경 + 진한 글자색) 렌더링 헬퍼 */
function tagHtml(text, color) {
  return `<span class="tag" style="background:${color}1f;color:${color}">${escapeHtml(text)}</span>`;
}

/* ---------- 오프라인 지원 ---------- */
/* 서비스워커 등록 — 오프라인 캐싱(앱 셸 + 마지막 데이터)과 웹푸시를 함께 담당한다.
   https 또는 localhost 에서만 동작. 실패해도 앱은 그대로 온라인으로 동작. */
function setupServiceWorker() {
  const ok = ('serviceWorker' in navigator) &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  if (!ok) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* 오프라인 표시줄 + 온라인 복귀 시 미반영 변경분 처리 */
function setupOfflineBar() {
  const bar = document.createElement('div');
  bar.className = 'offline-bar';
  bar.innerHTML = '📴 오프라인 — 변경사항은 이 기기에만 저장됩니다';
  document.body.appendChild(bar);

  const paint = () => document.body.classList.toggle('is-offline', !navigator.onLine);
  paint();
  window.addEventListener('offline', paint);
  window.addEventListener('online', () => { paint(); reconcileOffline(); });
}

/* 오프라인에서 저장한 변경분이 남아 있으면 서버 반영 여부를 사용자에게 묻는다.
   자동으로 덮어쓰면 다른 기기의 작업을 지울 수 있어 반드시 확인을 받는다. */
let reconciling = false;
async function reconcileOffline() {
  if (!cloudMode || reconciling || !navigator.onLine) return;
  if (!window.CloudSync || !CloudSync.pending) return;
  const p = CloudSync.pending();
  if (!p || !p.data) return;
  reconciling = true;
  try {
    // 서버가 실제로 응답하는지 먼저 확인 (온라인 이벤트가 떠도 연결이 안 될 수 있음)
    try { const r = await CloudSync.authFetch('/api/health'); if (!r.ok) return; }
    catch (e) { return; }

    const when = (p.at || '').replace('T', ' ').slice(0, 16);
    const yes = confirm(
      '오프라인 상태에서 저장한 변경사항이 있어요' + (when ? ` (${when})` : '') + '.\n\n' +
      '[확인] 이 기기의 내용을 서버에 올립니다 (서버 내용을 덮어씀)\n' +
      '[취소] 오프라인 변경을 버리고 서버 내용을 사용합니다'
    );
    if (yes) {
      const okSave = await CloudSync.api.saveData(p.data);
      if (okSave) { state = p.data; migrateTaxonomy(state); renderAll(); toast('오프라인 변경사항을 서버에 반영했어요'); }
      else toast('서버 반영에 실패했어요. 잠시 후 다시 시도해 주세요.');
    } else {
      CloudSync.clearPending();
      state = await window.api.loadData();
      renderAll();
      toast('서버 내용으로 되돌렸어요');
    }
  } finally { reconciling = false; }
}

/* ---------- 초기화 ---------- */
let cloudMode = false;

async function init() {
  setupServiceWorker();
  if (window.CloudSync && await CloudSync.detect()) {
    await CloudSync.ensureAuth();
    window.api = CloudSync.api;
    cloudMode = true;
    document.body.classList.add('cloud-mode');
  }
  state = await window.api.loadData();
  migrateTaxonomy(state);   // 할 일에 쓰인 분류값을 목록에 편입 (상태를 새로 받을 때마다 필요)
  applyTheme();
  setupNav();
  setupCalendar();
  setupTodos();
  setupTodoBulk();
  setupProjects();
  setupSettings();
  setupSync();
  setupModal();
  setupScrollTop();
  setupOfflineBar();
  renderAll();
  if (cloudMode) {
    setupConflictHandler();
    setupCloudUI(); setupGoogle(); setupSheet(); setupBackup(); setupPush(); setupAssistant();
    // 화면을 먼저 그린 뒤에 미반영 변경분을 확인한다
    if (CloudSync.wasOnline && CloudSync.wasOnline()) reconcileOffline();
  }
}

/* ---------- AI 일정 비서 (클라우드 전용) ---------- */
let asstHistory = [];
function setupAssistant() {
  const fab = document.getElementById('asstFab');
  const panel = document.getElementById('asstPanel');
  if (!fab || !panel || !window.CloudSync || !CloudSync.authFetch) return;
  fab.classList.remove('hidden');
  const msgs = document.getElementById('asstMsgs');
  const input = document.getElementById('asstInput');
  const sendBtn = document.getElementById('asstSend');

  const open = () => {
    panel.classList.remove('hidden'); fab.classList.add('hidden');
    if (!msgs.children.length) addAsstMsg('assistant', '안녕하세요! 일정·할 일을 도와드릴게요.\n예) "다음 주 화 오후 미팅 잡아줘", "내일 뭐 있어?", "쿠팡 정산 자료 준비 할일 추가"');
    setTimeout(() => input.focus(), 50);
  };
  const close = () => { panel.classList.add('hidden'); fab.classList.remove('hidden'); };
  fab.onclick = open;
  document.getElementById('asstClose').onclick = close;

  function addAsstMsg(role, text) {
    const d = document.createElement('div');
    d.className = 'asst-msg ' + role;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    input.value = '';
    addAsstMsg('user', text);
    asstHistory.push({ role: 'user', content: text });
    const typing = addAsstMsg('assistant', '…');
    sendBtn.disabled = true; input.disabled = true;
    try {
      const r = await CloudSync.authFetch('/api/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: asstHistory.slice(-8) })
      });
      const j = await r.json();
      const reply = j.reply || '(응답 없음)';
      typing.textContent = reply;
      asstHistory.push({ role: 'assistant', content: reply });
      if (asstHistory.length > 16) asstHistory = asstHistory.slice(-16);
      if (j.changed) { state = await window.api.loadData(); migrateTaxonomy(state); renderAll(); }
    } catch (e) {
      typing.textContent = '⚠ 연결 실패 — 잠시 후 다시 시도해주세요.';
    }
    sendBtn.disabled = false; input.disabled = false; input.focus();
  }
  sendBtn.onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
}

/* ---------- 푸시 알림 (클라우드 전용, Web Push) ---------- */
const VAPID_PUBLIC_KEY = 'BERIQAI4bVo7Wr1uOIg_zZv6nXtl9xXSyl0VjNOp3BIfxD7dRPFeFkq1YeQ9YTctNPxrJx_qWcHnZE-TJb5cot8';

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function setupPush() {
  const card = document.getElementById('pushCard');
  if (!card || !window.CloudSync || !CloudSync.authFetch) return;
  const supported = ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  card.classList.remove('hidden');

  const statusText = document.getElementById('pushStatusText');
  const enableBtn = document.getElementById('pushEnableBtn');
  const disableBtn = document.getElementById('pushDisableBtn');
  const testBtn = document.getElementById('pushTestBtn');
  const result = document.getElementById('pushResult');

  if (!supported) {
    statusText.textContent = '이 브라우저는 푸시 알림을 지원하지 않아요';
    enableBtn.classList.add('hidden');
    return;
  }

  let reg = null;
  try { reg = await navigator.serviceWorker.register('/sw.js'); }
  catch (e) { statusText.textContent = '알림 초기화 실패'; enableBtn.classList.add('hidden'); return; }

  async function refresh() {
    const sub = await reg.pushManager.getSubscription();
    const on = !!sub && Notification.permission === 'granted';
    statusText.textContent = on ? '✅ 이 기기에서 알림 켜짐' : '알림 꺼짐 (이 기기)';
    enableBtn.classList.toggle('hidden', on);
    disableBtn.classList.toggle('hidden', !on);
    testBtn.classList.toggle('hidden', !on);
    return sub;
  }

  enableBtn.onclick = async () => {
    enableBtn.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('알림 권한이 거부됐어요. 브라우저 설정에서 허용해 주세요.'); enableBtn.disabled = false; return; }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
      }
      const r = await CloudSync.authFetch('/api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() })
      });
      const j = await r.json();
      if (j.ok) toast('알림을 켰어요 🔔'); else toast('등록 실패');
    } catch (e) { toast('알림 켜기 실패: ' + (e.message || e)); }
    enableBtn.disabled = false;
    refresh();
  };

  disableBtn.onclick = async () => {
    disableBtn.disabled = true;
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await CloudSync.authFetch('/api/push/subscribe', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint })
        });
        await sub.unsubscribe();
      }
      toast('알림을 껐어요');
    } catch (e) { toast('알림 끄기 실패'); }
    disableBtn.disabled = false;
    refresh();
  };

  testBtn.onclick = async () => {
    testBtn.disabled = true;
    result.style.display = 'none';
    try {
      const r = await CloudSync.authFetch('/api/push/test', { method: 'POST' });
      const j = await r.json();
      if (j.ok) {
        toast('테스트 알림을 보냈어요');
        result.style.display = 'block';
        result.textContent = `발송 ${j.sent}건 · 등록기기 ${j.subs}건` + (j.removed ? ` · 만료정리 ${j.removed}` : '') + (j.errors && j.errors.length ? `\n오류: ${j.errors.join(' / ')}` : '');
      } else toast('테스트 발송 실패');
    } catch (e) { toast('테스트 발송 실패'); }
    testBtn.disabled = false;
  };

  refresh();
}

/* ---------- 백업 & 복구 (클라우드 전용, D1 스냅샷) ---------- */
async function setupBackup() {
  const card = document.getElementById('backupCard');
  if (!card || !window.CloudSync || !CloudSync.authFetch) return;
  card.classList.remove('hidden');

  document.getElementById('snapshotNowBtn').onclick = async () => {
    try {
      const r = await CloudSync.authFetch('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'manual', force: true }) });
      const j = await r.json();
      if (j.ok) { toast('백업했어요'); renderSnapshots(); } else toast('백업 실패');
    } catch (e) { toast('백업 실패'); }
  };

  // 하루 1회 자동 백업(서버가 중복 방지)
  try { await CloudSync.authFetch('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'daily' }) }); } catch (e) {}
  renderSnapshots();
}

function fmtSnapTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function renderSnapshots() {
  const box = document.getElementById('snapshotList');
  if (!box || !window.CloudSync || !CloudSync.authFetch) return;
  try {
    const r = await CloudSync.authFetch('/api/snapshots');
    const j = await r.json();
    const list = j.snapshots || [];
    if (!list.length) { box.innerHTML = '<span class="channel-empty">아직 백업이 없어요.</span>'; return; }
    box.innerHTML = list.map((s) =>
      `<div class="snapshot-row">
        <div class="snap-info"><b>${fmtSnapTime(s.created_at)}</b> <span class="snap-reason">${escapeHtml(s.reason || '')}</span><div class="snap-summary">${escapeHtml(s.summary || '')}</div></div>
        <button class="btn snap-restore" data-id="${escapeHtml(s.id)}">복원</button>
      </div>`).join('');
    box.querySelectorAll('.snap-restore').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('이 시점으로 되돌릴까요?\n(복원 전 현재 상태도 자동 백업됩니다)')) return;
        btn.disabled = true;
        try {
          const r2 = await CloudSync.authFetch('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'restore', id: btn.getAttribute('data-id') }) });
          const j2 = await r2.json();
          if (j2.ok) {
            state = await window.api.loadData(); migrateTaxonomy(state); applyTheme(); renderAll();
            toast(j2.vaultKept ? '이전 상태로 되돌렸어요 (Password 관리자는 현재 것 유지)' : '이전 상태로 되돌렸어요');
            renderSnapshots();
          }
          else toast('복원 실패: ' + (j2.error || ''));
        } catch (e) { toast('복원 요청 실패'); }
        btn.disabled = false;
      };
    });
  } catch (e) { box.innerHTML = '<span class="channel-empty">백업 목록을 불러오지 못했어요.</span>'; }
}

// 큰 변경(가져오기 등) 직전 강제 백업 (클라우드 전용, 실패해도 진행)
async function snapshotBefore(reason) {
  if (!window.CloudSync || !CloudSync.authFetch) return;
  try { await CloudSync.authFetch('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason || 'change', force: true }) }); } catch (e) {}
}

/* ---------- 구글 캘린더 연동 (1단계: OAuth 연결) ---------- */
async function setupGoogle() {
  const card = document.getElementById('googleCard');
  if (!card || !window.CloudSync || !CloudSync.authFetch) return;
  card.classList.remove('hidden');

  const statusText = document.getElementById('googleStatusText');
  const connectBtn = document.getElementById('googleConnectBtn');
  const syncBtn = document.getElementById('googleSyncBtn');
  const disconnectBtn = document.getElementById('googleDisconnectBtn');
  const resultEl = document.getElementById('googleSyncResult');
  const autoRow = document.getElementById('googleAutoRow');
  const autoChk = document.getElementById('googleAutoSync');
  const readRow = document.getElementById('googleReadRow');
  const readList = document.getElementById('googleReadList');
  const readSaveBtn = document.getElementById('googleReadSaveBtn');

  let connected = false;
  let readMax = 8;

  /* 읽기 전용으로 가져올 캘린더 고르기.
     여기서 고른 캘린더에는 앱이 쓰지 않는다 — 보기만 한다(서버 sync.js도 같은 규칙). */
  async function loadReadCalendars() {
    if (!readRow || !readList) return;
    readRow.style.display = '';
    readList.innerHTML = '<span class="hint">캘린더 목록 불러오는 중…</span>';
    try {
      const r = await CloudSync.authFetch('/api/google/calendars');
      const j = await r.json();
      if (!j.ok) { readList.innerHTML = '<span class="hint">목록을 불러오지 못했어요.</span>'; return; }
      readMax = j.max || 8;
      if (!j.items.length) { readList.innerHTML = '<span class="hint">가져올 다른 캘린더가 없어요.</span>'; return; }
      readList.innerHTML = j.items.map((c) => `
        <label class="ro-cal-item">
          <input type="checkbox" value="${escapeHtml(c.id)}" ${c.selected ? 'checked' : ''} />
          <span class="ro-cal-dot" style="background:${escapeHtml(c.color || '#9b9a97')}"></span>
          <span class="ro-cal-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
          ${c.primary ? '<span class="ch-badge">기본</span>' : ''}
        </label>`).join('');
    } catch (e) {
      readList.innerHTML = '<span class="hint">목록을 불러오지 못했어요.</span>';
    }
  }

  if (readSaveBtn) readSaveBtn.onclick = async () => {
    const ids = [...readList.querySelectorAll('input:checked')].map((i) => i.value);
    if (ids.length > readMax) { toast(`캘린더는 최대 ${readMax}개까지 고를 수 있어요`); return; }
    readSaveBtn.disabled = true;
    try {
      const r = await CloudSync.authFetch('/api/google/calendars', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
      });
      const j = await r.json();
      if (!j.ok) { toast('저장에 실패했어요'); return; }
      toast(ids.length ? `캘린더 ${ids.length}개를 가져오도록 설정했어요 — 동기화합니다` : '가져오기를 모두 껐어요 — 동기화합니다');
      await runSync(false);
    } finally { readSaveBtn.disabled = false; }
  };

  async function refresh() {
    try {
      const r = await CloudSync.authFetch('/api/google/status');
      const j = await r.json();
      connected = !!j.connected;
      if (connected) {
        statusText.textContent = '✅ 구글 캘린더에 연결됨';
        connectBtn.classList.add('hidden');
        syncBtn.classList.remove('hidden');
        disconnectBtn.classList.remove('hidden');
        if (autoRow) autoRow.style.display = '';
        loadReadCalendars();
      } else {
        statusText.textContent = j.hasClient ? '연결되지 않음' : '⚠ 구글 클라우드 설정(GOOGLE_CLIENT_ID/SECRET)이 필요해요';
        connectBtn.classList.remove('hidden');
        syncBtn.classList.add('hidden');
        disconnectBtn.classList.add('hidden');
        if (autoRow) autoRow.style.display = 'none';
        if (readRow) readRow.style.display = 'none';
      }
    } catch (e) { statusText.textContent = '상태 확인 실패'; }
  }

  // 공통 동기화. silent=true면 백그라운드(조용히).
  async function runSync(silent) {
    try {
      const r = await CloudSync.authFetch('/api/google/sync', { method: 'POST' });
      const j = await r.json();
      if (j.ok) {
        const changed = j.pushed + j.updated + j.pulled + j.deletedLocal + j.deletedRemote;
        if (changed > 0) { state = await window.api.loadData(); migrateTaxonomy(state); applyTheme(); renderAll(); }
        const summary = `보냄 ${j.pushed} · 수정 ${j.updated} · 가져옴 ${j.pulled} · 삭제 ${j.deletedLocal + j.deletedRemote}`
          + (j.truncated ? ' · (분량 많아 이어서 진행됨)' : '');
        if (!silent || changed > 0) toast('구글 동기화 — ' + summary);
        if (resultEl) {
          resultEl.style.display = 'block';
          resultEl.textContent = '마지막 동기화: ' + summary + (j.errors && j.errors.length ? '\n일부 실패: ' + j.errors.join(' / ') : '');
        }
        // 분량이 많아 잘렸으면 한 번 더 이어서
        if (j.truncated) setTimeout(() => runSync(true), 1500);
      } else if (!silent) {
        toast('동기화 실패: ' + (j.error || ''));
        if (resultEl) { resultEl.style.display = 'block'; resultEl.textContent = '실패: ' + (j.error || '') + (j.errors && j.errors.length ? '\n' + j.errors.join(' / ') : ''); }
      }
    } catch (e) { if (!silent) toast('동기화 요청 실패'); }
  }

  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    const prev = statusText.textContent;
    statusText.textContent = '🔄 동기화 중… (수십 초 걸릴 수 있어요)';
    if (resultEl) resultEl.style.display = 'none';
    await runSync(false);
    statusText.textContent = prev;
    syncBtn.disabled = false;
    refresh();
  };

  // 자동 동기화 (localStorage 'googleAutoSync', 기본 켜짐)
  if (autoChk) {
    autoChk.checked = localStorage.getItem('googleAutoSync') !== '0';
    autoChk.onchange = () => {
      localStorage.setItem('googleAutoSync', autoChk.checked ? '1' : '0');
      if (autoChk.checked) runSync(true);
    };
  }
  // 앱 열 때 1회만 동기화. 주기적 폴링(기존 15분)은 제거하고 매일 08:00 서버(크론)가 대신 처리한다.
  if (!setupGoogle._autoStarted) {
    setupGoogle._autoStarted = true;
    const autoOn = () => localStorage.getItem('googleAutoSync') !== '0';
    setTimeout(() => { if (connected && autoOn()) runSync(true); }, 3500);
  }

  connectBtn.onclick = async () => {
    connectBtn.disabled = true;
    try {
      const r = await CloudSync.authFetch('/api/google/auth');
      const j = await r.json();
      if (j.url) { window.location.href = j.url; return; }
      toast(j.error || '구글 설정이 필요해요');
    } catch (e) { toast('연결 시작 실패'); }
    connectBtn.disabled = false;
  };

  disconnectBtn.onclick = async () => {
    try { await CloudSync.authFetch('/api/google/status', { method: 'DELETE' }); } catch (e) {}
    toast('구글 연결을 해제했어요');
    refresh();
  };

  // OAuth 리다이렉트 결과 처리
  const params = new URLSearchParams(location.search);
  if (params.get('google')) {
    const g = params.get('google');
    const msg = {
      connected: '구글 캘린더에 연결됐어요 🎉',
      no_refresh: '연결됐지만 리프레시 토큰을 못 받았어요. 구글 계정 권한을 해제 후 다시 시도해주세요.',
      state_error: '보안 검증(state) 실패 — 다시 시도해주세요.',
      token_error: '토큰 교환 실패 — 클라이언트 설정을 확인해주세요.',
      error: '구글 로그인이 취소됐어요.'
    }[g] || ('구글 연동: ' + g);
    toast(msg);
    history.replaceState({}, '', location.pathname);
  }
  refresh();
}

/* ---------- 구글 시트 양방향 동기화 ---------- */
// 구글 시트 동기화는 2026-07-28 종료. 이제 이 앱이 업무 데이터의 원천이다.
// 시트가 원천이던 시절엔 앱에서 바꾼 상태·첨부가 다음 동기화 때 되돌아갔다.
// (서버의 sheet-config/sheet-sync 엔드포인트는 남아 있지만 disabled 로 거부한다)
function setupSheet() {
  const card = document.getElementById('sheetCard');
  if (!card || !window.CloudSync) return;
  card.classList.remove('hidden');
  try { localStorage.removeItem('sheetAutoSync'); } catch (e) {}
}

/* ---------- 계정 관리(금고): 마스터 비밀번호 클라이언트 암호화 ---------- */
/* 암·복호화는 브라우저 안에서만. D1엔 암호문(state.vault)만 저장. 마스터 비번은 메모리에도 남기지 않음(CryptoKey만 보관). */
const VAULT_ITER = 210000;
let vaultKey = null;        // 잠금 해제 중일 때의 CryptoKey (비추출)
let vaultSalt = null;       // Uint8Array
let vaultIter = VAULT_ITER;
let vaultEntries = [];      // 복호화된 항목(메모리 전용)
let vaultEditId = null;
let vaultWired = false;

function vB64e(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }
function vB64d(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function vaultDeriveKey(password, salt, iter) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function vaultSave() {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(vaultEntries));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, pt);
  state.vault = { v: 1, kdf: 'PBKDF2', iterations: vaultIter, salt: vB64e(vaultSalt), iv: vB64e(iv), ct: vB64e(ct) };
  await window.api.saveData(state);
}
function vaultLock() {
  vaultKey = null; vaultSalt = null; vaultEntries = []; vaultEditId = null;
  const cp = document.getElementById('vaultChangePwCard');
  if (cp) cp.classList.add('hidden');
  renderVault();
}

/* 자동 잠금: 잠금 해제 상태에서 일정 시간 입력이 없으면 잠근다(브라우저 로컬 설정). */
const VAULT_IDLE_KEY = 'vaultIdleMin';
let vaultLastActivity = Date.now();
function vaultIdleMinutes() {
  const v = localStorage.getItem(VAULT_IDLE_KEY);
  return v === null ? 10 : Number(v); // 기본 10분, 0이면 사용 안 함
}
function setupVaultIdleLock() {
  if (setupVaultIdleLock._started) return;
  setupVaultIdleLock._started = true;
  const touch = () => { vaultLastActivity = Date.now(); };
  ['mousedown', 'keydown', 'touchstart', 'focus'].forEach((ev) => window.addEventListener(ev, touch, true));
  setInterval(() => {
    const min = vaultIdleMinutes();
    if (!vaultKey || !min) return;
    if (Date.now() - vaultLastActivity >= min * 60 * 1000) {
      vaultLock();
      toast('🔒 자리를 비워 자동 잠금했어요');
    }
  }, 30 * 1000);
}

/* 강력한 비밀번호 생성 (헷갈리는 문자 제외, 각 종류 1개 이상 보장) */
function vaultGeneratePassword(len = 18) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+?'];
  const all = sets.join('');
  const pick = (s) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const out = sets.map(pick);
  while (out.length < len) out.push(pick(all));
  // Fisher-Yates 셔플(암호학적 난수)
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

function setupVault() {
  if (vaultWired) return;
  vaultWired = true;
  const $ = (id) => document.getElementById(id);

  $('vaultCreateBtn').onclick = async () => {
    const pw = $('vaultNewPw').value, pw2 = $('vaultNewPw2').value;
    const msg = $('vaultSetupMsg');
    const warn = (t) => { msg.style.display = 'block'; msg.style.color = '#d50000'; msg.textContent = t; };
    if (pw.length < 8) return warn('마스터 비밀번호는 8자 이상이어야 해요.');
    if (pw !== pw2) return warn('두 비밀번호가 일치하지 않아요.');
    vaultSalt = crypto.getRandomValues(new Uint8Array(16));
    vaultIter = VAULT_ITER;
    vaultKey = await vaultDeriveKey(pw, vaultSalt, vaultIter);
    vaultEntries = [];
    await vaultSave();
    $('vaultNewPw').value = ''; $('vaultNewPw2').value = ''; msg.style.display = 'none';
    vaultLastActivity = Date.now();
    toast('Password 관리자가 준비됐어요 🔐');
    renderVault();
  };

  $('vaultUnlockBtn').onclick = async () => {
    const pw = $('vaultPw').value;
    const msg = $('vaultUnlockMsg');
    if (!pw) return;
    try {
      const b = state.vault;
      const salt = vB64d(b.salt), iv = vB64d(b.iv), ct = vB64d(b.ct);
      const key = await vaultDeriveKey(pw, salt, b.iterations || VAULT_ITER);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); // 틀리면 예외
      vaultEntries = JSON.parse(new TextDecoder().decode(pt));
      vaultKey = key; vaultSalt = salt; vaultIter = b.iterations || VAULT_ITER;
      $('vaultPw').value = ''; msg.style.display = 'none';
      vaultLastActivity = Date.now(); // 자동 잠금 타이머 초기화
      renderVault();
    } catch (e) {
      msg.style.display = 'block'; msg.style.color = '#d50000';
      msg.textContent = '비밀번호가 틀렸어요.';
    }
  };
  $('vaultPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('vaultUnlockBtn').click(); });

  // 마스터 비밀번호 분실 → 금고 초기화(저장된 계정 전체 삭제, 복구 불가)
  $('vaultResetBtn').onclick = async () => {
    const typed = prompt('초기화하면 저장된 계정이 모두 삭제되며 복구할 수 없습니다.\n계속하려면 "초기화"라고 입력하세요.');
    if (typed === null) return;
    if (typed.trim() !== '초기화') { toast('입력이 일치하지 않아 취소했어요'); return; }
    try {
      state.vault = null;              // 서버에 명시적 삭제(vault:null) 전달 — 생략하면 서버가 기존 암호문을 보존함
      await window.api.saveData(state);
      delete state.vault;
      vaultLock();
      toast('초기화했어요 — 새 마스터 비밀번호로 다시 시작할 수 있어요');
    } catch (e) { toast('초기화 실패 — 잠시 후 다시 시도해주세요'); }
  };

  $('vaultLockBtn').onclick = vaultLock;
  $('vaultAddBtn').onclick = () => openVaultEdit(null);
  $('vaultSearch').addEventListener('input', renderVaultList);

  $('vfPassToggle').onclick = () => {
    const el = $('vfPass'); el.type = el.type === 'password' ? 'text' : 'password';
  };
  $('vfPassGen').onclick = () => {
    const el = $('vfPass');
    el.value = vaultGeneratePassword();
    el.type = 'text'; // 생성 결과는 확인할 수 있게 표시
    toast('강력한 비밀번호를 생성했어요');
  };

  // 자동 잠금 시간 설정
  const idleSel = $('vaultIdleSel');
  if (idleSel) {
    idleSel.value = String(vaultIdleMinutes());
    idleSel.onchange = () => {
      localStorage.setItem(VAULT_IDLE_KEY, idleSel.value);
      vaultLastActivity = Date.now();
      toast(idleSel.value === '0' ? '자동 잠금을 껐어요' : `${idleSel.value}분 후 자동 잠금`);
    };
  }
  setupVaultIdleLock();

  // 마스터 비밀번호 변경 (잠금 해제 상태에서만 — 전체 재암호화)
  $('vaultChangePwBtn').onclick = () => {
    $('vcpNew').value = ''; $('vcpNew2').value = ''; $('vcpMsg').style.display = 'none';
    $('vaultChangePwCard').classList.remove('hidden');
    $('vcpNew').focus();
  };
  $('vcpCancelBtn').onclick = () => $('vaultChangePwCard').classList.add('hidden');
  $('vcpSaveBtn').onclick = async () => {
    const pw = $('vcpNew').value, pw2 = $('vcpNew2').value, msg = $('vcpMsg');
    const warn = (t) => { msg.style.display = 'block'; msg.style.color = '#d50000'; msg.textContent = t; };
    if (!vaultKey) return warn('잠금 상태예요. 먼저 잠금을 해제해주세요.');
    if (pw.length < 8) return warn('8자 이상으로 정해주세요.');
    if (pw !== pw2) return warn('두 비밀번호가 일치하지 않아요.');
    const prevKey = vaultKey, prevSalt = vaultSalt, prevIter = vaultIter;
    try {
      vaultSalt = crypto.getRandomValues(new Uint8Array(16));
      vaultIter = VAULT_ITER;
      vaultKey = await vaultDeriveKey(pw, vaultSalt, vaultIter);
      await vaultSave(); // 메모리의 항목들을 새 키로 재암호화해 저장
      $('vaultChangePwCard').classList.add('hidden');
      toast('마스터 비밀번호를 변경했어요 🔑');
    } catch (e) {
      vaultKey = prevKey; vaultSalt = prevSalt; vaultIter = prevIter; // 실패 시 원복
      warn('변경에 실패했어요. 다시 시도해주세요.');
    }
  };
  $('vfCancelBtn').onclick = () => { $('vaultEditCard').classList.add('hidden'); $('vaultOpen').classList.remove('hidden'); };
  $('vfDeleteBtn').onclick = async () => {
    if (!vaultEditId) return;
    if (!confirm('이 계정을 삭제할까요?')) return;
    vaultEntries = vaultEntries.filter((e) => e.id !== vaultEditId);
    await vaultSave();
    toast('삭제했어요');
    $('vaultEditCard').classList.add('hidden'); renderVault();
  };
  $('vfSaveBtn').onclick = async () => {
    const site = $('vfSite').value.trim();
    if (!site) { toast('사이트/서비스명을 입력해주세요'); return; }
    const entry = {
      id: vaultEditId || ('v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      site, url: $('vfUrl').value.trim(), user: $('vfUser').value, pass: $('vfPass').value,
      category: $('vfCategory').value.trim(), memo: $('vfMemo').value, updatedAt: Date.now(),
    };
    if (vaultEditId) {
      const i = vaultEntries.findIndex((e) => e.id === vaultEditId);
      if (i >= 0) vaultEntries[i] = entry; else vaultEntries.push(entry);
    } else vaultEntries.push(entry);
    await vaultSave();
    toast('저장했어요');
    $('vaultEditCard').classList.add('hidden'); renderVault();
  };
}

function openVaultEdit(id) {
  const $ = (id) => document.getElementById(id);
  vaultEditId = id;
  const e = id ? vaultEntries.find((x) => x.id === id) : null;
  $('vaultEditTitle').textContent = e ? '계정 편집' : '계정 추가';
  $('vfSite').value = e ? e.site : '';
  $('vfUrl').value = e ? (e.url || '') : '';
  $('vfUser').value = e ? (e.user || '') : '';
  $('vfPass').value = e ? (e.pass || '') : '';
  $('vfPass').type = 'password';
  $('vfCategory').value = e ? (e.category || '') : '';
  $('vfMemo').value = e ? (e.memo || '') : '';
  $('vfDeleteBtn').style.display = e ? '' : 'none';
  // 분류 자동완성: 기존 금고 분류 + 프로젝트(대분류) 이름
  const dl = $('vfCategoryList');
  if (dl) {
    const cats = new Set([
      ...vaultEntries.map((x) => (x.category || '').trim()).filter(Boolean),
      ...((state && state.projects) || []).map((p) => p.name).filter(Boolean),
    ]);
    dl.innerHTML = [...cats].map((c) => '<option value="' + escapeHtml(c) + '"></option>').join('');
  }
  $('vaultOpen').classList.add('hidden');
  $('vaultEditCard').classList.remove('hidden');
  $('vfSite').focus();
}

async function vaultCopy(text, label) {
  try { await navigator.clipboard.writeText(text || ''); toast((label || '') + ' 복사됨'); }
  catch (e) { toast('복사 실패 — 브라우저 권한을 확인해주세요'); }
}

function renderVault() {
  setupVault();
  const $ = (id) => document.getElementById(id);
  const has = !!(state && state.vault && state.vault.ct);
  const unlocked = !!vaultKey;
  $('vaultSetupCard').classList.toggle('hidden', has);
  $('vaultUnlockCard').classList.toggle('hidden', !(has && !unlocked));
  $('vaultOpen').classList.toggle('hidden', !unlocked);
  $('vaultLockBtn').classList.toggle('hidden', !unlocked);
  if (!unlocked) { $('vaultEditCard').classList.add('hidden'); $('vaultChangePwCard').classList.add('hidden'); }
  if (unlocked) renderVaultList();
}

// URL 정규화: 프로토콜 없으면 https:// 붙임
function vaultUrl(u) {
  u = (u || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
}
// 표시용: 호스트명만(없으면 원문)
function vaultUrlLabel(u) {
  const full = vaultUrl(u);
  if (!full) return '';
  try { return new URL(full).hostname.replace(/^www\./, ''); } catch (e) { return (u || '').replace(/^https?:\/\//i, ''); }
}
// 사이트명 → 아바타 색(고정 해시)
function vaultAvatarColor(s) {
  s = String(s || '?');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'hsl(' + (h % 360) + ' 55% 48%)';
}

function renderVaultList() {
  const list = document.getElementById('vaultList');
  const q = (document.getElementById('vaultSearch').value || '').trim().toLowerCase();
  const items = vaultEntries
    .filter((e) => !q || (e.site + ' ' + (e.user || '') + ' ' + (e.category || '')).toLowerCase().includes(q))
    .sort((a, b) => (a.site || '').localeCompare(b.site || '', 'ko'));
  document.getElementById('vaultCount').textContent = vaultEntries.length + '개';
  if (!items.length) {
    list.innerHTML = '<div class="vault-empty">' + (vaultEntries.length ? '검색 결과가 없어요.' : '아직 저장된 계정이 없어요. “+ 계정 추가”로 시작하세요.') + '</div>';
    return;
  }
  list.innerHTML = '';
  for (const e of items) {
    const url = vaultUrl(e.url);
    const letter = (e.site || '?').trim().charAt(0).toUpperCase();
    const row = document.createElement('div');
    row.className = 'vault-item';
    row.innerHTML =
      '<div class="vi-avatar" style="background:' + vaultAvatarColor(e.site) + '">' + escapeHtml(letter) + '</div>'
      + '<div class="vi-main">'
      +   '<div class="vi-site">' + escapeHtml(e.site) + (e.category ? '<span class="vi-cat">' + escapeHtml(e.category) + '</span>' : '') + '</div>'
      +   '<div class="vi-sub">'
      +     (e.user ? '<span class="vi-user">👤 ' + escapeHtml(e.user) + '</span>' : '')
      +     (url ? '<a class="vi-link" data-act="link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">🔗 ' + escapeHtml(vaultUrlLabel(e.url)) + '</a>' : '')
      +   '</div>'
      + '</div>'
      + '<div class="vi-actions">'
      +   (e.user ? '<button class="vault-copy" data-act="user" title="아이디 복사">아이디</button>' : '')
      +   (e.pass ? '<button class="vault-copy" data-act="pass" title="비밀번호 복사">비번</button>' : '')
      +   (url ? '<button class="vault-copy vi-open" data-act="open" title="사이트 열기">열기 ↗</button>' : '')
      + '</div>';
    const wire = (sel, fn) => { const el = row.querySelector(sel); if (el) el.onclick = (ev) => { ev.stopPropagation(); fn(); }; };
    wire('[data-act="user"]', () => vaultCopy(e.user, '아이디'));
    wire('[data-act="pass"]', () => vaultCopy(e.pass, '비밀번호'));
    wire('[data-act="open"]', () => window.open(url, '_blank', 'noopener'));
    const link = row.querySelector('[data-act="link"]');
    if (link) link.addEventListener('click', (ev) => ev.stopPropagation()); // 링크 기본 이동은 유지, 편집 열림만 방지
    row.onclick = () => openVaultEdit(e.id);
    list.appendChild(row);
  }
}

/* 맨 아래로 내려가면 나타나는 "위로 가기" 버튼 (스크롤 컨테이너는 .main) */
function setupScrollTop() {
  const main = document.querySelector('.main');
  const btn = document.getElementById('scrollTopBtn');
  if (!main || !btn) return;
  main.addEventListener('scroll', () => {
    btn.classList.toggle('hidden', main.scrollTop < 300);
  });
  btn.addEventListener('click', () => main.scrollTo({ top: 0, behavior: 'smooth' }));
}

/* 클라우드 모드에서는 '다른 기기와 함께 쓰기'(로컬 파일 동기화) 카드를 클라우드 상태로 대체 */
function setupCloudUI() {
  const card = document.getElementById('localSyncCard');
  if (!card) return;
  card.innerHTML = `
    <h2>클라우드 동기화</h2>
    <div class="settings-row">
      <span>☁️ 클라우드에 연결됨 — 모든 기기에서 같은 데이터를 봅니다.</span>
      <button class="btn" id="cloudLogoutBtn">로그아웃</button>
    </div>
    <p class="hint">이 기기의 로그인을 해제해요. 데이터는 클라우드에 그대로 남아 있고, 다시 로그인하면 이어서 볼 수 있어요.</p>`;
  document.getElementById('cloudLogoutBtn').addEventListener('click', () => {
    CloudSync.logout();
    location.reload();
  });
}

function renderAll() {
  refreshBulkSelects();
  renderDashboard();
  renderSidebarProjects();
  refreshCalendarEvents();
  renderTodos();
  renderProjectTabs();
  renderKanban();
  renderSettingsUI();
  renderSyncUI();
}

/* 할 일을 지울 때 붙어 있던 첨부(R2 객체)도 함께 지운다.
   안 지우면 접근할 수 없는 고아 객체로 남아 용량만 차지한다.
   클라우드 모드에서만 동작하고, 실패해도 삭제 자체는 진행한다(최선 노력). */
async function deleteTodoFiles(todos) {
  if (!cloudMode || !window.CloudSync || !CloudSync.authFetch) return 0;
  const keys = [];
  (todos || []).forEach((t) => (t && Array.isArray(t.files) ? t.files : []).forEach((f) => { if (f && f.key) keys.push(f.key); }));
  if (!keys.length) return 0;
  await Promise.all(keys.map((k) =>
    CloudSync.authFetch('/api/files/' + k, { method: 'DELETE' }).catch(() => {})
  ));
  return keys.length;
}

async function persist() {
  const ok = await window.api.saveData(state);
  if (ok === false) toast('⚠ 클라우드 저장 실패 — 네트워크 확인 필요 (변경은 이 기기에 임시 저장됨)');
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ---------- 네비게이션 ---------- */
function setupNav() {
  const brand = document.getElementById('brandHome');
  if (brand) brand.addEventListener('click', () => location.reload());
  // 모바일 오프캔버스 사이드바
  const app = document.getElementById('app');
  const navToggle = document.getElementById('navToggle');
  const navBackdrop = document.getElementById('navBackdrop');
  const closeNav = () => app.classList.remove('nav-open');
  if (navToggle) navToggle.addEventListener('click', () => app.classList.toggle('nav-open'));
  if (navBackdrop) navBackdrop.addEventListener('click', closeNav);
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeNav();
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById('view-' + view).classList.add('active');
      if (view === 'calendar' && calendar) {
        setTimeout(() => { sizeCalendar(); calendar.updateSize(); }, 50);
      }
      if (view === 'todos' && todoLayoutMode === 'calendar' && todoCal) {
        setTimeout(() => todoCal.updateSize(), 50);
      }
      if (view === 'projects') renderKanban();
      if (view === 'channels') renderChannelSettings();
      if (view === 'dashboard') renderDashboard();
      if (view === 'vault') renderVault();
    });
  });
}

function renderSidebarProjects() {
  const ul = document.getElementById('sidebarProjectList');
  ul.innerHTML = '';
  state.projects.forEach((p) => {
    const li = document.createElement('li');
    if (p.id === currentProjectViewId) li.className = 'active';
    li.title = p.name;
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span><span>${escapeHtml(p.name)}</span>`;
    li.addEventListener('click', () => {
      currentProjectViewId = p.id;
      document.querySelector('.nav-btn[data-view="projects"]').click();
      renderProjectTabs();
      renderKanban();
      renderSidebarProjects();
    });
    ul.appendChild(li);
  });
  const count = document.getElementById('pqCount');
  if (count) count.textContent = state.projects.length;
  document.getElementById('quickAddProjectBtn').onclick = (e) => { e.stopPropagation(); openProjectModal(null); };

  const toggle = document.getElementById('pqToggle');
  const quick = document.getElementById('projectQuick');
  if (toggle && quick && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    if (localStorage.getItem('pqCollapsed') === '1') quick.classList.add('collapsed');
    toggle.addEventListener('click', () => {
      quick.classList.toggle('collapsed');
      localStorage.setItem('pqCollapsed', quick.classList.contains('collapsed') ? '1' : '0');
    });
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 캘린더 ---------- */
// 화면 높이에 맞춘 캘린더 높이(패딩·헤더 고려). 주 행이 균일하게 채워진다.
function calcCalendarHeight() {
  return Math.max(560, (window.innerHeight || 900) - 172);
}
function sizeCalendar() {
  if (calendar) calendar.setOption('height', calcCalendarHeight());
}

function setupCalendar() {
  const el = document.getElementById('calendar');
  calendar = new FullCalendar.Calendar(el, {
    initialView: 'dayGridMonth',
    height: calcCalendarHeight(),
    expandRows: true,
    dayMaxEvents: true,
    firstDay: 0,
    locales: [window.FC_KO_LOCALE],
    locale: 'ko',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    events: (info, success) => success(buildCalendarEvents()),
    dateClick: (info) => openEventModal(null, info.dateStr),
    eventClick: (info) => {
      const id = info.event.id;
      if (id.startsWith('ev-')) openEventModal(byId(state.events, id.slice(3)));
      else if (id.startsWith('td-')) openTodoModal(byId(state.todos, id.slice(3)));
      else if (id.startsWith('tk-')) openTaskModal(null, byId(state.tasks, id.slice(3)));
    }
  });
  calendar.render();
  document.getElementById('addEventBtn').onclick = () => openEventModal(null);
  window.addEventListener('resize', sizeCalendar);
}

// 구글 캘린더에서 가져온(외부) 일정 전용 색 — 프로젝트 색과 무관하게 고정
const GOOGLE_IMPORT_COLOR = '#4285F4';
const RO_CAL_COLOR = '#8a8f98';   // 읽기 전용으로 가져온 남의 캘린더 일정
function isGoogleImported(e) {
  // 가져온 일정은 pull 시 id가 'g'+짧은난수, source='google'로 생성됨. SCLM 자체 일정(uid)과 구분.
  return !!e && (e.source === 'google' ||
    (!!e.googleId && typeof e.id === 'string' && e.id.charAt(0) === 'g' && e.id.length <= 10));
}

function buildCalendarEvents() {
  const evs = state.events.map((e) => {
    const color = e.color ? e.color : (e.roCal ? RO_CAL_COLOR : (isGoogleImported(e) ? GOOGLE_IMPORT_COLOR : projectColor(e.projectId)));
    // 시간이 지정된(종일이 아닌) 일정: 날짜+시간을 합쳐 FullCalendar가 dot+시간+제목 형태로 보여주게 한다.
    if (!e.allDay && e.startTime) {
      const startIso = `${e.start}T${e.startTime}:00`;
      const endDate = e.end && e.end !== e.start ? e.end : e.start;
      const endIso = e.endTime ? `${endDate}T${e.endTime}:00` : undefined;
      return { id: 'ev-' + e.id, title: e.title, start: startIso, end: endIso, allDay: false, color };
    }
    // 종일 일정: FullCalendar의 end는 "포함되지 않는" 다음날 기준이므로, 여러 날짜에 걸친
    // 일정이면 사용자가 지정한 마지막 날짜에 +1일을 해줘야 화면에 마지막 날까지 막대가 표시된다.
    const isMultiDay = e.end && e.end !== e.start;
    return {
      id: 'ev-' + e.id,
      title: e.title,
      start: e.start,
      end: isMultiDay ? addDays(e.end, 1) : undefined,
      allDay: true,
      color
    };
  });
  const tds = state.todos.filter((t) => t.dueDate).map((t) => ({
    id: 'td-' + t.id,
    title: todoCalendarPrefix(t) + (t.channel ? '[' + t.channel + '] ' : '') + t.text,
    start: t.dueDate,
    allDay: true,
    color: todoIsDone(t) ? '#9698b8' : projectColor(t.projectId)
  }));
  const tks = state.tasks.filter((t) => t.dueDate).map((t) => ({
    id: 'tk-' + t.id,
    title: '📁 ' + t.title,
    start: t.dueDate,
    allDay: true,
    color: t.status === 'done' ? '#9698b8' : projectColor(t.projectId)
  }));
  return [...evs, ...tds, ...tks];
}

function refreshCalendarEvents() {
  if (calendar) calendar.refetchEvents();
}

/* ---------- 대시보드 ---------- */
function isIsoDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || ''); }

function dashItemHtml(t, showDue, overdue) {
  const proj = byId(state.projects, t.projectId);
  const pri = normalizePriority(t.priority);
  const priMark = pri === '긴급' ? '🔴 ' : pri === '중요' ? '🟠 ' : '';
  const check = t.needsCheck === 'Y' ? '⚠ ' : '';
  const channel = t.channel ? `<span class="di-channel">${escapeHtml(t.channel)}</span>` : '';
  return `<div class="dash-item ${overdue ? 'overdue' : ''}" data-todo="${t.id}">
    <span class="di-title">${priMark}${check}${escapeHtml(t.text)}</span>
    ${proj ? tagHtml(proj.name, proj.color) : ''}
    ${channel}
    <span class="di-due">${showDue ? escapeHtml(t.dueDate || '') : ''}</span>
  </div>`;
}

function dashCardHtml(icon, title, items, emptyMsg, showDue, overdue) {
  const body = items.length
    ? items.map((t) => dashItemHtml(t, showDue, overdue)).join('')
    : `<div class="dash-empty">${emptyMsg}</div>`;
  return `<div class="dash-card">
    <h3>${icon} ${title}<span class="count">${items.length}</span></h3>
    <div class="dash-list">${body}</div>
  </div>`;
}

// 마감 임박 알림 배너: 지연 · 오늘 마감 · 내일 마감 요약. 오늘 하루 닫기 가능.
function renderDashAlert(overdue, todayList, tomorrowList) {
  const el = document.getElementById('dashAlert');
  if (!el) return;
  const nOver = overdue.length, nToday = todayList.length, nTom = tomorrowList.length;
  const total = nOver + nToday + nTom;
  const today = todayStr();
  if (total === 0 || localStorage.getItem('dashAlertDismissed') === today) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const segs = [];
  if (nOver) segs.push(`<span class="da-seg da-over">지연 <b>${nOver}건</b></span>`);
  if (nToday) segs.push(`<span class="da-seg">오늘 마감 <b>${nToday}건</b></span>`);
  if (nTom) segs.push(`<span class="da-seg">내일 마감 <b>${nTom}건</b></span>`);
  const icon = nOver ? '🔴' : '🟠';
  el.className = 'dash-alert ' + (nOver ? 'danger' : 'warn');
  el.innerHTML =
    `<span class="da-icon">${icon}</span>` +
    `<span class="da-text">${segs.join('<span class="da-sep">·</span>')}</span>` +
    `<span class="da-cta">확인하기 →</span>` +
    `<button class="da-dismiss" title="오늘 하루 숨기기" aria-label="닫기">✕</button>`;
  el.onclick = () => document.querySelector('.nav-btn[data-view="todos"]').click();
  el.querySelector('.da-dismiss').onclick = (e) => {
    e.stopPropagation();
    localStorage.setItem('dashAlertDismissed', today);
    el.classList.add('hidden');
  };
}

function renderDashboard() {
  const grid = document.getElementById('dashboardGrid');
  const statRow = document.getElementById('statRow');
  if (!grid || !statRow) return;
  const today = todayStr();
  const weekEnd = addDays(today, 7);

  const openTodos = state.todos.filter((t) => !todoIsDone(t));
  const withDue = openTodos.filter((t) => isIsoDate(t.dueDate));
  const byDue = (a, b) => a.dueDate.localeCompare(b.dueDate);
  const tomorrow = addDays(today, 1);
  const overdue = withDue.filter((t) => t.dueDate < today).sort(byDue);
  const todayList = withDue.filter((t) => t.dueDate === today).sort(byDue);
  const tomorrowList = withDue.filter((t) => t.dueDate === tomorrow).sort(byDue);
  const week = withDue.filter((t) => t.dueDate > today && t.dueDate <= weekEnd).sort(byDue);
  const needsCheck = openTodos.filter((t) => t.needsCheck === 'Y').sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const todayEvents = state.events.filter((e) => {
    const s = (e.start || '').slice(0, 10);
    const en = (e.end || e.start || '').slice(0, 10);
    return s && s <= today && today <= (en || s);
  });

  document.getElementById('dashboardToday').textContent = `오늘 ${today}`;

  const stats = [
    { label: '지연', num: overdue.length, cls: 'accent-danger' },
    { label: '오늘', num: todayList.length + todayEvents.length, cls: 'accent-accent' },
    { label: '이번 주', num: week.length, cls: '' },
    { label: '점검 필요', num: needsCheck.length, cls: 'accent-warn' },
    { label: '미완료 전체', num: openTodos.length, cls: '' }
  ];
  statRow.innerHTML = stats.map((s) =>
    `<div class="stat-tile ${s.cls}" data-goto-todos="1"><div class="stat-num">${s.num}</div><div class="stat-label">${s.label}</div></div>`
  ).join('');
  statRow.querySelectorAll('[data-goto-todos]').forEach((el) => {
    el.addEventListener('click', () => document.querySelector('.nav-btn[data-view="todos"]').click());
  });

  renderDashAlert(overdue, todayList, tomorrowList);

  // 오늘 카드: 오늘 마감 할 일 + 오늘 일정
  const todayEventsHtml = todayEvents.map((e) => {
    const proj = byId(state.projects, e.projectId);
    return `<div class="dash-item" data-event="${e.id}">
      <span class="di-title">📆 ${escapeHtml(e.title)}</span>
      ${proj ? tagHtml(proj.name, proj.color) : ''}
      <span class="di-due">${e.allDay === false && e.startTime ? escapeHtml(e.startTime) : '종일'}</span>
    </div>`;
  }).join('');
  const todayBody = (todayList.length || todayEvents.length)
    ? todayList.map((t) => dashItemHtml(t, false, false)).join('') + todayEventsHtml
    : `<div class="dash-empty">오늘 예정된 할 일과 일정이 없어요.</div>`;
  const todayCard = `<div class="dash-card">
    <h3>📌 오늘<span class="count">${todayList.length + todayEvents.length}</span></h3>
    <div class="dash-list">${todayBody}</div>
  </div>`;

  grid.innerHTML =
    dashCardHtml('🔴', '지연된 업무', overdue, '지연된 업무가 없어요. 👍', true, true) +
    todayCard +
    dashCardHtml('🗓', '이번 주 (7일 이내)', week, '이번 주 마감 예정 업무가 없어요.', true, false) +
    dashCardHtml('⚠', '점검 필요', needsCheck, '점검이 필요한 업무가 없어요.', true, false);

  grid.querySelectorAll('[data-todo]').forEach((el) => {
    el.addEventListener('click', () => {
      const t = byId(state.todos, el.getAttribute('data-todo'));
      if (t) openTodoModal(t);
    });
  });
  grid.querySelectorAll('[data-event]').forEach((el) => {
    el.addEventListener('click', () => {
      const e = byId(state.events, el.getAttribute('data-event'));
      if (e) openEventModal(e);
    });
  });

  renderDashAnalytics();
}

// 대시보드 분석: 처리 지표 · 상태 분포 · 분류 Top(대/중/소 탭) · 추이 · 데이터 점검
/* 처리 지표 계산 — 순수 함수(테스트에서 추출해 검증한다).
   반환: 평균 완료 소요일 / 기한 준수율 / 이번 달 완료(전월 대비) / 현재 지연과 평균 지연일 */
function computeWorkStats(todos, today) {
  const isDone = (t) => { const s = t.status || (t.done ? '완료' : '대기'); return s === '완료' || s === '지연완료'; };
  const days = (from, to) => Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 864e5);
  const thisMonth = today.slice(0, 7);
  const prevMonth = (() => {
    const y = +today.slice(0, 4), m = +today.slice(5, 7) - 1; // 0-based
    const d = new Date(y, m - 1, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  })();

  const done = todos.filter(isDone);
  // 소요일: 등록일·완료일이 모두 있고 순서가 뒤집히지 않은 건만 (시트 유입 데이터에 역전 사례가 있다)
  const lead = done.filter((t) => t.registeredDate && t.completedDate && t.completedDate >= t.registeredDate)
    .map((t) => days(t.registeredDate, t.completedDate));
  const avgLead = lead.length ? lead.reduce((a, b) => a + b, 0) / lead.length : null;

  const withDue = done.filter((t) => t.dueDate && t.completedDate);
  const onTime = withDue.filter((t) => t.completedDate <= t.dueDate).length;
  const onTimeRate = withDue.length ? Math.round(onTime / withDue.length * 100) : null;

  const doneThisMonth = done.filter((t) => (t.completedDate || '').slice(0, 7) === thisMonth).length;
  const donePrevMonth = done.filter((t) => (t.completedDate || '').slice(0, 7) === prevMonth).length;

  const overdue = todos.filter((t) => !isDone(t) && t.dueDate && t.dueDate < today);
  const avgLate = overdue.length
    ? overdue.reduce((a, t) => a + days(t.dueDate, today), 0) / overdue.length
    : null;

  return {
    avgLead, onTimeRate, onTimeBase: withDue.length,
    doneThisMonth, donePrevMonth, monthDelta: doneThisMonth - donePrevMonth,
    overdueCount: overdue.length, avgLate
  };
}

/* 월별 추이 계산 — 순수 함수(테스트에서 추출해 검증한다).
   각 달의 등록/완료 건수와 **월말 기준 미완료 잔량(backlog)**을 함께 낸다.
   잔량 = 그 달 말까지 등록됐고 그 시점까지 완료되지 않은 건 → 밀리고 있는지 한눈에 보인다. */
function computeTrend(todos, today, months) {
  const isDone = (t) => { const s = t.status || (t.done ? '완료' : '대기'); return s === '완료' || s === '지연완료'; };
  const pad = (n) => String(n).padStart(2, '0');
  const y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
  const rows = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(y, m - i, 1);
    const key = d.getFullYear() + '-' + pad(d.getMonth() + 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const end = last.getFullYear() + '-' + pad(last.getMonth() + 1) + '-' + pad(last.getDate());
    const reg = todos.filter((t) => (t.registeredDate || '').slice(0, 7) === key).length;
    const comp = todos.filter((t) => isDone(t) && (t.completedDate || '').slice(0, 7) === key).length;
    const backlog = todos.filter((t) => {
      const r = t.registeredDate || '';
      if (!r || r > end) return false;            // 아직 등록 전
      if (!isDone(t)) return true;                // 지금도 미완료
      const c = t.completedDate || '';
      return !c || c > end;                       // 그 시점엔 아직 미완료였음
    }).length;
    rows.push({ key, label: (d.getMonth() + 1) + '월', reg, comp, backlog, delta: reg - comp, current: i === 0 });
  }
  const totalReg = rows.reduce((a, r) => a + r.reg, 0);
  const totalComp = rows.reduce((a, r) => a + r.comp, 0);
  return { rows, totalReg, totalComp, net: totalReg - totalComp };
}

/* 지표를 왜곡시키는 데이터 결함 찾기 — 순수 함수(테스트에서 추출해 검증한다).
   지표가 이상해 보일 때 "계산이 틀린 건지 데이터가 빈 건지"를 바로 구분하기 위한 것. */
function computeDataIssues(todos) {
  const isDone = (t) => { const s = t.status || (t.done ? '완료' : '대기'); return s === '완료' || s === '지연완료'; };
  const list = Array.isArray(todos) ? todos : [];
  // 완료인데 완료일이 없음 → 잔량에 영원히 남고, 소요일·준수율 분모에서도 빠진다
  const doneNoDate = list.filter((t) => isDone(t) && !t.completedDate);
  // 완료일이 등록일보다 빠름 → 소요일 계산에서 제외되는 모순 데이터
  const reversed = list.filter((t) => isDone(t) && t.completedDate && t.registeredDate && t.completedDate < t.registeredDate);
  // 완료일은 있는데 상태가 미완료 → 어느 쪽이 맞는지 확인 필요
  const dateButOpen = list.filter((t) => !isDone(t) && t.completedDate);
  // 미완료인데 마감일 없음 → 지연·마감 알림에서 통째로 빠진다
  const openNoDue = list.filter((t) => !isDone(t) && !t.dueDate);
  return {
    doneNoDate, reversed, dateButOpen, openNoDue,
    total: doneNoDate.length + reversed.length + dateButOpen.length + openNoDue.length
  };
}

const DATA_ISSUE_META = {
  doneNoDate: { icon: '📅', label: '완료인데 완료일 없음', why: '잔량에 계속 남고 평균 소요일·기한 준수율 계산에서 빠집니다.', fix: '시트의 <b>완료일</b> 열을 채워주세요.' },
  reversed: { icon: '↩', label: '완료일이 등록일보다 빠름', why: '소요일 계산에서 제외됩니다.', fix: '등록일 또는 완료일 중 잘못된 쪽을 고쳐주세요.' },
  dateButOpen: { icon: '❓', label: '완료일은 있는데 미완료 상태', why: '완료로 볼지 미완료로 볼지 판단할 수 없습니다.', fix: '진행상태를 <b>완료</b>로 바꾸거나 완료일을 비워주세요.' },
  openNoDue: { icon: '🔕', label: '미완료인데 마감일 없음', why: '지연 집계와 아침 알림에서 통째로 빠집니다.', fix: '시트의 <b>마감일</b> 열을 채워주세요.' }
};

/* 결함 항목 목록 모달 — 시트에서 고쳐야 하므로 복사해 갈 수 있게 한다. */
function openDataIssueModal(kind) {
  const meta = DATA_ISSUE_META[kind];
  const items = computeDataIssues(state.todos || [])[kind] || [];
  const esc = escapeHtml;
  const projName = (t) => { const p = byId(state.projects, t.projectId); return p ? p.name : ''; };
  const tag = (t) => '[' + [projName(t), t.channel].filter(Boolean).join('/') + ']';

  const plain = [`⚠ ${meta.label} (${items.length}건)`, '']
    .concat(items.map((t) => `- ${t.no ? '#' + t.no + ' ' : ''}${tag(t)} ${t.text} (등록 ${t.registeredDate || '-'} / 마감 ${t.dueDate || '-'} / 상태 ${todoStatus(t)}${t.completedDate ? ' / 완료 ' + t.completedDate : ''})`))
    .join('\n');

  const rows = items.map((t) => `<tr>
      <td>${t.no ? '#' + t.no : ''}</td>
      <td>${esc(t.text || '')}<div class="di-sub">${esc(tag(t))}</div></td>
      <td>${esc(t.registeredDate || '–')}</td>
      <td>${esc(t.dueDate || '–')}</td>
      <td>${esc(todoStatus(t))}</td>
      <td>${esc(t.completedDate || '–')}</td>
    </tr>`).join('');

  showModal({
    title: meta.icon + ' ' + meta.label,
    wide: true,
    saveLabel: '📋 복사',
    bodyHtml: `
      <div class="di-note">
        <b>왜 문제인가</b> ${esc(meta.why)}<br>
        <b>고치는 법</b> ${meta.fix}
        <div class="di-warn">⚠ 시트에서 가져온 업무는 <b>앱에서 고쳐도 다음 동기화 때 시트 값으로 되돌아갑니다.</b> 구글 시트에서 고쳐주세요.</div>
      </div>
      <div class="di-tablewrap"><table class="di-table">
        <thead><tr><th>No</th><th>업무</th><th>등록일</th><th>마감일</th><th>상태</th><th>완료일</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6">해당 없음</td></tr>'}</tbody>
      </table></div>`,
    onSave: () => {
      navigator.clipboard.writeText(plain).then(() => toast('목록을 복사했어요')).catch(() => toast('복사 실패'));
      return false; // 모달 유지
    }
  });
}

/* 추이 기간(개월). 카드 안 토글로 바꾸며 기기별로 기억한다. */
let trendMonths = (() => {
  const v = parseInt(localStorage.getItem('trendMonths') || '6', 10);
  return v === 12 ? 12 : 6;
})();

/* 분류 Top 카드에서 지금 보고 있는 축. 기기별로 기억한다. */
let taxoTab = (() => {
  const v = localStorage.getItem('dashTaxoTab');
  return (v === 'proj' || v === 'mid' || v === 'sub') ? v : 'mid';
})();

/* 대·중·소 세 축을 같은 방식으로 다루기 위한 정의.
   pick = 할 일에서 그 축의 이름 꺼내기, color = 막대 색. 색은 앱 다른 곳(칩·칸반)과 같은 규칙을 쓴다. */
const TAXO_AXES = [
  { key: 'proj', label: '대분류',
    pick: (t) => { const p = byId(state.projects, t.projectId); return p ? p.name : ''; },
    color: (name) => { const p = (state.projects || []).find((x) => x.name === name); return (p && p.color) || '#1a73e8'; } },
  { key: 'mid', label: '중분류', pick: (t) => t.channel || '', color: channelColor },
  { key: 'sub', label: '소분류', pick: (t) => t.subChannel || '', color: channelColor }
];

/* 한 축의 분류별 집계 — 순수 함수(테스트에서 추출해 검증한다).
   이름이 빈 건은 name:'' 한 줄로 모아 "(미지정)"으로 보여주고, 정렬에서는 항상 맨 아래로 내린다.
   정렬 기준은 "지금 남은 일이 많은 순" — 완료된 과거보다 남은 일이 먼저 눈에 들어와야 한다. */
/* 분류 Top 한 줄 그리기 — 막대는 2중이다.
   바깥(i) 길이 = 전체 건수 / 최댓값  → 이 분류가 얼마나 큰 덩어리인지
   안쪽(b) 길이 = 완료 / 전체        → 그중 얼마나 처리했는지
   한 줄에서 "양"과 "진행"을 같이 읽게 하려는 것. 순수 함수라 테스트에서 마크업까지 본다. */
function taxoRowHtml(r, color, maxTotal) {
  const named = !!r.name;
  const pct = r.total ? Math.round(r.done / r.total * 100) : 0;
  const w = Math.round(r.total / Math.max(1, maxTotal) * 100);
  const tip = (named ? r.name : '미지정') + ` · 전체 ${r.total}건 · 남음 ${r.open}건 · 완료 ${pct}%`;
  return `<div class="an-row${named ? '' : ' an-row-none'}" title="${escapeHtml(tip)}">
    <span class="an-label">${named ? escapeHtml(r.name) : '(미지정)'}</span>
    <span class="an-bar"><i style="width:${w}%;background:color-mix(in srgb, ${color} 22%, transparent)"><b style="width:${pct}%;background:${color}"></b></i></span>
    <span class="an-val an-val-wide"><b>${r.open}</b> 남음 <span class="an-sub">/ ${r.total} · ${pct}%</span></span>
  </div>`;
}

function computeTaxoTop(todos, pick, isDone, limit) {
  const map = new Map();
  (Array.isArray(todos) ? todos : []).forEach((t) => {
    const name = ((pick(t) || '') + '').trim();
    let e = map.get(name);
    if (!e) { e = { name: name, total: 0, done: 0, open: 0 }; map.set(name, e); }
    e.total++;
    if (isDone(t)) e.done++; else e.open++;
  });
  const rows = Array.from(map.values());
  rows.sort((a, b) => {
    if (!a.name !== !b.name) return a.name ? -1 : 1;   // (미지정)은 항상 맨 아래
    if (b.open !== a.open) return b.open - a.open;
    return b.total - a.total;
  });
  return limit ? rows.slice(0, limit) : rows;
}

function renderDashAnalytics() {
  const box = document.getElementById('dashAnalytics');
  if (!box) return;
  const sec = document.getElementById('dashAnalyticsSec');
  const todos = state.todos || [];
  if (!todos.length) { box.innerHTML = ''; if (sec) sec.hidden = true; return; }
  if (sec) sec.hidden = false;

  // 1) 상태 분포
  const statusOrder = ['대기', '진행중', '완료', '지연완료', '보류'];
  const statusCount = {};
  todos.forEach((t) => { const s = todoStatus(t); statusCount[s] = (statusCount[s] || 0) + 1; });
  const statuses = statusOrder.filter((s) => statusCount[s]);
  Object.keys(statusCount).forEach((s) => { if (!statuses.includes(s)) statuses.push(s); });
  const total = todos.length;
  const stackSeg = statuses.map((s) => {
    const c = statusCount[s]; const col = TODO_STATUS_COLORS[s] || '#9b9a97';
    return `<div class="an-stack-seg" style="width:${(c / total * 100).toFixed(1)}%;background:${col}" title="${escapeHtml(s)} ${c}건"></div>`;
  }).join('');
  const legend = statuses.map((s) => {
    const col = TODO_STATUS_COLORS[s] || '#9b9a97';
    return `<span class="an-legend"><i style="background:${col}"></i>${escapeHtml(s)} <b>${statusCount[s]}</b></span>`;
  }).join('');

  // 2) 분류 Top — 대·중·소를 카드 하나에서 탭으로 바꿔 본다.
  //    세 축 모두 같은 눈금: 막대 길이 = 전체 건수(최댓값 대비), 진한 부분 = 완료 비율.
  //    예전에는 대분류만 "진행률", 중분류만 "미완료 건수"라 서로 비교가 안 됐다.
  const axis = TAXO_AXES.filter((a) => a.key === taxoTab)[0] || TAXO_AXES[1];
  const taxoRows = computeTaxoTop(todos, axis.pick, todoIsDone, 8);
  const taxoMax = Math.max(1, ...taxoRows.map((r) => r.total));
  const taxoTabs = TAXO_AXES.map((a) =>
    `<button type="button" class="an-seg-btn${a.key === taxoTab ? ' on' : ''}" data-taxo="${a.key}">${a.label}</button>`
  ).join('');
  const taxoBody = taxoRows.map((r) => taxoRowHtml(r, r.name ? axis.color(r.name) : '#9b9a97', taxoMax)).join('');

  // 3) 월별 등록 vs 완료 추이 + 미완료 잔량선
  const tr = computeTrend(todos, todayStr(), trendMonths);
  const maxV = Math.max(1, ...tr.rows.map((r) => Math.max(r.reg, r.comp)));
  const maxB = Math.max(1, ...tr.rows.map((r) => r.backlog));
  const n = tr.rows.length;
  // 잔량선: 막대 영역과 같은 박스를 덮는 SVG(0~100 좌표). 막대와 척도가 다르므로 범례에 명시한다.
  const linePts = tr.rows.map((r, i) => {
    const x = ((i + 0.5) / n * 100).toFixed(2);
    const yv = (95 - r.backlog / maxB * 88).toFixed(2);
    return x + ',' + yv;
  }).join(' ');
  const trendCols = tr.rows.map((r) => {
    const tip = `${r.key} · 등록 ${r.reg}건 / 완료 ${r.comp}건 / 순증감 ${r.delta > 0 ? '+' : ''}${r.delta} · 월말 잔량 ${r.backlog}건`;
    return `<div class="an-mcol${r.current ? ' current' : ''}" title="${escapeHtml(tip)}">
      <div class="an-mbars">
        <div class="an-mbar reg" style="height:${Math.round(r.reg / maxV * 100)}%"><span>${r.reg || ''}</span></div>
        <div class="an-mbar comp" style="height:${Math.round(r.comp / maxV * 100)}%"><span>${r.comp || ''}</span></div>
      </div>
    </div>`;
  }).join('');
  const trendAxis = tr.rows.map((r) => {
    const cls = r.delta > 0 ? 'up' : (r.delta < 0 ? 'down' : '');
    return `<div class="an-mcol">
      <div class="an-mlabel">${r.label}${r.current ? '<i>진행중</i>' : ''}</div>
      <div class="an-mdelta ${cls}">${r.delta > 0 ? '+' : ''}${r.delta}</div>
      <div class="an-mback">잔량 ${r.backlog}</div>
    </div>`;
  }).join('');

  // 4) 처리 지표 (평균 소요일 · 기한 준수율 · 이번 달 완료 · 지연)
  const st = computeWorkStats(todos, todayStr());
  const num = (v, unit) => (v == null ? '<span class="an-kpi-na">–</span>' : `${v}<small>${unit}</small>`);
  const deltaHtml = st.monthDelta === 0
    ? '<span class="an-kpi-sub">전월과 같음</span>'
    : `<span class="an-kpi-sub ${st.monthDelta > 0 ? 'up' : 'down'}">전월 대비 ${st.monthDelta > 0 ? '▲' : '▼'} ${Math.abs(st.monthDelta)}건</span>`;
  const kpiHtml = `
    <div class="an-kpi">
      <div class="an-kpi-item">
        <div class="an-kpi-v">${num(st.avgLead == null ? null : st.avgLead.toFixed(1), '일')}</div>
        <div class="an-kpi-k">평균 완료 소요일</div>
        <span class="an-kpi-sub">등록 → 완료</span>
      </div>
      <div class="an-kpi-item">
        <div class="an-kpi-v">${num(st.onTimeRate, '%')}</div>
        <div class="an-kpi-k">기한 준수율</div>
        <span class="an-kpi-sub">완료 ${st.onTimeBase}건 기준</span>
      </div>
      <div class="an-kpi-item">
        <div class="an-kpi-v">${st.doneThisMonth}<small>건</small></div>
        <div class="an-kpi-k">이번 달 완료</div>
        ${deltaHtml}
      </div>
      <div class="an-kpi-item">
        <div class="an-kpi-v ${st.overdueCount ? 'danger' : ''}">${st.overdueCount}<small>건</small></div>
        <div class="an-kpi-k">지연 중</div>
        <span class="an-kpi-sub">${st.avgLate == null ? '없음' : '평균 ' + st.avgLate.toFixed(1) + '일 경과'}</span>
      </div>
    </div>`;

  // 5) 데이터 점검 — 지표를 왜곡시키는 결함이 있을 때만 카드를 띄운다
  const issues = computeDataIssues(todos);
  const issueRows = Object.keys(DATA_ISSUE_META).filter((k) => issues[k].length).map((k) => {
    const m = DATA_ISSUE_META[k];
    return `<button type="button" class="di-row" data-issue="${k}">
      <span class="di-ic">${m.icon}</span>
      <span class="di-label">${escapeHtml(m.label)}</span>
      <span class="di-count">${issues[k].length}건</span>
      <span class="di-go">보기 ›</span>
    </button>`;
  }).join('');
  const issueCard = issues.total ? `
    <div class="an-card an-card-wide an-card-warn">
      <h3>⚠ 데이터 점검<span class="an-total">지표에 영향을 주는 항목 ${issues.total}건</span></h3>
      <div class="di-rows">${issueRows}</div>
    </div>` : '';

  box.innerHTML = issueCard + `
    <div class="an-card an-card-wide">
      <h3>처리 지표<span class="an-total">완료 ${todos.filter(todoIsDone).length}건 기준</span></h3>
      ${kpiHtml}
      ${issues.doneNoDate.length ? `<div class="an-note">완료일이 비어 있는 완료 ${issues.doneNoDate.length}건은 위 지표에서 빠져 있어요.</div>` : ''}
    </div>
    <div class="an-card">
      <h3>진행 상태 분포<span class="an-total">전체 ${total}건</span></h3>
      <div class="an-stack">${stackSeg}</div>
      <div class="an-legend-row">${legend}</div>
    </div>
    <div class="an-card an-card-2">
      <h3>분류 Top
        <span class="an-seg an-seg-inline">${taxoTabs}</span>
        <span class="an-total">막대 = 전체 건수 · 진한 부분 = 완료</span>
      </h3>
      ${taxoBody || '<div class="dash-empty">데이터 없음</div>'}
    </div>
    <div class="an-card an-card-wide">
      <h3>최근 ${trendMonths}개월 추이
        <span class="an-seg">
          <button type="button" class="an-seg-btn${trendMonths === 6 ? ' on' : ''}" data-months="6">6개월</button>
          <button type="button" class="an-seg-btn${trendMonths === 12 ? ' on' : ''}" data-months="12">12개월</button>
        </span>
        <span class="an-legend-row" style="margin:0 0 0 12px">
          <span class="an-legend"><i style="background:#9b9a97"></i>등록</span>
          <span class="an-legend"><i style="background:#0b8043"></i>완료</span>
          <span class="an-legend"><i class="line"></i>미완료 잔량<span class="an-sub"> (별도 척도)</span></span>
        </span>
      </h3>
      <div class="an-trend-sum">
        ${trendMonths}개월간 등록 <b>${tr.totalReg}</b>건 · 완료 <b>${tr.totalComp}</b>건 ·
        <b class="${tr.net > 0 ? 'up' : (tr.net < 0 ? 'down' : '')}">순증감 ${tr.net > 0 ? '+' : ''}${tr.net}건</b>
        ${tr.net > 0 ? '<span class="an-sub">— 처리보다 유입이 많아요</span>' : (tr.net < 0 ? '<span class="an-sub">— 밀린 일을 줄이고 있어요</span>' : '')}
      </div>
      <div class="an-plot">
        <svg class="an-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polyline points="${linePts}" fill="none" stroke="#e37400" stroke-width="1.6"
                    stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="an-cols">${trendCols}</div>
      </div>
      <div class="an-xaxis">${trendAxis}</div>
    </div>`;

  box.querySelectorAll('[data-issue]').forEach((b) => {
    b.onclick = () => openDataIssueModal(b.dataset.issue);
  });

  // 분류 축 전환 — 기기별로 기억하고 이 카드만 다시 그린다
  box.querySelectorAll('[data-taxo]').forEach((b) => {
    b.onclick = () => {
      taxoTab = b.dataset.taxo;
      try { localStorage.setItem('dashTaxoTab', taxoTab); } catch (e) {}
      renderDashAnalytics();
    };
  });

  // 기간 토글 — 기기별로 기억하고 이 카드만 다시 그린다
  box.querySelectorAll('.an-seg-btn').forEach((b) => {
    b.onclick = () => {
      trendMonths = parseInt(b.dataset.months, 10) === 12 ? 12 : 6;
      try { localStorage.setItem('trendMonths', String(trendMonths)); } catch (e) {}
      renderDashAnalytics();
    };
  });
}

/* ---------- 프로젝트 select 옵션 생성 ---------- */
function projectOptionsHtml(selectedId) {
  return state.projects.map((p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
}

/* 할 일들에 실제로 쓰인 중분류를 중복 없이 등장순으로 수집 (마스터 목록 최초 시드에 사용) */
function uniqueChannels(todos) {
  const seen = [];
  (Array.isArray(todos) ? todos : []).forEach((t) => {
    const c = ((t && t.channel) || '').trim();
    if (c && !seen.includes(c)) seen.push(c);
  });
  return seen;
}

/* ---------- 분류 체계: 대분류 > 중분류 > 소분류 ----------
   내부 필드명은 옛 이름을 그대로 쓴다(데이터 이전 없이 화면 용어만 바꾼 것):
     대분류 = todo.projectId  → state.projects   (칸반·캘린더 색상과 공유)
     중분류 = todo.channel    → state.channels[]
     소분류 = todo.subChannel → state.subMaster[]
   ⚠️ 셋은 **서로 독립된 축**이다(2026-07-29 재설계). 한 거래처(중분류)에 정산 업무도
   영업 업무도 있기 때문에 중분류를 대분류 하나에 묶으면 실제 업무를 표현할 수 없다.
   어떤 조합이든 자유롭게 쓸 수 있고, 목록 필터는 세 축을 AND로 겹쳐서 건다. */

// 저장 구조가 없으면 만들어 준다. 여러 곳에서 먼저 호출해도 안전하도록 항상 이걸 거친다.
function taxoInit(st) {
  const s = st || state;
  if (!Array.isArray(s.channels)) s.channels = [];
  if (!Array.isArray(s.subMaster)) s.subMaster = [];
  return s;
}

/* 할 일에 쓰인 값을 각 마스터 목록에 편입한다(앱이 켜질 때와 데이터를 다시 불러올 때마다).
   순수 함수로 유지할 것 — state 전역을 참조하지 말고 인자로 받은 것만 고친다(테스트에서 직접 호출).
   ⚠️ 세 축은 서로 독립이므로 여기서 소속·연결을 만들지 않는다. 목록을 모으기만 한다. */
function migrateTaxonomy(st) {
  const s = taxoInit(st);
  const todos = Array.isArray(s.todos) ? s.todos : [];

  // 옛 종속 구조(중분류별 소분류 연결)가 남아 있으면 공용 목록으로 흡수하고 버린다
  if (s.subChannels && typeof s.subChannels === 'object') {
    Object.keys(s.subChannels).forEach((mid) => {
      (Array.isArray(s.subChannels[mid]) ? s.subChannels[mid] : []).forEach((sub) => {
        if (sub && !s.subMaster.includes(sub)) s.subMaster.push(sub);
      });
    });
    delete s.subChannels;
  }
  delete s.channelProjects;   // 중분류를 대분류에 묶던 정보 — 독립 축이 되며 의미가 없어졌다

  todos.forEach((t) => {
    const mid = ((t && t.channel) || '').trim();
    if (mid && !s.channels.includes(mid)) s.channels.push(mid);
    const sub = ((t && t.subChannel) || '').trim();
    if (sub && !s.subMaster.includes(sub)) s.subMaster.push(sub);
  });
  return s;
}

// 중분류 전체 목록 (대분류와 무관 — 한 거래처에 정산·영업 업무가 모두 있을 수 있다)
function midList() {
  taxoInit();
  return state.channels.slice();
}

// 소분류 전체 목록
function subList() {
  taxoInit();
  return state.subMaster.slice();
}

// 중분류 등록
function addMid(mid) {
  taxoInit();
  const v = (mid || '').trim();
  if (v && !state.channels.includes(v)) state.channels.push(v);
}

// 소분류 등록
function addSub(sub) {
  taxoInit();
  const v = (sub || '').trim();
  if (v && !state.subMaster.includes(v)) state.subMaster.push(v);
}

/* 중분류 자동완성 옵션 */
function channelOptionsHtml() {
  taxoInit();
  return state.channels.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
}

/* 소분류 자동완성 옵션 */
function subOptionsHtml() {
  taxoInit();
  return state.subMaster.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');
}

/* ---------- 일정 모달 ---------- */
/* 남의 캘린더에서 읽기 전용으로 가져온 일정 — 앱에서 고치면 다음 동기화에 덮이므로 보기만 한다 */
function openReadOnlyEventModal(ev) {
  const when = ev.allDay !== false
    ? (ev.start + (ev.end && ev.end !== ev.start ? ' ~ ' + ev.end : '') + ' (종일)')
    : (ev.start + ' ' + (ev.startTime || '') + (ev.endTime ? ' ~ ' + ev.endTime : ''));
  showModal({
    title: '구글 캘린더 일정 (읽기 전용)',
    saveLabel: '닫기',
    bodyHtml: `
      <div class="field"><label>제목</label><div class="ro-view">${escapeHtml(ev.title || '')}</div></div>
      <div class="field"><label>일시</label><div class="ro-view">${escapeHtml(when)}</div></div>
      ${ev.roCalName ? `<div class="field"><label>캘린더</label><div class="ro-view">${escapeHtml(ev.roCalName)}</div></div>` : ''}
      ${ev.notes ? `<div class="field"><label>메모</label><div class="ro-view">${escapeHtml(ev.notes)}</div></div>` : ''}
      <p class="hint" style="margin:0">가져오기만 하는 일정이라 여기서는 고칠 수 없어요. 내용을 바꾸려면 <b>구글 캘린더</b>에서 수정하세요 — 다음 동기화 때 반영됩니다.</p>`,
    onSave: () => true
  });
}

function openEventModal(ev, dateStr) {
  if (ev && ev.roCal) { openReadOnlyEventModal(ev); return; }
  const isNew = !ev;
  const data = ev || { id: null, title: '', start: dateStr || todayStr(), end: '', allDay: true, startTime: '', endTime: '', projectId: state.projects[0].id, color: '', notes: '' };
  const isAllDay = data.allDay !== false; // 기존 데이터 호환: allDay가 명시적으로 false가 아니면 종일로 취급

  showModal({
    title: isNew ? '새 일정' : '일정 수정',
    deletable: !isNew,
    bodyHtml: `
      <div class="field"><label>제목</label><input type="text" id="f-title" value="${escapeHtml(data.title)}" placeholder="일정 제목" /></div>
      <div class="field field-checkbox">
        <label><input type="checkbox" id="f-allday" ${isAllDay ? 'checked' : ''} /> 종일</label>
      </div>
      <div class="field-row">
        <div class="field"><label>시작일</label><input type="date" id="f-start" value="${(data.start || '').slice(0, 10)}" /></div>
        <div class="field"><label>종료일(선택)</label><input type="date" id="f-end" value="${(data.end || '').slice(0, 10)}" /></div>
      </div>
      <div class="field-row" id="f-time-row">
        <div class="field"><label>시작 시간</label><input type="time" id="f-start-time" value="${data.startTime || ''}" /></div>
        <div class="field"><label>종료 시간(선택)</label><input type="time" id="f-end-time" value="${data.endTime || ''}" /></div>
      </div>
      <div class="field"><label>프로젝트</label><select id="f-project">${projectOptionsHtml(data.projectId)}</select></div>
      ${isNew ? `
      <div class="field-row">
        <div class="field"><label>반복</label><select id="f-recur">
          <option value="none">없음</option>
          <option value="daily">매일</option>
          <option value="weekly">매주</option>
          <option value="biweekly">2주마다</option>
          <option value="monthly">매월</option>
        </select></div>
        <div class="field hidden" id="f-recur-until-wrap"><label>반복 종료일</label><input type="date" id="f-recur-until" /></div>
      </div>` : (data.recurGroup ? '<div class="field"><span class="hint">🔁 반복 일정 중 하나입니다. 삭제 시 전체/개별 선택 가능.</span></div>' : '')}
      <div class="field"><label>색상</label><div class="color-picker-row" id="f-color-row"></div></div>
      <div class="field"><label>메모</label><textarea id="f-notes" placeholder="메모(선택)">${escapeHtml(data.notes || '')}</textarea></div>
    `,
    onOpen: () => {
      buildColorRow('f-color-row', data.color || projectColor(data.projectId));
      const allDayCb = document.getElementById('f-allday');
      const timeRow = document.getElementById('f-time-row');
      const syncTimeRowVisibility = () => timeRow.classList.toggle('hidden', allDayCb.checked);
      syncTimeRowVisibility();
      allDayCb.addEventListener('change', syncTimeRowVisibility);
      const recur = document.getElementById('f-recur');
      if (recur) {
        const untilWrap = document.getElementById('f-recur-until-wrap');
        const syncRecur = () => untilWrap.classList.toggle('hidden', recur.value === 'none');
        syncRecur();
        recur.addEventListener('change', syncRecur);
      }
    },
    onSave: () => {
      const title = document.getElementById('f-title').value.trim();
      if (!title) { toast('제목을 입력해주세요'); return false; }
      const start = document.getElementById('f-start').value || todayStr();
      const end = document.getElementById('f-end').value;
      const allDay = document.getElementById('f-allday').checked;
      const startTime = allDay ? '' : document.getElementById('f-start-time').value;
      const endTime = allDay ? '' : document.getElementById('f-end-time').value;
      const projectId = document.getElementById('f-project').value;
      const color = getSelectedColor('f-color-row');
      const notes = document.getElementById('f-notes').value;
      const recur = isNew ? (document.getElementById('f-recur') ? document.getElementById('f-recur').value : 'none') : 'none';
      if (isNew && recur !== 'none') {
        const until = document.getElementById('f-recur-until').value;
        const dates = generateRecurrence(start, recur, until);
        const durDays = end ? Math.round((new Date(end) - new Date(start)) / 864e5) : 0;
        const group = 'rg' + uid();
        dates.forEach((s) => {
          state.events.push({ id: uid(), title, start: s, end: durDays > 0 ? addDays(s, durDays) : '', allDay, startTime, endTime, projectId, color, notes, recurGroup: group });
        });
        persist(); refreshCalendarEvents();
        toast(`반복 일정 ${dates.length}개를 추가했어요`);
        return true;
      }
      if (isNew) {
        state.events.push({ id: uid(), title, start, end, allDay, startTime, endTime, projectId, color, notes });
      } else {
        Object.assign(ev, { title, start, end, allDay, startTime, endTime, projectId, color, notes });
      }
      persist(); refreshCalendarEvents();
      return true;
    },
    onDelete: () => {
      if (ev.recurGroup) {
        const cnt = state.events.filter((e) => e.recurGroup === ev.recurGroup).length;
        if (cnt > 1 && confirm(`반복 일정입니다. 전체 ${cnt}개를 삭제할까요?\n(확인=전체 삭제 / 취소=이 일정 1개만 삭제)`)) {
          state.events = state.events.filter((e) => e.recurGroup !== ev.recurGroup);
          toast(`반복 일정 ${cnt}개를 삭제했어요`);
        } else {
          state.events = state.events.filter((e) => e.id !== ev.id);
        }
      } else {
        state.events = state.events.filter((e) => e.id !== ev.id);
      }
      persist(); refreshCalendarEvents();
    }
  });
}

// 반복 일정: 시작일 기준 k번째 인스턴스 날짜(YYYY-MM-DD). 월별은 말일 클램프로 드리프트 방지.
function recurStep(startStr, recur, k) {
  const [y, m, d] = startStr.split('-').map(Number);
  if (recur === 'daily') return addDays(startStr, k);
  if (recur === 'weekly') return addDays(startStr, 7 * k);
  if (recur === 'biweekly') return addDays(startStr, 14 * k);
  if (recur === 'monthly') {
    const dt = new Date(y, (m - 1) + k, 1);
    const dim = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(d, dim));
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  }
  return startStr;
}
function generateRecurrence(startStr, recur, untilStr) {
  const out = [];
  const until = untilStr || addDays(startStr, 90); // 종료일 미지정 시 기본 3개월
  for (let k = 0; k < 200; k++) { const s = recurStep(startStr, recur, k); if (s > until) break; out.push(s); }
  return out;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// "YYYY-MM-DD" 문자열에 n일을 더한 "YYYY-MM-DD"를 돌려준다 (로컬 날짜 구성요소 기반이라 타임존 시프트 버그가 없다).
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, (d || 1) + n);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

function buildColorRow(rowId, selected) {
  const row = document.getElementById(rowId);
  row.innerHTML = '';
  PALETTE.forEach((c) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (c === selected ? ' active' : '');
    s.style.background = c;
    s.dataset.color = c;
    s.onclick = () => {
      row.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      s.classList.add('active');
    };
    row.appendChild(s);
  });
  if (!row.querySelector('.swatch.active') && row.firstChild) row.firstChild.classList.add('active');
}

function getSelectedColor(rowId) {
  const active = document.querySelector('#' + rowId + ' .swatch.active');
  return active ? active.dataset.color : PALETTE[0];
}

/* ---------- 할 일 (구글시트 업무 트래커 양식의 테이블 뷰) ---------- */
function setupTodos() {
  document.getElementById('addTodoBtn').onclick = () => openTodoModal(null);
  const reset = () => { todoPage = 1; renderTodos(); };
  // 세 분류 필터는 서로 독립이며 AND로 겹쳐서 걸린다
  ['todoProjectFilter', 'todoMidFilter', 'todoSubFilter'].forEach((id) => {
    document.getElementById(id).addEventListener('change', reset);
  });
  document.getElementById('todoSearch').addEventListener('input', reset);
  document.getElementById('todoPageSize').addEventListener('change', reset);
  ['todoDateField', 'todoDateFrom', 'todoDateTo', 'todoHideDone'].forEach((id) => {
    document.getElementById(id).addEventListener('change', reset);
  });
  document.getElementById('todoDateClear').addEventListener('click', () => {
    document.getElementById('todoDateFrom').value = '';
    document.getElementById('todoDateTo').value = '';
    reset();
  });
  document.querySelectorAll('#todoQuickView .segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#todoQuickView .segmented-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      reset();
    });
  });
  document.querySelectorAll('#todoLayout .segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTodoLayout(btn.dataset.layout));
  });
  document.querySelectorAll('.todo-table thead th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (todoSort.key === key) todoSort.dir *= -1;
      else { todoSort.key = key; todoSort.dir = 1; }
      todoPage = 1; renderTodos();
    });
  });
  const exportBtn = document.getElementById('todoExportBtn');
  if (exportBtn) exportBtn.onclick = exportTodosCsv;
  const reportBtn = document.getElementById('weeklyReportBtn');
  if (reportBtn) reportBtn.onclick = openWeeklyReport;
  const monthlyBtn = document.getElementById('monthlyReportBtn');
  if (monthlyBtn) monthlyBtn.onclick = openMonthlyReport;
}

function weekRange(baseStr, weekOffset) {
  const d = new Date(baseStr + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 월=0
  const mon = new Date(d); mon.setDate(d.getDate() - dow + (weekOffset || 0) * 7);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const fmt = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  return { start: fmt(mon), end: fmt(sun) };
}

// 주간 리포트: 이번 주 완료 · 다음 주 마감 예정 · 지연. 복사/다운로드 가능.
function openWeeklyReport() {
  const today = todayStr();
  const tw = weekRange(today, 0);
  const nw = weekRange(today, 1);
  const projName = (t) => { const p = byId(state.projects, t.projectId); return p ? p.name : ''; };
  const tag = (t) => '[' + [projName(t), t.channel].filter(Boolean).join('/') + ']';
  const md = (d) => d ? d.slice(5).replace('-', '/') : '';
  const daysLate = (d) => Math.round((new Date(today) - new Date(d)) / 864e5);

  const doneThis = state.todos.filter((t) => todoIsDone(t) && t.completedDate && t.completedDate >= tw.start && t.completedDate <= tw.end)
    .sort((a, b) => (a.completedDate).localeCompare(b.completedDate));
  const dueNext = state.todos.filter((t) => !todoIsDone(t) && t.dueDate && t.dueDate >= nw.start && t.dueDate <= nw.end)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const overdue = state.todos.filter((t) => !todoIsDone(t) && t.dueDate && t.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // 평문(복사/다운로드용)
  const P = [];
  P.push(`📋 주간 리포트 (${tw.start} ~ ${tw.end})`);
  P.push('');
  P.push(`■ 이번 주 완료 (${doneThis.length}건)`);
  doneThis.forEach((t) => P.push(`- ${tag(t)} ${t.text}${t.assignee ? ' — ' + t.assignee : ''} (완료 ${md(t.completedDate)})`));
  if (!doneThis.length) P.push('- (없음)');
  P.push('');
  P.push(`■ 다음 주 마감 예정 (${dueNext.length}건)`);
  dueNext.forEach((t) => P.push(`- ${tag(t)} ${t.text} — ${md(t.dueDate)} 마감 (${todoStatus(t)})`));
  if (!dueNext.length) P.push('- (없음)');
  P.push('');
  P.push(`■ 지연 (${overdue.length}건)`);
  overdue.forEach((t) => P.push(`- ${tag(t)} ${t.text} — ${md(t.dueDate)} 마감 (${daysLate(t.dueDate)}일 지연)`));
  if (!overdue.length) P.push('- (없음)');
  const plain = P.join('\n');

  // HTML(모달 표시용)
  const sec = (title, items, lineFn, color) =>
    `<div class="rep-sec"><h4 style="color:${color}">${title} <span>${items.length}건</span></h4>` +
    (items.length ? '<ul>' + items.map((t) => `<li>${lineFn(t)}</li>`).join('') + '</ul>' : '<div class="rep-empty">없음</div>') + '</div>';
  const esc = escapeHtml;
  const html =
    `<div class="rep-range">${tw.start} ~ ${tw.end}</div>` +
    sec('✅ 이번 주 완료', doneThis, (t) => `<b>${esc(tag(t))}</b> ${esc(t.text)}${t.assignee ? ' — ' + esc(t.assignee) : ''} <span class="rep-meta">완료 ${md(t.completedDate)}</span>`, '#0b8043') +
    sec('🗓 다음 주 마감 예정', dueNext, (t) => `<b>${esc(tag(t))}</b> ${esc(t.text)} <span class="rep-meta">${md(t.dueDate)} 마감 · ${esc(todoStatus(t))}</span>`, '#1a73e8') +
    sec('🔴 지연', overdue, (t) => `<b>${esc(tag(t))}</b> ${esc(t.text)} <span class="rep-meta" style="color:var(--danger)">${md(t.dueDate)} 마감 · ${daysLate(t.dueDate)}일 지연</span>`, '#d93025') +
    `<div style="margin-top:6px"><button type="button" class="btn" id="reportDownloadBtn">⬇ 텍스트로 저장</button></div>`;

  showModal({
    title: '주간 리포트',
    wide: true,
    saveLabel: '📋 복사',
    bodyHtml: html,
    onOpen: () => {
      const dl = document.getElementById('reportDownloadBtn');
      if (dl) dl.onclick = () => {
        const blob = new Blob(['﻿' + plain], { type: 'text/plain;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'SCLM_주간리포트_' + today + '.txt';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    },
    onSave: () => {
      navigator.clipboard.writeText(plain).then(() => toast('리포트를 복사했어요')).catch(() => toast('복사 실패 — 텍스트 저장을 이용하세요'));
      return false; // 모달 유지
    }
  });
}

// 'YYYY-MM-DD' 기준 monthOffset 달의 1일~말일
function monthRange(baseStr, monthOffset) {
  const y = +baseStr.slice(0, 4), m = +baseStr.slice(5, 7) - 1;
  const first = new Date(y, m + (monthOffset || 0), 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const fmt = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  return { start: fmt(first), end: fmt(last), label: first.getFullYear() + '년 ' + (first.getMonth() + 1) + '월' };
}

// 월간 리포트: 이번 달 완료 · 이번 달 마감인데 미완료 · 다음 달 예정 + 처리 지표·대분류 요약.
function openMonthlyReport() {
  const today = todayStr();
  const tm = monthRange(today, 0);
  const nm = monthRange(today, 1);
  const projName = (t) => { const p = byId(state.projects, t.projectId); return p ? p.name : ''; };
  const tag = (t) => '[' + [projName(t), t.channel].filter(Boolean).join('/') + ']';
  const md = (d) => d ? d.slice(5).replace('-', '/') : '';
  const daysLate = (d) => Math.round((new Date(today) - new Date(d)) / 864e5);
  const st = computeWorkStats(state.todos || [], today);

  const doneThis = state.todos.filter((t) => todoIsDone(t) && t.completedDate && t.completedDate >= tm.start && t.completedDate <= tm.end)
    .sort((a, b) => a.completedDate.localeCompare(b.completedDate));
  const openThis = state.todos.filter((t) => !todoIsDone(t) && t.dueDate && t.dueDate >= tm.start && t.dueDate <= tm.end)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const dueNext = state.todos.filter((t) => !todoIsDone(t) && t.dueDate && t.dueDate >= nm.start && t.dueDate <= nm.end)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // 대분류별: 이번 달 완료 / 이번 달 마감 전체
  const projSummary = state.projects.map((p) => {
    const d = doneThis.filter((t) => t.projectId === p.id).length;
    const o = openThis.filter((t) => t.projectId === p.id).length;
    return (d || o) ? { name: p.name, done: d, open: o, color: p.color || 'var(--accent)' } : null;
  }).filter(Boolean);

  const kpiLine = `평균 완료 소요 ${st.avgLead == null ? '–' : st.avgLead.toFixed(1) + '일'}`
    + ` · 기한 준수율 ${st.onTimeRate == null ? '–' : st.onTimeRate + '%'}`
    + ` · 지연 ${st.overdueCount}건`;

  // 평문(복사/다운로드용)
  const P = [];
  P.push(`📅 월간 리포트 — ${tm.label} (${tm.start} ~ ${tm.end})`);
  P.push(kpiLine);
  P.push('');
  P.push(`■ 이번 달 완료 (${doneThis.length}건)`);
  doneThis.forEach((t) => P.push(`- ${tag(t)} ${t.text}${t.assignee ? ' — ' + t.assignee : ''} (완료 ${md(t.completedDate)})`));
  if (!doneThis.length) P.push('- (없음)');
  P.push('');
  P.push(`■ 이번 달 마감인데 미완료 (${openThis.length}건)`);
  openThis.forEach((t) => P.push(`- ${tag(t)} ${t.text} — ${md(t.dueDate)} 마감 (${todoStatus(t)}${t.dueDate < today ? ', ' + daysLate(t.dueDate) + '일 지연' : ''})`));
  if (!openThis.length) P.push('- (없음)');
  P.push('');
  P.push(`■ 다음 달 마감 예정 (${dueNext.length}건)`);
  dueNext.forEach((t) => P.push(`- ${tag(t)} ${t.text} — ${md(t.dueDate)} 마감`));
  if (!dueNext.length) P.push('- (없음)');
  if (projSummary.length) {
    P.push('');
    P.push('■ 대분류별');
    projSummary.forEach((s) => P.push(`- ${s.name}: 완료 ${s.done}건 / 미완료 ${s.open}건`));
  }
  const plain = P.join('\n');

  // HTML(모달 표시용)
  const esc = escapeHtml;
  const sec = (title, items, lineFn, color) =>
    `<div class="rep-sec"><h4 style="color:${color}">${title} <span>${items.length}건</span></h4>` +
    (items.length ? '<ul>' + items.map((t) => `<li>${lineFn(t)}</li>`).join('') + '</ul>' : '<div class="rep-empty">없음</div>') + '</div>';
  const projHtml = projSummary.length ? `<div class="rep-sec"><h4>📊 대분류별</h4>${projSummary.map((s) => {
    const tot = s.done + s.open;
    return `<div class="an-row">
      <span class="an-label" title="${esc(s.name)}">${esc(s.name)}</span>
      <span class="an-bar"><i style="width:${tot ? Math.round(s.done / tot * 100) : 0}%;background:${s.color}"></i></span>
      <span class="an-val">완료 ${s.done} / 미완료 ${s.open}</span>
    </div>`;
  }).join('')}</div>` : '';

  const html =
    `<div class="rep-range">${tm.label} · ${tm.start} ~ ${tm.end}</div>` +
    `<div class="rep-kpi">${esc(kpiLine)}</div>` +
    sec('✅ 이번 달 완료', doneThis, (t) => `<b>${esc(tag(t))}</b> ${esc(t.text)}${t.assignee ? ' — ' + esc(t.assignee) : ''} <span class="rep-meta">완료 ${md(t.completedDate)}</span>`, '#0b8043') +
    sec('🟡 이번 달 마감 · 미완료', openThis, (t) => `<b>${esc(tag(t))}</b> ${esc(t.text)} <span class="rep-meta"${t.dueDate < today ? ' style="color:var(--danger)"' : ''}>${md(t.dueDate)} 마감 · ${esc(todoStatus(t))}${t.dueDate < today ? ' · ' + daysLate(t.dueDate) + '일 지연' : ''}</span>`, '#e37400') +
    sec('🗓 다음 달 마감 예정', dueNext, (t) => `<b>${esc(tag(t))}</b> ${esc(t.text)} <span class="rep-meta">${md(t.dueDate)} 마감</span>`, '#1a73e8') +
    projHtml +
    `<div style="margin-top:6px"><button type="button" class="btn" id="reportDownloadBtn">⬇ 텍스트로 저장</button></div>`;

  showModal({
    title: '월간 리포트',
    wide: true,
    saveLabel: '📋 복사',
    bodyHtml: html,
    onOpen: () => {
      const dl = document.getElementById('reportDownloadBtn');
      if (dl) dl.onclick = () => {
        const blob = new Blob(['﻿' + plain], { type: 'text/plain;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'SCLM_월간리포트_' + tm.start.slice(0, 7) + '.txt';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
    },
    onSave: () => {
      navigator.clipboard.writeText(plain).then(() => toast('리포트를 복사했어요')).catch(() => toast('복사 실패 — 텍스트 저장을 이용하세요'));
      return false; // 모달 유지
    }
  });
}

// 현재 필터·정렬된 할 일 목록을 CSV(엑셀)로 내보내기. Excel 한글 깨짐 방지 BOM 포함.
function exportTodosCsv() {
  const items = filterTodos();
  const headers = ['No', '등록일', '대분류', '중분류', '소분류', '우선순위', '업무내용', '담당자', '마감일', '진행상태', '점검필요', '완료일', '진행사항', '비고', '산출물링크'];
  const esc = (v) => { const s = (v == null ? '' : String(v)); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = items.map((t) => {
    const proj = byId(state.projects, t.projectId);
    return [t.no || '', t.registeredDate || '', proj ? proj.name : '', t.channel || '', t.subChannel || '', t.priority || '',
      t.text || '', t.assignee || '', t.dueDate || '', todoStatus(t), t.needsCheck || '',
      t.completedDate || '', t.progress || '', t.remarks || '', todoLinks(t).join(' | ')].map(esc).join(',');
  });
  const csv = '﻿' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'SCLM_할일_' + todayStr() + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${items.length}건 내보냈어요`);
}

function updateSortIndicators() {
  document.querySelectorAll('.todo-table thead th.sortable').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === todoSort.key);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.remove();
    if (th.dataset.sort === todoSort.key) {
      const s = document.createElement('span');
      s.className = 'sort-arrow';
      s.textContent = todoSort.dir === 1 ? ' ▲' : ' ▼';
      th.appendChild(s);
    }
  });
}

/* 현재 필터(빠른보기·검색·대분류·기간)를 적용한 할 일 목록 (페이지네이션 전) */
function filterTodos() {
  const projVal = (document.getElementById('todoProjectFilter') || {}).value || 'all';
  const midVal = (document.getElementById('todoMidFilter') || {}).value || 'all';
  const subVal = (document.getElementById('todoSubFilter') || {}).value || 'all';
  const qv = (document.querySelector('#todoQuickView .segmented-btn.active') || {}).dataset;
  const quick = (qv && qv.qv) || 'all';
  const q = (document.getElementById('todoSearch').value || '').trim().toLowerCase();
  const dateField = (document.getElementById('todoDateField') || {}).value || 'dueDate';
  const dFrom = (document.getElementById('todoDateFrom') || {}).value || '';
  const dTo = (document.getElementById('todoDateTo') || {}).value || '';

  const matchesQuick = (t) => {
    const s = todoStatus(t);
    if (quick === 'active') return s === '대기' || s === '진행중';
    if (quick === 'done') return s === '완료' || s === '지연완료';
    if (quick === 'hold') return s === '보류';
    return true;
  };
  const matchesSearch = (t) => {
    if (!q) return true;
    return [t.text, t.channel, t.subChannel, t.assignee, t.progress, t.remarks, t.priority, String(t.no || '')]
      .some((v) => (v || '').toString().toLowerCase().includes(q));
  };
  const matchesDate = (t) => {
    if (!dFrom && !dTo) return true;
    const v = t[dateField] || '';
    if (!v) return false;
    if (dFrom && v < dFrom) return false;
    if (dTo && v > dTo) return false;
    return true;
  };

  const hideDone = !!(document.getElementById('todoHideDone') || {}).checked;
  let items = state.todos.slice().sort((a, b) => (a.no || 0) - (b.no || 0) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  if (projVal !== 'all') items = items.filter((t) => t.projectId === projVal);
  if (midVal !== 'all') items = items.filter((t) => ((t.channel || '').trim()) === midVal);
  if (subVal !== 'all') items = items.filter((t) => ((t.subChannel || '').trim()) === subVal);
  if (hideDone) items = items.filter((t) => !todoIsDone(t));
  return sortTodos(items.filter(matchesQuick).filter(matchesSearch).filter(matchesDate));
}

/* 표 ↔ 캘린더 레이아웃 전환 */
function setTodoLayout(mode) {
  todoLayoutMode = mode;
  document.querySelectorAll('#todoLayout .segmented-btn').forEach((b) => b.classList.toggle('active', b.dataset.layout === mode));
  document.getElementById('todoTableView').classList.toggle('hidden', mode !== 'table');
  document.getElementById('todoCalendarView').classList.toggle('hidden', mode !== 'calendar');
  if (mode === 'calendar') {
    ensureTodoCalendar();
    todoCal.refetchEvents();
    setTimeout(() => todoCal.updateSize(), 40);
  }
}

/* 할 일 전용 캘린더(필터 적용, 마감일 기준) — 최초 전환 시 1회 생성 */
function ensureTodoCalendar() {
  if (todoCal) return;
  todoCal = new FullCalendar.Calendar(document.getElementById('todoCalendar'), {
    initialView: 'dayGridMonth',
    height: 'auto',
    firstDay: 0,
    locales: [window.FC_KO_LOCALE],
    locale: 'ko',
    headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek' },
    events: (info, success) => success(buildTodoViewEvents()),
    eventClick: (info) => {
      if (info.event.id.startsWith('td-')) openTodoModal(byId(state.todos, info.event.id.slice(3)));
    }
  });
  todoCal.render();
}

function buildTodoViewEvents() {
  return filterTodos().filter((t) => t.dueDate).map((t) => ({
    id: 'td-' + t.id,
    title: todoCalendarPrefix(t) + (t.channel ? '[' + t.channel + '] ' : '') + t.text,
    start: t.dueDate,
    allDay: true,
    color: todoIsDone(t) ? '#9698b8' : projectColor(t.projectId)
  }));
}

function renderTodoPagination(pages, size) {
  const bar = document.getElementById('todoPagination');
  if (!bar) return;
  if (size === Infinity || pages <= 1) { bar.innerHTML = ''; return; }
  bar.innerHTML =
    `<button class="btn" id="todoPrevBtn" ${todoPage <= 1 ? 'disabled' : ''}>◀ 이전</button>` +
    `<span class="todo-page-ind">${todoPage} / ${pages}</span>` +
    `<button class="btn" id="todoNextBtn" ${todoPage >= pages ? 'disabled' : ''}>다음 ▶</button>`;
  const prev = document.getElementById('todoPrevBtn');
  const next = document.getElementById('todoNextBtn');
  if (prev) prev.onclick = () => { if (todoPage > 1) { todoPage--; renderTodos(); } };
  if (next) next.onclick = () => { if (todoPage < pages) { todoPage++; renderTodos(); } };
}

function renderTodos() {
  const projSelect = document.getElementById('todoProjectFilter');
  const prevProj = projSelect.value || 'all';
  projSelect.innerHTML = '<option value="all">전체 대분류</option>' + projectOptionsHtml(null);
  projSelect.value = state.projects.some((p) => p.id === prevProj) || prevProj === 'all' ? prevProj : 'all';

  // 중분류·소분류 필터는 대분류와 독립이다 — 전체 목록을 그대로 보여준다
  const midSelect = document.getElementById('todoMidFilter');
  const subSelect = document.getElementById('todoSubFilter');
  if (midSelect) {
    const prevMid = midSelect.value || 'all';
    const mids = midList();
    midSelect.innerHTML = '<option value="all">전체 중분류</option>'
      + mids.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    midSelect.value = mids.includes(prevMid) ? prevMid : 'all';
  }
  if (subSelect) {
    const prevSub = subSelect.value || 'all';
    const subs = subList();
    subSelect.innerHTML = '<option value="all">전체 소분류</option>'
      + subs.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    subSelect.value = subs.includes(prevSub) ? prevSub : 'all';
  }

  const all = filterTodos();
  updateSortIndicators();
  const total = state.todos.length;

  const countEl = document.getElementById('todoCount');
  if (countEl) countEl.textContent = all.length === total ? `${total}건` : `${all.length} / ${total}건`;

  if (todoLayoutMode === 'calendar' && todoCal) todoCal.refetchEvents();

  const sizeVal = (document.getElementById('todoPageSize') || {}).value || '50';
  const size = sizeVal === 'all' ? Infinity : parseInt(sizeVal, 10);
  const pages = size === Infinity ? 1 : Math.max(1, Math.ceil(all.length / size));
  if (todoPage > pages) todoPage = pages;
  if (todoPage < 1) todoPage = 1;
  const pageItems = size === Infinity ? all : all.slice((todoPage - 1) * size, todoPage * size);

  const tbody = document.getElementById('todoTableBody');
  tbody.innerHTML = '';
  document.getElementById('todoEmpty').classList.toggle('hidden', all.length > 0);

  const today = todayStr();
  pageItems.forEach((t, idx) => {
    const proj = byId(state.projects, t.projectId);
    const status = todoStatus(t);
    const statusColor = TODO_STATUS_COLORS[status] || '#9b9a97';
    const tr = document.createElement('tr');
    let cls = todoIsDone(t) ? 'done' : '';
    if (!todoIsDone(t) && t.dueDate) {
      if (t.dueDate < today) cls += ' row-overdue';
      else if (t.dueDate === today) cls += ' row-today';
    }
    tr.className = cls.trim();
    if (todoSelected.has(t.id)) tr.classList.add('row-selected');
    tr.innerHTML = `
      <td class="col-select"><input type="checkbox" class="todo-check" data-id="${escapeHtml(t.id)}" ${todoSelected.has(t.id) ? 'checked' : ''} /></td>
      <td class="col-no">${t.no || idx + 1}</td>
      <td class="col-date">${t.registeredDate || ''}</td>
      <td>${proj ? tagHtml(proj.name, proj.color) : ''}</td>
      <td>${channelChipHtml(t.channel)}</td>
      <td class="col-sub">${escapeHtml(t.subChannel || '')}</td>
      <td>${escapeHtml(t.priority || '')}</td>
      <td class="col-title">${escapeHtml(t.text || '')}</td>
      <td>${escapeHtml(t.assignee || '')}</td>
      <td class="col-date col-due">${t.dueDate || ''}</td>
      <td><span class="status-tag" style="background:${statusColor}1f;color:${statusColor}">${escapeHtml(status)}</span></td>
      <td class="col-check">${escapeHtml(t.needsCheck || '')}</td>
      <td class="col-date">${t.completedDate || ''}</td>
      <td class="col-notes" title="${escapeHtml(t.progress || '')}">${escapeHtml(t.progress || '')}</td>
      <td class="col-notes" title="${escapeHtml(t.remarks || '')}">${escapeHtml(t.remarks || '')}</td>
      <td class="col-link">${todoLinksCellHtml(t)}${todoFilesCellHtml(t)}</td>
      <td class="col-actions"><button class="icon-btn del-btn" title="삭제">🗑</button></td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.del-btn') || e.target.closest('.todo-link') || e.target.closest('.col-select')) return;
      openTodoModal(t);
    });
    tr.querySelector('.todo-check').addEventListener('change', (e) => {
      if (e.target.checked) todoSelected.add(t.id); else todoSelected.delete(t.id);
      tr.classList.toggle('row-selected', e.target.checked);
      updateBulkBar();
    });
    tr.querySelector('.del-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      todoSelected.delete(t.id);
      deleteTodoFiles([t]);
      state.todos = state.todos.filter((x) => x.id !== t.id);
      persist(); renderTodos(); refreshCalendarEvents();
    });
    tbody.appendChild(tr);
  });

  updateBulkBar();
  renderTodoPagination(pages, size);
}

let todoSelected = new Set();

function updateBulkBar() {
  const bar = document.getElementById('todoBulkBar');
  if (!bar) return;
  const n = todoSelected.size;
  bar.classList.toggle('hidden', n === 0);
  const cnt = document.getElementById('todoBulkCount');
  if (cnt) cnt.textContent = `${n}개 선택`;
  // 전체선택 체크박스 상태(현재 페이지 기준)
  const boxes = [...document.querySelectorAll('#todoTableBody .todo-check')];
  const all = document.getElementById('todoSelectAll');
  if (all) {
    const checked = boxes.filter((b) => b.checked).length;
    all.checked = boxes.length > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }
}

/* 선택한 할 일들에 분류를 한꺼번에 지정한다.
   (중분류로 걸러 전체 선택 → 소분류 지정) 하나씩 여는 수고를 줄이려는 것. */
function bulkAssign(field, value, label) {
  if (!value || todoSelected.size === 0) return;
  const clear = value === '__clear__';
  const v = clear ? '' : value;
  let n = 0;
  state.todos.forEach((t) => {
    if (!todoSelected.has(t.id)) return;
    if ((t[field] || '') === v) return;
    t[field] = v;
    n++;
  });
  if (!clear && v) { if (field === 'channel') addMid(v); else addSub(v); }
  todoSelected.clear();
  persist(); renderAll();
  toast(clear ? `${label} ${n}건 비웠어요` : `${n}건을 ${label} "${v}"(으)로 지정했어요`);
}

// 일괄 지정 드롭다운 채우기 (분류 목록이 바뀔 때마다 다시 그린다)
function refreshBulkSelects() {
  taxoInit();
  const fill = (id, head, list) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = `<option value="">${head}</option>`
      + list.map((v) => `<option value="${escapeHtml(v)}">→ ${escapeHtml(v)}</option>`).join('')
      + '<option value="__clear__">→ (비우기)</option>';
  };
  fill('todoBulkSub', '소분류 일괄 지정…', state.subMaster);
  fill('todoBulkMid', '중분류 일괄 지정…', state.channels);
}

function setupTodoBulk() {
  const subSel = document.getElementById('todoBulkSub');
  const midSel = document.getElementById('todoBulkMid');
  if (subSel) subSel.addEventListener('change', () => {
    const v = subSel.value; subSel.value = '';
    bulkAssign('subChannel', v, '소분류');
  });
  if (midSel) midSel.addEventListener('change', () => {
    const v = midSel.value; midSel.value = '';
    bulkAssign('channel', v, '중분류');
  });
  const statusSel = document.getElementById('todoBulkStatus');
  if (statusSel && statusSel.options.length <= 1) {
    TODO_STATUS_OPTIONS.forEach((s) => {
      const o = document.createElement('option'); o.value = s; o.textContent = '→ ' + s; statusSel.appendChild(o);
    });
  }
  const all = document.getElementById('todoSelectAll');
  if (all) all.addEventListener('change', () => {
    const boxes = [...document.querySelectorAll('#todoTableBody .todo-check')];
    boxes.forEach((b) => {
      b.checked = all.checked;
      const id = b.getAttribute('data-id');
      if (all.checked) todoSelected.add(id); else todoSelected.delete(id);
      b.closest('tr').classList.toggle('row-selected', all.checked);
    });
    updateBulkBar();
  });
  if (statusSel) statusSel.addEventListener('change', () => {
    const st = statusSel.value;
    statusSel.value = '';
    if (!st || todoSelected.size === 0) return;
    let n = 0;
    state.todos.forEach((t) => {
      if (todoSelected.has(t.id)) {
        t.status = st; t.done = (st === '완료' || st === '지연완료');
        if (t.done && !t.completedDate) t.completedDate = todayStr();
        n++;
      }
    });
    todoSelected.clear();
    persist(); renderAll(); toast(`${n}개 상태를 '${st}'로 변경했어요`);
  });
  const delBtn = document.getElementById('todoBulkDelete');
  if (delBtn) delBtn.addEventListener('click', () => {
    const n = todoSelected.size;
    if (!n) return;
    if (!confirm(`선택한 ${n}개 업무를 삭제할까요?`)) return;
    deleteTodoFiles(state.todos.filter((t) => todoSelected.has(t.id)));
    state.todos = state.todos.filter((t) => !todoSelected.has(t.id));
    todoSelected.clear();
    persist(); renderAll(); toast(`${n}개를 삭제했어요`);
  });
  const clearBtn = document.getElementById('todoBulkClear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    todoSelected.clear();
    document.querySelectorAll('#todoTableBody .todo-check').forEach((b) => { b.checked = false; b.closest('tr').classList.remove('row-selected'); });
    updateBulkBar();
  });
}

// 스킴 없는 URL이면 https:// 를 붙여 새 탭에서 열리게 한다. javascript: 등은 무력화.
function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^javascript:/i.test(s)) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  return 'https://' + s;
}

// 산출물 링크: 신형 t.links(배열) 우선, 구형 t.link(단일) 호환
function todoLinks(t) {
  if (Array.isArray(t.links)) return t.links.filter(Boolean);
  return t.link ? [t.link] : [];
}
function todoLinksCellHtml(t) {
  const links = todoLinks(t);
  if (!links.length) return '';
  return links.map((u, i) =>
    `<a class="todo-link" href="${escapeHtml(normalizeUrl(u))}" target="_blank" rel="noopener" title="${escapeHtml(u)}">🔗${links.length > 1 ? (i + 1) : ' 열기'}</a>`
  ).join(' ');
}
function linkRowHtml(u) {
  return `<div class="link-row"><input type="text" class="f-link-input" value="${escapeHtml(u || '')}" placeholder="스프레드시트·드라이브·문서 URL" /><button type="button" class="icon-btn link-del" title="삭제">✕</button></div>`;
}

/* ---------- 첨부 파일 (R2, 클라우드 전용) ---------- */
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(0) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}
function fileRowHtml(f) {
  return `<div class="file-row" data-key="${escapeHtml(f.key)}" data-name="${escapeHtml(f.name)}" data-size="${f.size || 0}">
    <span class="file-name" title="${escapeHtml(f.name)}">📎 ${escapeHtml(f.name)}</span>
    <span class="file-size">${fmtBytes(f.size)}</span>
    <button type="button" class="icon-btn file-open" title="다운로드">⬇</button>
    <button type="button" class="icon-btn file-del" title="삭제">✕</button>
  </div>`;
}
function todoFilesCellHtml(t) {
  const fs = Array.isArray(t.files) ? t.files : [];
  if (!fs.length) return '';
  return `<span class="todo-file-badge" title="${escapeHtml(fs.map((f) => f.name).join(', '))}">📎${fs.length}</span>`;
}

function openTodoModal(todo, presets) {
  const isNew = !todo;
  const nextNo = isNew ? Math.max(0, ...state.todos.map((t) => t.no || 0)) + 1 : todo.no;
  const data = todo || Object.assign({
    id: null, no: nextNo, registeredDate: todayStr(), projectId: state.projects[0] ? state.projects[0].id : null,
    channel: '', priority: '', text: '', assignee: '', dueDate: '', status: '대기', needsCheck: '',
    completedDate: '', progress: '', remarks: '', link: ''
  }, presets || {});
  showModal({
    title: isNew ? '할 일 추가' : '할 일 수정',
    deletable: !isNew,
    wide: true,
    bodyHtml: `
      <div class="field"><label>업무내용</label><input type="text" id="f-text" value="${escapeHtml(data.text)}" placeholder="업무 내용" /></div>
      <div class="field-row">
        <div class="field"><label>대분류</label><select id="f-project">${projectOptionsHtml(data.projectId)}</select></div>
        <div class="field"><label>중분류</label><input type="text" id="f-channel" value="${escapeHtml(data.channel || '')}" list="channel-options" placeholder="선택 또는 새로 입력" /></div>
        <div class="field"><label>소분류</label><input type="text" id="f-subchannel" value="${escapeHtml(data.subChannel || '')}" list="sub-options" placeholder="선택 또는 새로 입력" /></div>
      </div>
      <datalist id="channel-options">${channelOptionsHtml()}</datalist>
      <datalist id="sub-options">${subOptionsHtml()}</datalist>
      <div class="field-row">
        <div class="field"><label>담당자</label><input type="text" id="f-assignee" value="${escapeHtml(data.assignee || '')}" /></div>
        <div class="field"><label>우선순위</label><input type="text" id="f-priority" value="${escapeHtml(data.priority || '')}" list="priority-options" /></div>
      </div>
      <datalist id="priority-options"><option value="보통"></option><option value="중요"></option><option value="긴급"></option></datalist>
      <div class="field-row">
        <div class="field"><label>등록일</label><input type="date" id="f-registered" value="${data.registeredDate || ''}" /></div>
        <div class="field"><label>마감(예정)일</label><input type="date" id="f-due" value="${data.dueDate || ''}" /></div>
      </div>
      ${isNew ? `
      <div class="field-row">
        <div class="field"><label>반복 (마감일 기준)</label><select id="f-todo-recur">
          <option value="none">없음</option>
          <option value="daily">매일</option>
          <option value="weekly">매주</option>
          <option value="biweekly">2주마다</option>
          <option value="monthly">매월</option>
        </select></div>
        <div class="field hidden" id="f-todo-recur-until-wrap"><label>반복 종료일</label><input type="date" id="f-todo-recur-until" /></div>
      </div>` : (data.recurGroup ? '<div class="field"><span class="hint">🔁 반복 할일 중 하나입니다. 삭제 시 전체/개별 선택 가능.</span></div>' : '')}
      <div class="field-row">
        <div class="field"><label>진행상태</label>
          <select id="f-status">${TODO_STATUS_OPTIONS.map((s) => `<option value="${s}" ${todoStatus(data) === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field"><label>점검필요</label>
          <select id="f-needscheck">
            <option value="" ${!data.needsCheck ? 'selected' : ''}>-</option>
            <option value="Y" ${data.needsCheck === 'Y' ? 'selected' : ''}>Y</option>
            <option value="N" ${data.needsCheck === 'N' ? 'selected' : ''}>N</option>
          </select>
        </div>
      </div>
      <div class="field"><label>완료일(선택)</label><input type="date" id="f-completed" value="${data.completedDate || ''}" /></div>
      <div class="field-row">
        <div class="field"><label>진행사항</label><textarea id="f-progress" placeholder="진행 상황 기록">${escapeHtml(data.progress || '')}</textarea></div>
        <div class="field"><label>비고</label><textarea id="f-remarks" placeholder="기타 메모">${escapeHtml(data.remarks || '')}</textarea></div>
      </div>
      <div class="field"><label>산출물 링크 (선택 · 여러 개 가능)</label>
        <div id="f-links">${(todoLinks(data).length ? todoLinks(data) : ['']).map((u) => linkRowHtml(u)).join('')}</div>
        <button type="button" class="btn link-add-btn" id="f-link-add">+ 링크 추가</button>
      </div>
      ${cloudMode ? `
      <div class="field"><label>첨부 파일 (선택 · 최대 25MB)</label>
        <div id="f-files">${(Array.isArray(data.files) ? data.files : []).map(fileRowHtml).join('')}</div>
        <input type="file" id="f-file-input" class="hidden" />
        <button type="button" class="btn link-add-btn" id="f-file-add">+ 파일 첨부</button>
      </div>` : ''}
    `,
    onSave: () => {
      const text = document.getElementById('f-text').value.trim();
      if (!text) { toast('업무내용을 입력해주세요'); return false; }
      const projectId = document.getElementById('f-project').value;
      const channel = document.getElementById('f-channel').value.trim();
      const subChannel = document.getElementById('f-subchannel').value.trim();
      // 새로 입력한 값은 각 마스터 목록에 자동 등록된다(세 축이 독립이라 서로 조건이 없다)
      if (channel) addMid(channel);
      if (subChannel) addSub(subChannel);
      const assignee = document.getElementById('f-assignee').value;
      const priority = document.getElementById('f-priority').value;
      const registeredDate = document.getElementById('f-registered').value;
      const dueDate = document.getElementById('f-due').value;
      const status = document.getElementById('f-status').value;
      const needsCheck = document.getElementById('f-needscheck').value;
      const completedDate = document.getElementById('f-completed').value;
      const progress = document.getElementById('f-progress').value;
      const remarks = document.getElementById('f-remarks').value;
      const links = [...document.querySelectorAll('#f-links .f-link-input')].map((i) => i.value.trim()).filter(Boolean);
      const link = links[0] || ''; // 구형 호환(구글 동기화 등)
      const files = [...document.querySelectorAll('#f-files .file-row')].map((r) => ({
        key: r.dataset.key, name: r.dataset.name, size: Number(r.dataset.size) || 0
      }));
      const done = status === '완료' || status === '지연완료';
      const recur = isNew && document.getElementById('f-todo-recur') ? document.getElementById('f-todo-recur').value : 'none';
      if (isNew && recur !== 'none') {
        if (!dueDate) { toast('반복 할일은 마감일이 필요해요'); return false; }
        const until = document.getElementById('f-todo-recur-until').value;
        const dates = generateRecurrence(dueDate, recur, until);
        const group = 'rg' + uid();
        let no = nextNo;
        dates.forEach((d) => {
          state.todos.push({ id: uid(), no: no++, registeredDate, projectId, channel, subChannel, priority, text, assignee, dueDate: d, status: '대기', needsCheck, completedDate: '', progress, remarks, links, link, files, done: false, recurGroup: group });
        });
        persist(); renderAll();
        toast(`반복 할일 ${dates.length}개를 추가했어요`);
        return true;
      }
      if (isNew) {
        state.todos.push({ id: uid(), no: nextNo, registeredDate, projectId, channel, subChannel, priority, text, assignee, dueDate, status, needsCheck, completedDate, progress, remarks, links, link, files, done });
      } else {
        Object.assign(todo, { registeredDate, projectId, channel, subChannel, priority, text, assignee, dueDate, status, needsCheck, completedDate, progress, remarks, links, link, files, done });
      }
      persist(); renderAll();
      return true;
    },
    onDelete: () => {
      if (todo.recurGroup) {
        const cnt = state.todos.filter((x) => x.recurGroup === todo.recurGroup).length;
        if (cnt > 1 && confirm(`반복 할일입니다. 전체 ${cnt}개를 삭제할까요?\n(확인=전체 / 취소=이 항목 1개만)`)) {
          deleteTodoFiles(state.todos.filter((x) => x.recurGroup === todo.recurGroup));
          state.todos = state.todos.filter((x) => x.recurGroup !== todo.recurGroup);
          toast(`반복 할일 ${cnt}개를 삭제했어요`);
        } else {
          deleteTodoFiles([todo]);
          state.todos = state.todos.filter((x) => x.id !== todo.id);
        }
      } else {
        deleteTodoFiles([todo]);
        state.todos = state.todos.filter((x) => x.id !== todo.id);
      }
      persist(); renderAll();
    },
    onOpen: () => {
      // 대분류·중분류·소분류는 서로 독립이라 한쪽을 바꿔도 다른 칸을 건드리지 않는다.
      const box = document.getElementById('f-links');
      const add = document.getElementById('f-link-add');
      if (add) add.onclick = () => box.insertAdjacentHTML('beforeend', linkRowHtml(''));
      if (box) box.addEventListener('click', (e) => {
        if (!e.target.closest('.link-del')) return;
        const rows = box.querySelectorAll('.link-row');
        if (rows.length > 1) e.target.closest('.link-row').remove();
        else box.querySelector('.f-link-input').value = '';
      });
      const recur = document.getElementById('f-todo-recur');
      if (recur) {
        const wrap = document.getElementById('f-todo-recur-until-wrap');
        const sync = () => wrap.classList.toggle('hidden', recur.value === 'none');
        sync();
        recur.addEventListener('change', sync);
      }
      // 첨부 파일: 선택 즉시 업로드 → 행 추가. 저장 시 t.files로 반영.
      const fbox = document.getElementById('f-files');
      const fadd = document.getElementById('f-file-add');
      const finput = document.getElementById('f-file-input');
      if (fadd && finput && fbox) {
        fadd.onclick = () => finput.click();
        finput.onchange = async () => {
          const file = finput.files && finput.files[0];
          finput.value = '';
          if (!file) return;
          if (file.size > 25 * 1024 * 1024) { toast('25MB 이하 파일만 첨부할 수 있어요'); return; }
          fadd.disabled = true; fadd.textContent = '업로드 중…';
          try {
            const fd = new FormData(); fd.append('file', file);
            const r = await CloudSync.authFetch('/api/files', { method: 'POST', body: fd });
            const j = await r.json();
            if (j.ok) { fbox.insertAdjacentHTML('beforeend', fileRowHtml(j)); toast('첨부했어요'); }
            else toast('업로드 실패: ' + (j.error || ''));
          } catch (e) { toast('업로드 실패'); }
          fadd.disabled = false; fadd.textContent = '+ 파일 첨부';
        };
        fbox.addEventListener('click', async (e) => {
          const row = e.target.closest('.file-row');
          if (!row) return;
          if (e.target.closest('.file-open')) {
            const url = '/api/files/' + row.dataset.key + '?t=' + encodeURIComponent(CloudSync.token());
            window.open(url, '_blank', 'noopener');
          } else if (e.target.closest('.file-del')) {
            const key = row.dataset.key;
            row.remove();
            try { await CloudSync.authFetch('/api/files/' + key, { method: 'DELETE' }); } catch (err) {}
          }
        });
      }
    }
  });
}

/* ---------- 프로젝트 / 칸반 ---------- */
function setupProjects() {
  document.getElementById('addProjectBtn').onclick = () => openProjectModal(null);
}

function renderProjectTabs() {
  if (!currentProjectViewId || !byId(state.projects, currentProjectViewId)) {
    currentProjectViewId = state.projects[0] ? state.projects[0].id : null;
  }
  const wrap = document.getElementById('projectTabs');
  wrap.innerHTML = '';
  state.projects.forEach((p) => {
    const tab = document.createElement('div');
    tab.className = 'project-tab' + (p.id === currentProjectViewId ? ' active' : '');
    tab.style.setProperty('--tab-color', p.color);
    tab.innerHTML = `<span class="dot" style="background:${p.color}"></span><span>${escapeHtml(p.name)}</span>`;
    tab.addEventListener('click', () => { currentProjectViewId = p.id; renderProjectTabs(); renderKanban(); });
    tab.addEventListener('dblclick', () => openProjectModal(p));
    wrap.appendChild(tab);
  });
  document.getElementById('projectEmpty').classList.toggle('hidden', state.projects.length > 0);
}

/* 칸반 컬럼 = 할 일 데이터의 진행상태. 지연완료는 완료 열에 합쳐 표시한다. */
const KANBAN_COLS = [
  { key: '대기', label: '할 일', dot: '#9b9a97' },
  { key: '진행중', label: '진행중', dot: '#039be5' },
  { key: '완료', label: '완료', dot: '#0b8043' },
  { key: '보류', label: '보류', dot: '#f6bf26' }
];

function todoKanbanCol(t) {
  const s = todoStatus(t);
  if (s === '진행중') return '진행중';
  if (s === '완료' || s === '지연완료') return '완료';
  if (s === '보류') return '보류';
  return '대기';
}

function renderKanban() {
  const board = document.getElementById('kanbanBoard');
  const hint = document.getElementById('kanbanHint');
  board.classList.toggle('hidden', !currentProjectViewId);
  if (hint) hint.classList.toggle('hidden', !currentProjectViewId);
  board.innerHTML = '';
  if (!currentProjectViewId) return;

  const items = state.todos.filter((t) => t.projectId === currentProjectViewId);

  KANBAN_COLS.forEach((c) => {
    const list = items
      .filter((t) => todoKanbanCol(t) === c.key)
      .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));

    const colEl = document.createElement('div');
    colEl.className = 'kanban-col';
    colEl.innerHTML = `
      <div class="kanban-col-header"><span class="dot" style="background:${c.dot}"></span>${c.label}<span class="kanban-count">${list.length}</span></div>
      <div class="kanban-cards"></div>
      <button class="add-card-btn">+ 할 일 추가</button>`;
    const cards = colEl.querySelector('.kanban-cards');

    list.forEach((t) => {
      const pri = normalizePriority(t.priority);
      const priMark = pri === '긴급' ? '🔴 ' : pri === '중요' ? '🟠 ' : '';
      const chk = t.needsCheck === 'Y' ? '⚠ ' : '';
      const card = document.createElement('div');
      card.className = 'kanban-card' + (todoIsDone(t) ? ' done' : '');
      card.style.setProperty('--item-color', projectColor(t.projectId));
      card.draggable = true;
      card.dataset.id = t.id;
      card.innerHTML = `<div class="kanban-card-title">${priMark}${chk}${escapeHtml(t.text)}</div>`
        + (t.channel ? `<div class="kanban-card-meta">${channelChipHtml(t.channel)}${t.subChannel ? `<span class="kanban-card-sub">${escapeHtml(t.subChannel)}</span>` : ''}</div>` : '')
        + (t.dueDate ? `<div class="kanban-card-due">📅 ${t.dueDate}</div>` : '');
      card.addEventListener('click', () => openTodoModal(t));
      card.addEventListener('dragstart', () => { draggedCardId = t.id; card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { card.classList.remove('dragging'); draggedCardId = null; });
      cards.appendChild(card);
    });

    colEl.querySelector('.add-card-btn').addEventListener('click', () => {
      openTodoModal(null, { projectId: currentProjectViewId, status: c.key });
    });

    colEl.ondragover = (e) => { e.preventDefault(); colEl.classList.add('drag-over'); };
    colEl.ondragleave = () => colEl.classList.remove('drag-over');
    colEl.ondrop = (e) => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      if (!draggedCardId) return;
      const t = byId(state.todos, draggedCardId);
      if (t && todoKanbanCol(t) !== c.key) {
        t.status = c.key;
        t.done = c.key === '완료';
        if (c.key === '완료' && !t.completedDate) t.completedDate = todayStr();
        persist(); renderKanban(); renderTodos(); renderDashboard(); refreshCalendarEvents();
      }
    };

    board.appendChild(colEl);
  });
}

function openProjectModal(project) {
  const isNew = !project;
  const data = project || { id: null, name: '', color: PALETTE[state.projects.length % PALETTE.length] };
  showModal({
    title: isNew ? '새 대분류' : '대분류 수정',
    deletable: !isNew && data.id !== 'default',
    bodyHtml: `
      <div class="field"><label>이름</label><input type="text" id="f-name" value="${escapeHtml(data.name)}" placeholder="대분류 이름 (예: 영업)" /></div>
      <div class="field"><label>색상</label><div class="color-picker-row" id="f-color-row"></div></div>
    `,
    onOpen: () => buildColorRow('f-color-row', data.color),
    onSave: () => {
      const name = document.getElementById('f-name').value.trim();
      if (!name) { toast('이름을 입력해주세요'); return false; }
      const color = getSelectedColor('f-color-row');
      if (isNew) {
        const p = { id: uid(), name, color };
        state.projects.push(p);
        currentProjectViewId = p.id;
      } else {
        Object.assign(project, { name, color });
      }
      persist(); renderSidebarProjects(); renderProjectTabs(); renderKanban(); renderTodos(); refreshCalendarEvents(); renderChannelSettings();
      return true;
    },
    onDelete: () => {
      state.projects = state.projects.filter((p) => p.id !== project.id);
      state.tasks.forEach((t) => { if (t.projectId === project.id) t.projectId = 'default'; });
      state.todos.forEach((t) => { if (t.projectId === project.id) t.projectId = 'default'; });
      state.events.forEach((e) => { if (e.projectId === project.id) e.projectId = 'default'; });
      currentProjectViewId = null;
      persist(); renderSidebarProjects(); renderProjectTabs(); renderKanban(); renderTodos(); refreshCalendarEvents(); renderChannelSettings();
    }
  });
}

function openTaskModal(status, task) {
  const isNew = !task;
  const data = task || { id: null, title: '', dueDate: '', status: status || 'todo', projectId: currentProjectViewId, notes: '' };
  showModal({
    title: isNew ? '새 카드' : '카드 수정',
    deletable: !isNew,
    bodyHtml: `
      <div class="field"><label>제목</label><input type="text" id="f-title" value="${escapeHtml(data.title)}" placeholder="작업 제목" /></div>
      <div class="field"><label>마감일(선택)</label><input type="date" id="f-due" value="${data.dueDate || ''}" /></div>
      <div class="field"><label>상태</label>
        <select id="f-status">
          <option value="todo" ${data.status === 'todo' ? 'selected' : ''}>할 일</option>
          <option value="inprogress" ${data.status === 'inprogress' ? 'selected' : ''}>진행중</option>
          <option value="done" ${data.status === 'done' ? 'selected' : ''}>완료</option>
        </select>
      </div>
      <div class="field"><label>메모(선택)</label><textarea id="f-notes" placeholder="담당자, 진행사항, 세부내용 등">${escapeHtml(data.notes || '')}</textarea></div>
    `,
    onSave: () => {
      const title = document.getElementById('f-title').value.trim();
      if (!title) { toast('제목을 입력해주세요'); return false; }
      const dueDate = document.getElementById('f-due').value;
      const stat = document.getElementById('f-status').value;
      const notes = document.getElementById('f-notes').value;
      if (isNew) {
        state.tasks.push({ id: uid(), title, dueDate, status: stat, projectId: currentProjectViewId, notes });
      } else {
        Object.assign(task, { title, dueDate, status: stat, notes });
      }
      persist(); renderKanban(); refreshCalendarEvents();
      return true;
    },
    onDelete: () => {
      state.tasks = state.tasks.filter((x) => x.id !== task.id);
      persist(); renderKanban(); refreshCalendarEvents();
    }
  });
}

/* ---------- 구글시트/CSV 가져오기 ---------- */

/* 붙여넣은 텍스트를 표(행×열)로 파싱. 탭 우선, 없으면 콤마(CSV). 따옴표로 감싼 셀 안의
   구분자/줄바꿈을 존중한다(진행사항 같은 여러 줄 셀 대응). */
function parseDelimitedTable(text) {
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const delim = src.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  row.push(cell); rows.push(row);
  // 완전히 빈 행 제거
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* 머리글 이름 → 내부 필드 매핑 (공백/괄호 제거 후 비교) */
const SHEET_HEADER_MAP = {
  'no': 'no', '번호': 'no', '순번': 'no',
  '등록일': 'registeredDate', '등록': 'registeredDate', '등록날짜': 'registeredDate',
  '대분류': 'project', '분류': 'project', '카테고리': 'project', '프로젝트': 'project',
  '중분류': 'channel', '세부채널': 'channel', '채널': 'channel', '세부': 'channel',
  '소분류': 'subChannel', '소분류명': 'subChannel',
  '우선순위': 'priority', '중요도': 'priority',
  '업무내용': 'text', '업무': 'text', '내용': 'text', '제목': 'text', '할일': 'text',
  '담당자': 'assignee', '담당': 'assignee',
  '마감일': 'dueDate', '마감': 'dueDate', '마감예정일': 'dueDate', '예정일': 'dueDate', '기한': 'dueDate',
  '진행상태': 'status', '상태': 'status',
  '점검필요': 'needsCheck', '점검': 'needsCheck',
  '완료일': 'completedDate', '완료': 'completedDate', '완료날짜': 'completedDate',
  '진행사항': 'progress', '진행': 'progress',
  '비고': 'remarks', '메모': 'remarks', '기타': 'remarks'
};
const SHEET_DEFAULT_COLS = ['no', 'registeredDate', 'project', 'channel', 'priority', 'text', 'assignee', 'dueDate', 'status', 'needsCheck', 'completedDate', 'progress', 'remarks'];

function normHeaderKey(s) { return String(s || '').replace(/[\s()（）.]/g, '').toLowerCase(); }

/* 머리글 셀 → 내부 필드. 정확 매칭 우선, 실패 시 부분(포함) 매칭.
   실제 시트의 "진행사항 / 업데이트 로그", "마감(예정)일" 같은 변형 헤더를 흡수한다. */
function mapHeaderField(normKey) {
  if (SHEET_HEADER_MAP[normKey]) return SHEET_HEADER_MAP[normKey];
  const CONTAINS = [
    ['진행사항', 'progress'], ['업데이트', 'progress'], ['진척', 'progress'],
    ['완료', 'completedDate'],
    ['마감', 'dueDate'], ['예정일', 'dueDate'], ['기한', 'dueDate'],
    ['등록', 'registeredDate'],
    ['담당', 'assignee'],
    ['대분류', 'project'], ['카테고리', 'project'],
    ['중분류', 'channel'], ['세부채널', 'channel'], ['채널', 'channel'],
    ['소분류', 'subChannel'],
    ['우선순위', 'priority'], ['중요도', 'priority'],
    ['진행상태', 'status'],
    ['점검', 'needsCheck'],
    ['업무내용', 'text'], ['업무', 'text'], ['내용', 'text'],
    ['비고', 'remarks'], ['메모', 'remarks'],
    ['번호', 'no']
  ];
  for (let i = 0; i < CONTAINS.length; i++) if (normKey.includes(CONTAINS[i][0])) return CONTAINS[i][1];
  return null;
}

/* 날짜 문자열을 YYYY-MM-DD로 정규화. 실패하면 원본을 그대로 둔다(캘린더엔 안 뜨지만 보존). */
function normalizeDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{2,4})[.\-/\s]+(\d{1,2})[.\-/\s]+(\d{1,2})/);
  if (m) {
    let y = +m[1]; if (y < 100) y += 2000;
    return y + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0');
  }
  const md = s.match(/^(\d{1,2})[.\-/](\d{1,2})$/);
  if (md) {
    const y = new Date().getFullYear();
    return y + '-' + String(+md[1]).padStart(2, '0') + '-' + String(+md[2]).padStart(2, '0');
  }
  return s;
}

const SHEET_STATUS_SYNONYMS = {
  '완료': '완료', 'done': '완료', '종료': '완료', '완': '완료',
  '지연완료': '지연완료', '지연': '지연완료',
  '진행중': '진행중', '진행': '진행중', 'inprogress': '진행중', 'in-progress': '진행중', 'doing': '진행중',
  '대기': '대기', '대기중': '대기', 'todo': '대기', '예정': '대기', '접수': '대기',
  '보류': '보류', 'hold': '보류', 'onhold': '보류', '중단': '보류'
};
function normalizeStatus(v) {
  const s = String(v || '').trim();
  if (!s) return '대기';
  if (TODO_STATUS_OPTIONS.includes(s)) return s;
  const key = s.replace(/[\s()]/g, '').toLowerCase();
  return SHEET_STATUS_SYNONYMS[key] || s;
}
function normalizeCheck(v) {
  const s = String(v || '').trim().toLowerCase();
  if (['y', 'yes', 'o', '○', '●', '예', 'v', '✓', 'true', '필요'].includes(s)) return 'Y';
  if (['n', 'no', 'x', '×', '아니오', 'false'].includes(s)) return 'N';
  return '';
}

/* 대분류 이름 → 프로젝트 id. 없으면 새 프로젝트를 만들고 새로 만든 이름을 created 배열에 담는다. */
function resolveProjectId(name, created) {
  const nm = String(name || '').trim();
  if (!nm) return state.projects[0] ? state.projects[0].id : 'default';
  const found = state.projects.find((p) => p.name.trim().toLowerCase() === nm.toLowerCase());
  if (found) return found.id;
  const color = PALETTE[state.projects.length % PALETTE.length];
  const id = 'cat-' + uid();
  state.projects.push({ id, name: nm, color });
  created.push(nm);
  return id;
}

/* 파싱된 표를 todos 레코드 배열로 변환 */
function sheetRowsToTodos(rows, createdProjects) {
  if (!rows.length) return [];
  // 머리글 행 감지: 위쪽 제목/사용법 병합행을 건너뛰고, 알려진 헤더가 3개 이상인 행을 머리글로 삼는다.
  let cols = null, dataStart = 0;
  const scan = Math.min(rows.length, 6);
  for (let i = 0; i < scan; i++) {
    const exactCount = rows[i].map(normHeaderKey).filter((h) => SHEET_HEADER_MAP[h]).length;
    if (exactCount >= 3) {
      cols = rows[i].map((c) => mapHeaderField(normHeaderKey(c)));
      dataStart = i + 1;
      break;
    }
  }
  let dataRows;
  if (cols) {
    dataRows = rows.slice(dataStart);
  } else {
    cols = SHEET_DEFAULT_COLS; // 머리글이 없으면 기본 열 순서로 간주
    dataRows = rows;
  }
  const recs = [];
  dataRows.forEach((r) => {
    const rec = {};
    cols.forEach((field, i) => { if (field) rec[field] = (r[i] != null ? String(r[i]).trim() : ''); });
    // 업무내용도 No도 없으면 빈 행으로 보고 건너뜀
    if (!rec.text && !rec.no) return;
    const status = normalizeStatus(rec.status);
    recs.push({
      no: rec.no ? parseInt(String(rec.no).replace(/[^\d]/g, ''), 10) || null : null,
      registeredDate: normalizeDate(rec.registeredDate),
      projectId: resolveProjectId(rec.project, createdProjects),
      channel: rec.channel || '',
      subChannel: rec.subChannel || '',
      priority: normalizePriority(rec.priority),
      text: rec.text || '',
      assignee: rec.assignee || '',
      dueDate: normalizeDate(rec.dueDate),
      status,
      needsCheck: normalizeCheck(rec.needsCheck),
      completedDate: normalizeDate(rec.completedDate),
      progress: rec.progress || '',
      remarks: rec.remarks || '',
      done: status === '완료' || status === '지연완료'
    });
  });
  return recs;
}

/* 텍스트를 받아 state.todos에 병합(No 기준 upsert). 결과 요약 객체 반환. */
function importSheetText(text, clearFirst) {
  const rows = parseDelimitedTable(text);
  const createdProjects = [];
  const recs = sheetRowsToTodos(rows, createdProjects);
  if (!recs.length) return { ok: false, error: '가져올 행을 찾지 못했어요. 표를 다시 복사해 붙여넣어 주세요.' };

  if (clearFirst) state.todos = [];
  const byNo = new Map();
  state.todos.forEach((t) => { if (t.no != null) byNo.set(t.no, t); });
  let maxNo = state.todos.reduce((m, t) => Math.max(m, t.no || 0), 0);

  let added = 0, updated = 0;
  recs.forEach((rec) => {
    let no = rec.no;
    const existing = no != null ? byNo.get(no) : null;
    if (existing) {
      Object.assign(existing, rec, { id: existing.id, no });
      updated++;
    } else {
      if (no == null) no = ++maxNo;
      const todo = Object.assign({ id: uid() }, rec, { no });
      state.todos.push(todo);
      byNo.set(no, todo);
      if (no > maxNo) maxNo = no;
      added++;
    }
  });

  // 가져온 중분류·소분류를 분류 트리에 병합 (소속 대분류는 사용 빈도로 추론)
  migrateTaxonomy(state);

  persist();
  renderAll();
  return { ok: true, added, updated, createdProjects, total: state.todos.length };
}

/* ---------- 설정 ---------- */
function setupSettings() {
  document.querySelectorAll('#themeSegment .segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.theme = btn.dataset.theme;
      applyTheme(); persist(); renderSettingsUI();
    });
  });
  document.getElementById('customAccentPicker').addEventListener('input', (e) => {
    state.settings.accent = e.target.value;
    applyTheme(); persist(); renderSettingsUI();
  });
  document.getElementById('exportBtn').addEventListener('click', async () => {
    const r = await window.api.exportBackup(state);
    if (r.ok) toast('백업 파일을 저장했어요');
  });
  document.getElementById('importBtn').addEventListener('click', async () => {
    const r = await window.api.importBackup();
    if (r.ok) { await snapshotBefore('backup-import'); state = r.data; migrateTaxonomy(state); await persist(); applyTheme(); renderAll(); if (typeof renderSnapshots === 'function') renderSnapshots(); toast('데이터를 불러왔어요'); }
  });

  const addChBtn = document.getElementById('addChannelBtn');
  const chInput = document.getElementById('newChannelInput');
  function addChannel() {
    const v = chInput.value.trim();
    if (!v) return;
    taxoInit();
    if (state.channels.includes(v)) { toast('이미 있는 중분류예요'); chInput.value = ''; return; }
    addMid(v);
    chInput.value = '';
    persist(); renderChannelSettings(); renderTodos();
    toast('중분류를 추가했어요');
  }
  if (addChBtn) addChBtn.addEventListener('click', addChannel);
  if (chInput) chInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addChannel(); } });

  // 대분류도 이 화면에서 만든다 (Projects 화면과 같은 모달을 쓴다)
  const addProjBtn = document.getElementById('addProjectFromCat');
  if (addProjBtn) addProjBtn.addEventListener('click', () => openProjectModal(null));

  // 소분류 공용 목록에 추가 → 곧바로 "어느 중분류에서 쓸지" 고르게 한다
  const addSubBtn = document.getElementById('addSubBtn');
  const subInput = document.getElementById('newSubInput');
  function addSubMaster() {
    const v = subInput.value.trim();
    if (!v) return;
    taxoInit();
    if (state.subMaster.includes(v)) { toast('이미 있는 소분류예요'); subInput.value = ''; return; }
    addSub(v);
    subInput.value = '';
    persist(); renderChannelSettings(); renderTodos();
    toast('소분류를 추가했어요');
  }
  if (addSubBtn) addSubBtn.addEventListener('click', addSubMaster);
  if (subInput) subInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSubMaster(); } });

  document.getElementById('sheetImportBtn').addEventListener('click', async () => {
    const area = document.getElementById('sheetPasteArea');
    const resultEl = document.getElementById('sheetImportResult');
    const clearFirst = document.getElementById('sheetClearFirst').checked;
    const text = area.value;
    resultEl.classList.remove('hidden', 'error');
    if (!text.trim()) {
      resultEl.classList.add('error');
      resultEl.textContent = '붙여넣은 내용이 없어요. 구글시트에서 표를 복사해 붙여넣어 주세요.';
      return;
    }
    await snapshotBefore('sheet-import');
    let r;
    try { r = importSheetText(text, clearFirst); }
    catch (e) { console.error(e); r = { ok: false, error: '가져오는 중 오류가 발생했어요: ' + String(e.message || e) }; }
    if (!r.ok) {
      resultEl.classList.add('error');
      resultEl.textContent = r.error;
      return;
    }
    const lines = [`가져오기 완료 — 새 항목 ${r.added}건 · 수정 ${r.updated}건 (전체 ${r.total}건)`];
    if (r.createdProjects.length) lines.push(`새 대분류 추가: ${r.createdProjects.join(', ')}`);
    resultEl.textContent = lines.join('\n');
    area.value = '';
    toast(`할 일 ${r.added + r.updated}건을 가져왔어요`);
  });
}

function renderSettingsUI() {
  document.querySelectorAll('#themeSegment .segmented-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === state.settings.theme);
  });
  const sw = document.getElementById('accentSwatches');
  sw.innerHTML = '';
  PALETTE.forEach((c) => {
    const s = document.createElement('div');
    s.className = 'swatch' + (c === state.settings.accent ? ' active' : '');
    s.style.background = c;
    s.onclick = () => { state.settings.accent = c; applyTheme(); persist(); renderSettingsUI(); };
    sw.appendChild(s);
  });
  document.getElementById('customAccentPicker').value = state.settings.accent;
  renderChannelSettings();
}

/* 중분류 통계 (관리 화면 배지용) */
function channelStat(c) {
  const items = state.todos.filter((t) => ((t.channel || '').trim()) === c);
  const st = (s) => items.filter((t) => todoStatus(t) === s).length;
  const today = todayStr();
  const overdue = items.filter((t) => !todoIsDone(t) && t.dueDate && t.dueDate < today).length;
  return { total: items.length, wait: st('대기'), active: st('진행중'), done: items.filter((t) => todoIsDone(t)).length, overdue };
}

/* 분류 체계를 대분류 > 중분류 > 소분류 트리로 렌더 */
/* 세 분류는 서로 독립이다. 한 거래처(중분류)에 정산 업무도 영업 업무도 있을 수 있으므로
   중분류를 대분류 하나에 묶지 않는다. 각 열은 자기 목록만 관리하고, 통계는 할 일에서 계산한다. */
function renderChannelSettings() {
  if (!document.getElementById('catProjList')) return;
  taxoInit();

  const sortSel = document.getElementById('channelSort');
  if (sortSel) sortSel.onchange = renderChannelSettings;
  const byName = sortSel && sortSel.value === 'name';

  const totalEl = document.getElementById('channelTotal');
  if (totalEl) totalEl.textContent = `대분류 ${state.projects.length}개 · 중분류 ${state.channels.length}개 · 소분류 ${state.subMaster.length}개`;

  renderCatProjects(byName);
  renderCatMids(byName);
  renderCatSubs(byName);
}

// 분류값별 할 일 통계 (미완료·지연 포함)
function catStat(pick, value) {
  const items = state.todos.filter((t) => (pick(t) || '').trim() === value);
  const today = todayStr();
  return {
    total: items.length,
    open: items.filter((t) => !todoIsDone(t)).length,
    overdue: items.filter((t) => !todoIsDone(t) && t.dueDate && t.dueDate < today).length
  };
}

function catRowHtml(key, label, color, st, acts) {
  return `<div class="cat-item" data-key="${escapeHtml(key)}">
    <span class="cat-dot" style="background:${color}"></span>
    <span class="cat-item-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
    <span class="cat-item-sub">할${st.total}${st.overdue ? ` · <b class="cat-over">지연${st.overdue}</b>` : ''}</span>
    <span class="cat-item-acts">${acts}</span>
  </div>`;
}

const CAT_ACTS = '<button class="icon-btn" data-act="view" title="이 분류 할 일 보기">🔍</button>'
  + '<button class="icon-btn" data-act="rename" title="이름 변경(할 일에 일괄 반영)">✏️</button>'
  + '<button class="icon-btn" data-act="del" title="목록에서 삭제">🗑</button>';

/* 1열: 대분류 (= Projects. 칸반·캘린더 색상과 공유한다) */
function renderCatProjects(byName) {
  const box = document.getElementById('catProjList');
  const countEl = document.getElementById('catCountProj');
  if (countEl) countEl.textContent = state.projects.length;

  const list = state.projects.slice().sort((a, b) => byName
    ? a.name.localeCompare(b.name)
    : state.todos.filter((t) => t.projectId === b.id).length - state.todos.filter((t) => t.projectId === a.id).length);

  box.innerHTML = list.map((p) => {
    const items = state.todos.filter((t) => t.projectId === p.id);
    const today = todayStr();
    const st = { total: items.length, overdue: items.filter((t) => !todoIsDone(t) && t.dueDate && t.dueDate < today).length };
    const acts = '<button class="icon-btn" data-act="view" title="이 대분류 할 일 보기">🔍</button>'
      + '<button class="icon-btn" data-act="edit" title="이름·색상 변경">✏️</button>';
    return catRowHtml(p.id, p.name, p.color || '#9b9a97', st, acts);
  }).join('') || '<div class="cat-col-empty">대분류가 없어요. 아래에서 추가하세요.</div>';

  box.querySelectorAll('.cat-item').forEach((el) => {
    const id = el.getAttribute('data-key');
    el.querySelector('[data-act="view"]').onclick = () => catJump('todoProjectFilter', id);
    el.querySelector('[data-act="edit"]').onclick = () => openProjectModal(byId(state.projects, id));
    el.onclick = (e) => { if (!e.target.closest('[data-act]')) openProjectModal(byId(state.projects, id)); };
  });
}

/* 2열: 중분류 (거래처·채널) */
function renderCatMids(byName) {
  const box = document.getElementById('catMidList');
  const countEl = document.getElementById('catCountMid');
  if (countEl) countEl.textContent = state.channels.length;

  const stat = (c) => catStat((t) => t.channel, c);
  const list = state.channels.slice().sort((a, b) => byName
    ? a.localeCompare(b) : (stat(b).total - stat(a).total || a.localeCompare(b)));

  box.innerHTML = list.map((c) => catRowHtml(c, c, channelColor(c), stat(c), CAT_ACTS)).join('')
    || '<div class="cat-col-empty">중분류가 없어요. 아래에서 추가하세요.</div>';

  box.querySelectorAll('.cat-item').forEach((el) => {
    const c = el.getAttribute('data-key');
    el.querySelector('[data-act="view"]').onclick = () => catJump('todoMidFilter', c);
    el.querySelector('[data-act="rename"]').onclick = () => midRename(c);
    el.querySelector('[data-act="del"]').onclick = () => channelDelete(c);
    el.onclick = (e) => { if (!e.target.closest('[data-act]')) midRename(c); };
  });
}

/* 3열: 소분류 */
function renderCatSubs(byName) {
  const box = document.getElementById('catSubList');
  const countEl = document.getElementById('catCountSub');
  if (countEl) countEl.textContent = state.subMaster.length;

  const stat = (sb) => catStat((t) => t.subChannel, sb);
  const list = state.subMaster.slice().sort((a, b) => byName
    ? a.localeCompare(b) : (stat(b).total - stat(a).total || a.localeCompare(b)));

  box.innerHTML = list.map((sb) => catRowHtml(sb, sb, '#c9c9c9', stat(sb), CAT_ACTS)).join('')
    || '<div class="cat-col-empty">소분류가 없어요. 아래에서 추가하세요.</div>';

  box.querySelectorAll('.cat-item').forEach((el) => {
    const sb = el.getAttribute('data-key');
    el.querySelector('[data-act="view"]').onclick = () => catJump('todoSubFilter', sb);
    el.querySelector('[data-act="rename"]').onclick = () => subRename(sb);
    el.querySelector('[data-act="del"]').onclick = () => subDeleteGlobal(sb);
    el.onclick = (e) => { if (!e.target.closest('[data-act]')) subRename(sb); };
  });
}

/* 중분류 이름·색상 변경 (이름을 바꾸면 할 일에 일괄 반영) */
function midRename(mid) {
  showModal({
    title: '중분류 수정',
    bodyHtml: `
      <div class="field"><label>이름</label><input type="text" id="f-mid-name" value="${escapeHtml(mid)}" /></div>
      <div class="field"><label>색상</label><input type="color" id="f-mid-color" value="${channelColor(mid)}" /></div>
      <p class="hint" style="margin:0">이름을 바꾸면 이 중분류를 쓰는 할 일 전체에 반영됩니다. 같은 이름이 이미 있으면 합쳐집니다.</p>`,
    onSave: () => {
      const name = document.getElementById('f-mid-name').value.trim();
      if (!name) { toast('이름을 입력해주세요'); return false; }
      setChannelColor(mid, document.getElementById('f-mid-color').value);
      if (name !== mid) channelApplyRename(mid, name);
      else { persist(); renderChannelSettings(); renderTodos(); refreshCalendarEvents(); }
      return true;
    }
  });
}

/* 소분류 이름 변경 — 할 일에 일괄 반영된다 */
function subRename(oldName) {
  const nv = (prompt('소분류 이름 변경 (이 소분류를 쓰는 할 일 전체에 반영됩니다)', oldName) || '').trim();
  if (!nv || nv === oldName) return;
  taxoInit();
  const merging = state.subMaster.includes(nv);
  const i = state.subMaster.indexOf(oldName);
  if (merging) { if (i > -1) state.subMaster.splice(i, 1); }
  else if (i > -1) state.subMaster[i] = nv;
  let n = 0;
  state.todos.forEach((t) => { if (((t.subChannel || '').trim()) === oldName) { t.subChannel = nv; n++; } });
  persist(); renderAll();
  toast(merging ? `"${oldName}"을(를) "${nv}"에 합쳤어요 (할 일 ${n}건)` : `소분류 이름을 바꿨어요 (할 일 ${n}건)`);
}

/* 소분류 삭제 — 목록에서만 빼고 할 일에 적힌 값은 남긴다 */
function subDeleteGlobal(sub) {
  taxoInit();
  const used = state.todos.filter((t) => ((t.subChannel || '').trim()) === sub).length;
  const i = state.subMaster.indexOf(sub);
  if (i > -1) state.subMaster.splice(i, 1);
  persist(); renderChannelSettings(); renderTodos();
  toast(used > 0 ? `"${sub}" 목록에서 제거 (할 일 ${used}건은 값 유지)` : `"${sub}" 삭제`);
}

/* 이 중분류만 걸러서 To-do 화면으로 (다른 분류 필터는 전체로 되돌린다) */
function catJump(field, value) {
  const btn = document.querySelector('.nav-btn[data-view="todos"]');
  if (btn) btn.click();
  const search = document.getElementById('todoSearch');
  if (search) search.value = '';
  renderTodos();   // 목록을 먼저 채운 뒤 값을 고른다
  ['todoProjectFilter', 'todoMidFilter', 'todoSubFilter'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  const target = document.getElementById(field);
  if (target && [...target.options].some((o) => o.value === value)) target.value = value;
  renderTodos();
}
function channelJump(c) { catJump('todoMidFilter', c); }

function channelApplyRename(oldName, nv) {
  if (!nv || nv === oldName) { renderChannelSettings(); return; }
  if (!Array.isArray(state.channels)) state.channels = [];
  const merging = state.channels.includes(nv);
  state.todos.forEach((t) => { if (((t.channel || '').trim()) === oldName) t.channel = nv; });
  const idx = state.channels.indexOf(oldName);
  if (merging) { if (idx > -1) state.channels.splice(idx, 1); }
  else if (idx > -1) state.channels[idx] = nv;
  // 색상 키 이전 (합치는 경우 대상 색 유지, 없으면 옛 색 승계)
  if (state.channelColors && state.channelColors[oldName]) {
    if (!merging || !state.channelColors[nv]) state.channelColors[nv] = state.channelColors[oldName];
    delete state.channelColors[oldName];
  }
  persist(); renderChannelSettings(); renderTodos(); refreshCalendarEvents();
  toast(merging ? `"${oldName}"을(를) "${nv}"에 합쳤어요` : '중분류 이름을 바꿨어요');
}

function channelDelete(c) {
  taxoInit();
  const used = state.todos.filter((t) => ((t.channel || '').trim()) === c).length;
  const i = state.channels.indexOf(c);
  if (i > -1) state.channels.splice(i, 1);
  if (state.channelColors) delete state.channelColors[c];
  persist(); renderChannelSettings(); renderTodos();
  toast(used > 0 ? `"${c}" 목록에서 제거 (할 일 ${used}건은 값 유지)` : `"${c}" 삭제`);
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.settings.theme);
  document.documentElement.style.setProperty('--accent', state.settings.accent);
  document.documentElement.style.setProperty('--accent-soft', state.settings.accent + '22');
}

/* 저장 충돌: 내가 읽은 뒤 다른 기기·탭이 먼저 저장한 경우.
   조용히 덮어쓰면 그쪽 작업이 통째로 날아가므로(실제 사고 있었음) 반드시 물어본다. */
function setupConflictHandler() {
  if (!window.CloudSync || !CloudSync.setConflictHandler) return;
  CloudSync.setConflictHandler((info) => new Promise((resolve) => {
    const sv = info && info.serverVersion ? new Date(info.serverVersion) : null;
    const when = sv ? sv.toLocaleString('ko-KR') : '알 수 없음';
    const sd = (info && info.data) || {};
    const cnt = (x) => (Array.isArray(x) ? x.length : 0);
    showModal({
      title: '⚠️ 다른 곳에서 먼저 저장했어요',
      saveLabel: '서버 것 불러오기',
      bodyHtml: `
        <p class="hint" style="margin-top:0">이 화면을 연 뒤에 <b>다른 기기나 탭</b>에서 저장이 있었어요(${escapeHtml(when)}).
        지금 그대로 저장하면 그쪽 작업이 <b>사라집니다</b>.</p>
        <div class="field"><label>서버에 있는 데이터</label>
          <div class="ro-view">할 일 ${cnt(sd.todos)}건 · 일정 ${cnt(sd.events)}건 · 중분류 ${cnt(sd.channels)}개 · 소분류 ${cnt(sd.subMaster)}개</div>
        </div>
        <div class="field"><label>이 화면(내 변경)</label>
          <div class="ro-view">할 일 ${cnt(state.todos)}건 · 일정 ${cnt(state.events)}건 · 중분류 ${cnt(state.channels)}개 · 소분류 ${cnt(state.subMaster)}개</div>
        </div>
        <p class="hint" style="margin:0"><b>서버 것 불러오기</b>를 누르면 이 화면의 변경은 버려집니다(권장).
        내 것이 확실히 최신이면 아래 <b>내 것으로 덮어쓰기</b>를 누르세요.</p>
        <button type="button" class="btn btn-danger" id="conflictOverwrite" style="margin-top:10px">내 것으로 덮어쓰기</button>`,
      onOpen: () => {
        const b = document.getElementById('conflictOverwrite');
        if (b) b.onclick = () => { closeModal(); resolve('overwrite'); };
      },
      onSave: () => {
        resolve('reload');
        setTimeout(async () => {
          state = await window.api.loadData();
          migrateTaxonomy(state);
          applyTheme(); renderAll();
          toast('서버의 최신 데이터를 불러왔어요');
        }, 0);
        return true;
      }
    });
  }));
}

/* ---------- 여러 기기 동기화 ---------- */
let syncInfo = { dir: null, isDefault: true };

async function handleSyncResult(r, successMsg) {
  if (!r) return;
  if (!r.ok) {
    if (r.error) toast(typeof r.error === 'string' && r.error.length < 80 ? r.error : '동기화 설정에 실패했어요');
    return;
  }
  state = r.data;
  migrateTaxonomy(state);
  applyTheme();
  renderAll();
  toast(successMsg);
}

function setupSync() {
  document.getElementById('startNewSyncBtn').addEventListener('click', async () => {
    const r = await window.api.startNewSyncFile();
    await handleSyncResult(r, '동기화 파일을 만들었어요. 다른 기기에서 "기존 동기화 파일 열기"로 이 파일을 선택해주세요.');
  });

  document.getElementById('openExistingSyncBtn').addEventListener('click', async () => {
    const r = await window.api.openExistingSyncFile();
    await handleSyncResult(r, '동기화 파일에 연결됐어요.');
  });

  document.getElementById('useLocalBtn').addEventListener('click', async () => {
    const r = await window.api.useLocalOnly();
    if (!r || !r.ok) return;
    state = r.data;
    migrateTaxonomy(state);
    applyTheme();
    renderAll();
    toast('이 기기에만 저장하도록 되돌렸어요.');
  });
}

async function renderSyncUI() {
  syncInfo = (await window.api.getSyncInfo()) || { dir: null, isDefault: true };
  const statusEl = document.getElementById('syncStatusText');
  const useLocalBtn = document.getElementById('useLocalBtn');
  if (syncInfo.unsupported) {
    statusEl.textContent = '이 브라우저는 파일 동기화를 지원하지 않아요 (크롬/엣지 권장)';
    useLocalBtn.classList.add('hidden');
  } else if (syncInfo.isDefault) {
    statusEl.textContent = '이 기기에만 저장 중';
    statusEl.title = '';
    useLocalBtn.classList.add('hidden');
  } else {
    statusEl.textContent = '동기화 중: ' + syncInfo.dir;
    statusEl.title = syncInfo.dir;
    useLocalBtn.classList.remove('hidden');
  }
}

/* ---------- 모달 공통 ---------- */
function setupModal() {
  document.getElementById('modalCloseBtn').onclick = closeModal;
  document.getElementById('modalCancelBtn').onclick = closeModal;
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  });
}

let currentModalHandlers = null;

function showModal({ title, bodyHtml, onSave, onDelete, onOpen, deletable, wide, saveLabel }) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBox').classList.toggle('modal-wide', !!wide);
  document.getElementById('modalSaveBtn').textContent = saveLabel || '저장';
  document.getElementById('modalBody').innerHTML = bodyHtml;
  const delBtn = document.getElementById('modalDeleteBtn');
  delBtn.classList.toggle('hidden', !deletable);
  document.getElementById('modalOverlay').classList.remove('hidden');
  currentModalHandlers = { onSave, onDelete };

  document.getElementById('modalSaveBtn').onclick = () => {
    if (currentModalHandlers.onSave() !== false) closeModal();
  };
  delBtn.onclick = () => {
    if (currentModalHandlers.onDelete) currentModalHandlers.onDelete();
    closeModal();
  };
  if (onOpen) onOpen();
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
  currentModalHandlers = null;
}

/* 스크롤하는 동안에만 스크롤바를 도톰하게 — CSS 의 .is-scrolling 훅.
   scroll 이벤트는 버블링하지 않으므로 캡처 단계에서 한 번만 받아 전역 처리한다.
   0.9초 쉬면 다시 실선으로 돌아간다. (모양은 전부 app.css 담당) */
function setupScrollReveal() {
  const timers = new WeakMap();
  document.addEventListener('scroll', (e) => {
    const el = e.target && e.target.classList ? e.target : document.documentElement;
    el.classList.add('is-scrolling');
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 900));
  }, true);
}

/* ---------- 시작 ---------- */
window.addEventListener('DOMContentLoaded', () => { setupScrollReveal(); init(); });

