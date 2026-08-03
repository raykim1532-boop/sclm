// 서버가 **앱 밖에서** 바뀌었을 때 앱의 저장이 그걸 지우지 않는지.
//
// 왜 필요한가 — 2026-08-03, 메일의 ✓ 로 완료 처리한 것이 앱에 의해 통째로 사라졌다.
// mail-action 은 정상 기록했고(확인 화면은 DB 쓰기 뒤에만 나온다), 열려 있던 앱이 덮어썼다.
// 앱이 아닌 경로(메일 원클릭·AI 비서·다른 노트북)로 서버가 바뀌는 일은 앞으로 더 늘어난다.
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const SRC = readFileSync(new URL('../../src/cloud-sync.js', import.meta.url), 'utf8');

/* cloud-sync.js 를 가짜 서버 위에서 통째로 돌린다.
   server.doc = 서버가 들고 있는 문서, server.version = updated_at 에 해당. */
function boot(opts = {}) {
  const server = {
    doc: opts.doc || { todos: [], events: [], projects: [] },
    version: opts.version == null ? 1000 : opts.version,
    puts: [],                       // 앱이 보낸 PUT 본문들
    offlineHeader: !!opts.offlineHeader,   // 서비스워커 캐시 응답 흉내
  };

  const store = { 'myscheduler:cloud:token': 'pw' };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  const res = (status, body, headers) => ({
    ok: status < 300, status,
    headers: { get: (k) => (headers || {})[k] || null },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });

  const fetchImpl = async (url, init) => {
    const method = (init && init.method) || 'GET';
    if (url === '/api/health') return res(200, { cloud: true });
    if (url === '/api/data' && method === 'GET') {
      return res(200, { data: server.doc, version: server.version },
        server.offlineHeader ? { 'X-SCLM-Offline': '1' } : {});
    }
    if (url === '/api/data' && method === 'PUT') {
      const body = JSON.parse(init.body);
      server.puts.push(body);
      // 서버의 충돌 감지: baseVersion 이 오고 서버 버전과 다르면 409 (force 면 통과)
      if (!body.force && typeof body.baseVersion === 'number' && body.baseVersion !== server.version) {
        return res(409, { error: 'conflict', data: server.doc, serverVersion: server.version });
      }
      const { baseVersion, force, ...data } = body;
      server.doc = JSON.parse(JSON.stringify(data));
      server.version += 1;
      return res(200, { ok: true, version: server.version });
    }
    return res(404, {});
  };

  const window = { api: { exportBackup() {}, importBackup() {} } };
  // cloud-sync.js 는 app.js 의 전역 uniqueChannels 를 쓴다(빌드하면 한 파일이 되므로).
  const uniqueChannels = (todos) => {
    const seen = [];
    (Array.isArray(todos) ? todos : []).forEach((t) => {
      const c = ((t && t.channel) || '').trim();
      if (c && !seen.includes(c)) seen.push(c);
    });
    return seen;
  };
  new Function('window', 'localStorage', 'location', 'fetch', 'document', 'navigator', 'uniqueChannels', SRC)(
    window, localStorage,
    { protocol: 'https:', href: 'https://sclm.pages.dev/', reload() {} },
    fetchImpl,
    { addEventListener() {}, querySelector: () => null, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }) },
    {},
    uniqueChannels
  );
  return { CloudSync: window.CloudSync, server, localStorage };
}

const TODO = (o) => Object.assign({ id: 't1', text: '엔터식스 공문', status: '대기', dueDate: '2026-08-03' }, o);
const findTodo = (doc, id) => (doc.todos || []).find((t) => t.id === id);

section('정상 경로 — 앱 밖 변경을 지우지 않는다');
{
  const { CloudSync, server } = boot({ doc: { todos: [TODO({}), TODO({ id: 't2', text: '다른 일' })], events: [], projects: [] } });
  const mine = await CloudSync.api.loadData();
  check('불러오기 성공', mine.todos.length === 2);
  check('서버 버전을 기억한다', CloudSync.getVersion() === 1000);

  // ── 앱 밖에서(메일 ✓) 서버가 바뀐다
  server.doc = JSON.parse(JSON.stringify(server.doc));
  const srvTodo = findTodo(server.doc, 't1');
  srvTodo.status = '완료'; srvTodo.done = true; srvTodo.completedDate = '2026-08-03';
  srvTodo.logs = [{ at: '2026-08-03', text: '메일에서 완료 처리' }];
  server.version = 1001;

  // ── 앱은 그 사실을 모른 채 다른 항목을 고쳐 저장한다
  findTodo(mine, 't2').text = '다른 일 (앱에서 수정)';
  const ok = await CloudSync.api.saveData(mine);

  check('저장 성공', ok === true);
  check('첫 PUT 에 baseVersion 을 실었다', typeof server.puts[0].baseVersion === 'number');
  check('409 → 재시도가 있었다', server.puts.length === 2);
  check('앱이 고친 것은 남는다', findTodo(server.doc, 't2').text === '다른 일 (앱에서 수정)');
  check('메일로 완료한 것도 남는다', findTodo(server.doc, 't1').status === '완료');
  check('완료 로그도 살아남는다', (findTodo(server.doc, 't1').logs || []).length === 1);
}

