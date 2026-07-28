// 백업/복원 — 실제로 되돌아가는지, 되돌린 걸 다시 되돌릴 수 있는지 검증한다.
// (프로덕션 D1을 건드리지 않고 전체 사이클을 재현)
import { check, section, mockRequest } from './_helpers.mjs';
import { onRequestGet, onRequestPost } from '../functions/api/snapshots.js';

const PW = 'test-password';

// documents + snapshots 두 테이블을 흉내내는 D1 모의
function mockDB(store) {
  store.documents = store.documents || {};
  store.snapshots = store.snapshots || [];
  return {
    prepare(q) {
      return {
        _b: [],
        bind(...a) { this._b = a; return this; },
        async first() {
          if (/FROM documents/.test(q)) {
            const d = store.documents.main;
            return d ? { data: d } : null;
          }
          if (/FROM snapshots WHERE id/.test(q)) {
            const s = store.snapshots.find((x) => x.id === this._b[0]);
            return s ? { data: s.data } : null;
          }
          if (/created_at FROM snapshots ORDER BY/.test(q)) {
            const s = [...store.snapshots].sort((a, b) => b.created_at - a.created_at)[0];
            return s ? { created_at: s.created_at } : null;
          }
          return null;
        },
        async all() {
          const rows = [...store.snapshots]
            .sort((a, b) => b.created_at - a.created_at)
            .map(({ id, created_at, reason, summary }) => ({ id, created_at, reason, summary }));
          return { results: rows };
        },
        async run() {
          if (/INSERT INTO snapshots/.test(q)) {
            const [id, created_at, reason, summary, data] = this._b;
            store.snapshots.push({ id, created_at, reason, summary, data });
          } else if (/INSERT INTO documents/.test(q)) {
            store.documents.main = this._b[0];
          } else if (/DELETE FROM snapshots/.test(q)) {
            const keep = +((q.match(/LIMIT (\d+)/) || [])[1] || 20);
            store.snapshots = [...store.snapshots].sort((a, b) => b.created_at - a.created_at).slice(0, keep);
          }
          return {};
        },
      };
    },
  };
}

const ctx = (store, body) => ({
  env: { DB: mockDB(store), APP_PASSWORD: PW },
  request: mockRequest({ Authorization: 'Bearer ' + PW }, body),
});

const doc = (o) => JSON.stringify(Object.assign({ settings: {}, projects: [], events: [], todos: [], channels: [] }, o));
const todos = (n) => Array.from({ length: n }, (_, i) => ({ id: 't' + i, text: '업무' + i, status: '대기' }));

section('백업 생성');
{
  const store = { documents: { main: doc({ todos: todos(3) }) } };
  const j = await (await onRequestPost(ctx(store, { reason: 'manual', force: true }))).json();
  check('생성 성공 + id 반환', j.ok === true && typeof j.id === 'string');
  check('스냅샷 1건 저장', store.snapshots.length === 1);
  check('요약에 건수 기록', /할일 3/.test(store.snapshots[0].summary));

  // 같은 날 두 번째는 force 없이는 건너뛴다(자동 백업 폭주 방지)
  const j2 = await (await onRequestPost(ctx(store, { reason: 'auto' }))).json();
  check('같은 날 자동 백업은 skip', j2.skipped === true && store.snapshots.length === 1);
  const j3 = await (await onRequestPost(ctx(store, { reason: 'manual', force: true }))).json();
  check('force면 같은 날에도 생성', j3.ok === true && store.snapshots.length === 2);
}

section('복원 — 실제로 되돌아가는가');
{
  const store = { documents: { main: doc({ todos: todos(5) }) } };
  const made = await (await onRequestPost(ctx(store, { reason: 'before', force: true }))).json();

  // 사고 재현: 데이터가 1건으로 날아감
  store.documents.main = doc({ todos: todos(1) });
  check('사고 후 1건', JSON.parse(store.documents.main).todos.length === 1);

  const r = await (await onRequestPost(ctx(store, { action: 'restore', id: made.id }))).json();
  check('복원 응답 ok', r.ok === true && r.restored === true);
  check('5건으로 되돌아옴', JSON.parse(store.documents.main).todos.length === 5);
  check('복원 전 상태도 자동 백업됨(pre-restore)', store.snapshots.some((s) => s.reason === 'pre-restore'));

  // 복원을 다시 되돌리기(잘못 복원했을 때 탈출구가 있는가)
  const pre = store.snapshots.find((s) => s.reason === 'pre-restore');
  await onRequestPost(ctx(store, { action: 'restore', id: pre.id }));
  check('복원 직전 상태로 재복원 가능', JSON.parse(store.documents.main).todos.length === 1);
}

