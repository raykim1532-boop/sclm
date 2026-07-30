// 409 → 자동 병합 → 재저장 전체 경로. src/cloud-sync.js 를 통째로 가짜 브라우저 환경에서 돌린다.
// mergeStates 단위 테스트(merge-states)와 달리, 여기서는 base 스냅샷 추적과 force 재시도까지 본다.
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const SRC = readFileSync(new URL('../../src/cloud-sync.js', import.meta.url), 'utf8');

/* cloud-sync.js 는 window/localStorage/fetch 를 쓰는 IIFE 다. 필요한 만큼만 만들어 준다. */
function makeEnv(handler) {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url: String(url), body });
    const res = await handler(method, String(url), body, calls);
    return {
      ok: (res.status || 200) < 300,
      status: res.status || 200,
      headers: { get: (h) => (res.headers || {})[h] || null },
      async json() { return res.payload; },
      async text() { return JSON.stringify(res.payload); },
    };
  };
  const win = {};
  const fn = new Function('window', 'location', 'localStorage', 'fetch', 'document', 'console', 'uniqueChannels',
    SRC + '\n;return window.CloudSync;');
  const CloudSync = fn(
    win,
    { protocol: 'https:', reload() {} },
    localStorage,
    fetch,
    { createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, querySelector: () => null, addEventListener() {}, remove() {} }), body: { appendChild() {} } },
    { error() {}, warn() {}, log() {} },
    () => []
  );
  return { CloudSync, calls, store };
}

const T = (id, o) => Object.assign({ id, text: '업무 ' + id, status: '대기' }, o);
// 실제 앱의 state 는 ensureShape 를 거친 모양이므로 테스트 데이터도 같게 만든다
const doc = (todos, extra) => Object.assign({ todos, events: [], channels: [], subMaster: [], projects: [{ id: 'p', name: '일반' }], settings: { theme: 'light', accent: '#1a73e8' } }, extra || {});

section('두 기기 시나리오 — 자동으로 합치고 다시 저장한다');
{
  const server = { version: 1000, data: doc([T('1'), T('2'), T('3')]) };
  const env = makeEnv(async (method, url, body) => {
    if (method === 'GET' && url.includes('/api/data')) return { payload: { data: server.data, version: server.version } };
    if (method === 'PUT') {
      // 이 사이에 데스크탑이 먼저 저장해 서버가 바뀐 상황
      if (!body.force && body.baseVersion !== server.version) {
        return { status: 409, payload: { error: 'conflict', serverVersion: server.version, data: server.data } };
      }
      const saved = Object.assign({}, body);
      delete saved.baseVersion; delete saved.force;
      server.data = saved; server.version = 2000;
      return { payload: { ok: true, version: server.version } };
    }
    return { status: 404, payload: {} };
  });

  // 노트북: 아침 상태를 읽는다
  const loaded = await env.CloudSync.api.loadData();
  check('불러오기 성공', loaded.todos.length === 3);

  // 그 사이 데스크탑이 1번을 완료 처리하고 저장했다
  server.data = doc([T('1', { status: '완료' }), T('2'), T('3')]);
  server.version = 1500;

  // 노트북: 3번에 로그를 달고 4번을 추가해서 저장
  const mine = doc([T('1'), T('2'), T('3', { logs: [{ at: '2026-07-30', text: '메일 발송' }] }), T('4')]);
  const ok = await env.CloudSync.api.saveData(mine);
  check('저장 성공', ok === true);

  const puts = env.calls.filter((c) => c.method === 'PUT');
  check('PUT 2번(409 → 병합 후 재시도)', puts.length === 2);
  check('두 번째는 force', puts[1].body.force === true);

  const g = (id) => server.data.todos.find((t) => t.id === id);
  check('데스크탑의 완료가 살아 있다', g('1').status === '완료');
  check('노트북의 로그가 살아 있다', g('3').logs[0].text === '메일 발송');
  check('노트북이 추가한 4번도 있다', !!g('4'));
  check('총 4건', server.data.todos.length === 4);
}

section('충돌이 없으면 병합 경로를 타지 않는다');
{
  const server = { version: 1000, data: doc([T('1')]) };
  const env = makeEnv(async (method, url, body) => {
    if (method === 'GET') return { payload: { data: server.data, version: server.version } };
    if (method === 'PUT') {
      if (!body.force && body.baseVersion !== server.version) return { status: 409, payload: { serverVersion: server.version, data: server.data } };
      server.version = 2000;
      return { payload: { ok: true, version: server.version } };
    }
    return { status: 404, payload: {} };
  });
  await env.CloudSync.api.loadData();
  const ok = await env.CloudSync.api.saveData(doc([T('1'), T('2')]));
  check('한 번에 저장', ok === true && env.calls.filter((c) => c.method === 'PUT').length === 1);
  check('force 없이 저장', env.calls.filter((c) => c.method === 'PUT')[0].body.force === undefined);
}

section('금고를 양쪽에서 바꾸면 사용자에게 묻는다');
{
  const server = { version: 1000, data: doc([T('1')], { vault: { ct: 'BASE' } }) };
  const env = makeEnv(async (method, url, body) => {
    if (method === 'GET') return { payload: { data: server.data, version: server.version } };
    if (method === 'PUT') {
      if (!body.force && body.baseVersion !== server.version) return { status: 409, payload: { serverVersion: server.version, data: server.data } };
      server.version = 2000;
      return { payload: { ok: true, version: server.version } };
    }
    return { status: 404, payload: {} };
  });
  await env.CloudSync.api.loadData();
  server.data = doc([T('1')], { vault: { ct: 'THEIRS' } });
  server.version = 1500;

  let asked = 0;
  env.CloudSync.setConflictHandler(() => { asked++; return 'reload'; });
  await env.CloudSync.api.saveData(doc([T('1')], { vault: { ct: 'MINE' } }));
  check('물어봤다', asked === 1);
}

section('병합 결과를 앱에 알린다');
{
  const server = { version: 1000, data: doc([T('1')]) };
  const env = makeEnv(async (method, url, body) => {
    if (method === 'GET') return { payload: { data: server.data, version: server.version } };
    if (method === 'PUT') {
      if (!body.force && body.baseVersion !== server.version) return { status: 409, payload: { serverVersion: server.version, data: server.data } };
      const saved = Object.assign({}, body); delete saved.baseVersion; delete saved.force;
      server.data = saved; server.version = 2000;
      return { payload: { ok: true, version: server.version } };
    }
    return { status: 404, payload: {} };
  });
  await env.CloudSync.api.loadData();
  server.data = doc([T('1', { status: '보류' })]);
  server.version = 1500;

  let got = null;
  env.CloudSync.setMergeHandler((merged, conflicts) => { got = { merged, conflicts }; });
  await env.CloudSync.api.saveData(doc([T('1', { status: '완료' })]));
  check('병합 콜백이 불렸다', !!got);
  check('같은 항목 충돌이 보고됐다', got.conflicts.length === 1 && got.conflicts[0].why === 'both-edited');
  check('이 화면 것이 남았다', got.merged.todos[0].status === '완료');
}