/* ---- baseVersion 을 모르는 상태 ----
   서비스워커 오프라인 캐시로 데이터를 받으면 lastLoadOnline=false → baseVersion 이 0으로 남는다.
   예전엔 그 상태로 저장하면 baseVersion 을 아예 안 실어 보내 충돌 감지가 통째로 꺼졌고,
   앱 밖(메일 ✓·AI 비서·다른 노트북)의 변경이 조용히 사라졌다. */

function outOfBand(doc) {
  const d = JSON.parse(JSON.stringify(doc));
  Object.assign(findTodo(d, 't1'), {
    status: '완료', done: true, completedDate: '2026-08-03',
    logs: [{ at: '2026-08-03', text: '메일에서 완료 처리' }],
  });
  return d;
}

section('버전을 모르면 조용히 덮어쓰지 않고 묻는다');
{
  const asked = [];
  const { CloudSync, server } = boot({
    doc: { todos: [TODO({})], events: [], projects: [] },
    offlineHeader: true,
  });
  CloudSync.setConflictHandler(async (info) => { asked.push(info); return 'reload'; });

  const mine = await CloudSync.api.loadData();
  check('캐시 응답은 온라인으로 치지 않는다', CloudSync.wasOnline() === false);
  check('그래서 서버 버전을 모른다', CloudSync.getVersion() === 0);

  server.offlineHeader = false;                    // 네트워크는 살아 있다
  server.doc = outOfBand(server.doc);
  server.version = 1001;

  const ok = await CloudSync.api.saveData(mine);

  check('덮어쓰지 않는다', ok === false);
  check('PUT 자체를 보내지 않았다', server.puts.length === 0);
  check('사용자에게 물었다', asked.length === 1);
  check('물어볼 때 서버 상태를 함께 준다', !!asked[0].data && asked[0].serverVersion === 1001);
  check('메일로 완료한 것이 살아남는다', findTodo(server.doc, 't1').status === '완료');
  check('로그도 그대로', (findTodo(server.doc, 't1').logs || []).length === 1);
  check('서버 버전을 따라잡는다', CloudSync.getVersion() === 1001);
}

section('사용자가 "내 것으로 덮어쓰기"를 고르면 그때는 덮어쓴다');
{
  const { CloudSync, server } = boot({
    doc: { todos: [TODO({})], events: [], projects: [] },
    offlineHeader: true,
  });
  CloudSync.setConflictHandler(async () => 'overwrite');

  const mine = await CloudSync.api.loadData();
  server.offlineHeader = false;
  server.doc = outOfBand(server.doc);
  server.version = 1001;

  const ok = await CloudSync.api.saveData(mine);
  check('저장된다', ok === true);
  check('사용자가 고른 대로 내 것이 남는다', findTodo(server.doc, 't1').status === '대기');
  check('force 로 보냈다', server.puts[0].force === true);
  check('그 뒤로는 버전을 안다', CloudSync.getVersion() > 0);
}

section('한 번 온라인으로 읽고 나면 다시 묻지 않는다');
{
  const { CloudSync, server } = boot({
    doc: { todos: [TODO({}), TODO({ id: 't2', text: '다른 일' })], events: [], projects: [] },
    offlineHeader: true,
  });
  let asked = 0;
  CloudSync.setConflictHandler(async () => { asked++; return 'reload'; });

  await CloudSync.api.loadData();                 // 캐시 로드 → 버전 모름
  server.offlineHeader = false;
  const mine = await CloudSync.api.loadData();    // 온라인 로드 → 버전·기준점 확보
  check('버전을 잡았다', CloudSync.getVersion() === 1000);

  server.doc = outOfBand(server.doc);
  server.version = 1001;
  findTodo(mine, 't2').text = '다른 일 (앱에서 수정)';
  const ok = await CloudSync.api.saveData(mine);

  check('저장 성공', ok === true);
  check('묻지 않고 자동 병합', asked === 0);
  check('양쪽 다 살아남는다',
    findTodo(server.doc, 't1').status === '완료' && findTodo(server.doc, 't2').text === '다른 일 (앱에서 수정)');
}

section('서버가 비어 있으면 그냥 올린다(최초 업로드)');
{
  const { CloudSync, server } = boot({ doc: null, version: 0 });
  server.doc = null;
  let asked = 0;
  CloudSync.setConflictHandler(async () => { asked++; return 'reload'; });
  const ok = await CloudSync.api.saveData({ todos: [TODO({})], events: [], projects: [] });
  check('업로드된다', ok === true);
  check('묻지 않는다', asked === 0);
}

section('온라인으로 다시 읽으면 회복된다');
{
  const { CloudSync, server } = boot({ doc: { todos: [TODO({})], events: [], projects: [] }, offlineHeader: true });
  await CloudSync.api.loadData();
  check('처음엔 버전 모름', CloudSync.getVersion() === 0);

  server.offlineHeader = false;             // 네트워크 복귀
  await CloudSync.api.loadData();
  check('다시 읽으면 버전을 잡는다', CloudSync.getVersion() === 1000);

  server.doc = JSON.parse(JSON.stringify(server.doc));
  Object.assign(findTodo(server.doc, 't1'), { status: '완료', done: true });
  server.version = 1001;
  await CloudSync.api.saveData(await CloudSync.api.loadData());
  check('그 뒤로는 보호된다', findTodo(server.doc, 't1').status === '완료');
}