section('복원과 금고(Password 관리자)');
{
  const VAULT = { v: 1, salt: 's', iv: 'i', ct: 'cipher-text' };
  // 금고가 생기기 전에 찍힌 스냅샷
  const store = { documents: { main: doc({ todos: todos(2) }) } };
  const old = await (await onRequestPost(ctx(store, { force: true }))).json();

  // 이후 금고를 만들고 업무도 늘어난 상태
  store.documents.main = doc({ todos: todos(9), vault: VAULT });

  const r = await (await onRequestPost(ctx(store, { action: 'restore', id: old.id }))).json();
  const after = JSON.parse(store.documents.main);
  check('할 일은 예전 시점으로 복원', after.todos.length === 2);
  check('금고는 사라지지 않음', JSON.stringify(after.vault) === JSON.stringify(VAULT));
  check('금고를 유지했다고 알려줌', r.vaultKept === true);

  // 금고가 양쪽 모두 없으면 표시하지 않는다
  const store2 = { documents: { main: doc({ todos: todos(2) }) } };
  const s2 = await (await onRequestPost(ctx(store2, { force: true }))).json();
  const r2 = await (await onRequestPost(ctx(store2, { action: 'restore', id: s2.id }))).json();
  check('금고가 없으면 vaultKept false', r2.vaultKept === false);
}

section('보관 개수 제한(prune)');
{
  // 실제로는 백업 사이에 시간 간격이 있다. 루프로 만들면 created_at 이 같은 ms 로 겹쳐
  // 정렬 순서가 불확정해지므로 시계를 1분씩 진행시킨다.
  const realNow = Date.now;
  let t = Date.parse('2026-07-01T00:00:00Z');
  Date.now = () => (t += 60000);
  try {
    const store = { documents: { main: doc({ todos: todos(1) }) }, snapshots: [] };
    for (let i = 0; i < 25; i++) {
      store.documents.main = doc({ todos: todos(i + 1) });
      await onRequestPost(ctx(store, { reason: 'r' + i, force: true }));
    }
    check('최근 20건만 보관', store.snapshots.length === 20);
    check('가장 오래된 건이 밀려남', !store.snapshots.some((s) => s.reason === 'r0'));
    check('최신 건은 남아 있음', store.snapshots.some((s) => s.reason === 'r24'));
    check('20건이 연속 구간(r5~r24)', store.snapshots.every((s) => +s.reason.slice(1) >= 5));
  } finally { Date.now = realNow; }
}

section('목록·오류 처리');
{
  const store = { documents: { main: doc({ todos: todos(2) }) } };
  await onRequestPost(ctx(store, { reason: 'manual', force: true }));
  const list = await (await onRequestGet(ctx(store))).json();
  check('목록 조회 가능', Array.isArray(list.snapshots) && list.snapshots.length === 1);
  check('목록에 데이터 본문은 포함하지 않음', !('data' in list.snapshots[0]));

  const noId = await onRequestPost(ctx(store, { action: 'restore' }));
  check('id 없으면 400', noId.status === 400);
  const notFound = await onRequestPost(ctx(store, { action: 'restore', id: 'snap_nope' }));
  check('없는 id면 404', notFound.status === 404);
  check('실패해도 데이터는 그대로', JSON.parse(store.documents.main).todos.length === 2);

  // 인증
  const unauth = await onRequestPost({
    env: { DB: mockDB(store), APP_PASSWORD: PW },
    request: mockRequest({ Authorization: 'Bearer wrong' }, { force: true }),
  });
  check('비밀번호 틀리면 401', unauth.status === 401);
}
