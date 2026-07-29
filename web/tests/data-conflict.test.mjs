// /api/data — 저장 충돌 감지 (버전 검사)
// 회귀 방지: 오래된 탭이 통짜 저장으로 다른 기기의 작업을 덮어쓰면 안 된다.
// 2026-07-29 실제로 할 일에 지정한 소분류가 이 경로로 사라졌다.
import { API, check, section, mockDB, mockRequest } from './_helpers.mjs';

const { onRequestPut, onRequestGet } = await import(API + 'data.js');

const V = 1000;   // 서버에 저장돼 있는 버전(updated_at)
const setup = () => {
  const docs = { main: JSON.stringify({ todos: [{ id: 'a', subChannel: '사방넷' }] }) };
  const versions = { main: V };
  return { docs, versions, env: { APP_PASSWORD: 'pw', DB: mockDB(docs, versions) } };
};
const put = (env, body) => onRequestPut({ env, request: mockRequest({ Authorization: 'Bearer pw' }, body) });
const get = (env) => onRequestGet({ env, request: mockRequest({ Authorization: 'Bearer pw' }) });

section('버전 내려주기');
{
  const { env } = setup();
  const r = await get(env);
  const j = await r.json();
  check('GET이 version을 함께 준다', j.version === V);
  check('데이터도 그대로', j.data.todos.length === 1);
}

section('오래된 버전으로 저장 → 409');
{
  const { docs, env } = setup();
  const r = await put(env, { todos: [], baseVersion: 500 });   // 500 < 1000 (오래된 탭)
  check('409 반환', r.status === 409);
  const j = await r.json();
  check('error=conflict', j.error === 'conflict');
  check('서버 버전 알려줌', j.serverVersion === V);
  check('서버 데이터도 함께 줌', j.data.todos[0].subChannel === '사방넷');
  check('⚠️ 저장은 막혔다', JSON.parse(docs.main).todos.length === 1);
}

section('최신 버전이면 통과');
{
  const { docs, env } = setup();
  const r = await put(env, { todos: [{ id: 'b' }], baseVersion: V });
  check('200 저장됨', r.status === 200);
  const j = await r.json();
  check('새 version 반환', typeof j.version === 'number' && j.version > 0);
  check('데이터 반영', JSON.parse(docs.main).todos[0].id === 'b');
  check('baseVersion은 저장되지 않음', JSON.parse(docs.main).baseVersion === undefined);
}

section('force면 덮어쓴다 (사용자가 명시 선택)');
{
  const { docs, env } = setup();
  const r = await put(env, { todos: [], baseVersion: 500, force: true });
  check('200 저장됨', r.status === 200);
  check('덮어쓰기 반영', JSON.parse(docs.main).todos.length === 0);
  check('force 플래그도 저장 안 됨', JSON.parse(docs.main).force === undefined);
}

section('구형 클라이언트 호환 (baseVersion 없이 저장)');
{
  const { docs, env } = setup();
  const r = await put(env, { todos: [{ id: 'c' }] });
  check('버전을 안 보내면 그대로 저장', r.status === 200 && JSON.parse(docs.main).todos[0].id === 'c');
}

section('충돌이어도 금고는 보존된다');
{
  const docs = { main: JSON.stringify({ todos: [], vault: { ct: 'SECRET' } }) };
  const versions = { main: V };
  const env = { APP_PASSWORD: 'pw', DB: mockDB(docs, versions) };
  // force 덮어쓰기 + vault 미포함 → 기존 암호문 유지 규칙이 계속 살아 있어야 한다
  await onRequestPut({ env, request: mockRequest({ Authorization: 'Bearer pw' }, { todos: [1], baseVersion: 1, force: true }) });
  check('force로 덮어써도 vault 유지', JSON.parse(docs.main).vault.ct === 'SECRET');
}
