// /api/data — 금고(vault) 보존 규칙
// 회귀 방지: 금고 생성 전에 열어둔 오래된 탭이 저장해도 암호문이 지워지면 안 된다(복구 불가).
import { API, check, section, mockDB, mockRequest } from './_helpers.mjs';

const { onRequestPut } = await import(API + 'data.js');

const VAULT = { v: 1, ct: 'SECRET_CIPHER', iv: 'iv', salt: 'salt', iterations: 210000 };
const setup = () => {
  const docs = { main: JSON.stringify({ todos: [1, 2], vault: VAULT }) };
  return { docs, env: { APP_PASSWORD: 'pw', DB: mockDB(docs) } };
};
const put = (env, body) => onRequestPut({ env, request: mockRequest({ Authorization: 'Bearer pw' }, body) });

section('금고 보존');
{
  const { docs, env } = setup();
  await put(env, { todos: [1, 2], settings: { theme: 'dark' } }); // vault 키 자체가 없는 저장
  const after = JSON.parse(docs.main);
  check('vault 없는 저장 → 기존 암호문 보존', after.vault && after.vault.ct === 'SECRET_CIPHER');
  check('나머지 필드는 정상 반영', after.settings.theme === 'dark');
}
{
  const { docs, env } = setup();
  await put(env, { todos: [1], vault: { ct: 'NEW_CIPHER' } });
  check('vault 포함 저장 → 새 암호문으로 갱신', JSON.parse(docs.main).vault.ct === 'NEW_CIPHER');
}
{
  const { docs, env } = setup();
  await put(env, { todos: [1], vault: null });
  check('vault:null → 명시적 삭제', !JSON.parse(docs.main).vault);
}
{
  const docs = { main: JSON.stringify({ todos: [] }) }; // 금고가 아예 없던 상태
  const env = { APP_PASSWORD: 'pw', DB: mockDB(docs) };
  await put(env, { todos: [], vault: { ct: 'FIRST' } });
  check('최초 금고 생성 정상 저장', JSON.parse(docs.main).vault.ct === 'FIRST');
}

section('인증');
{
  const { env } = setup();
  const r = await onRequestPut({ env, request: mockRequest({}, { todos: [] }) });
  check('인증 없음 → 401', r.status === 401);
}
{
  const { docs, env } = setup();
  const r = await onRequestPut({ env, request: { headers: { get: (k) => (k === 'Authorization' ? 'Bearer pw' : '') }, async text() { return '{invalid json'; } } });
  check('잘못된 JSON → 400', r.status === 400);
  check('잘못된 JSON은 저장하지 않음', JSON.parse(docs.main).vault.ct === 'SECRET_CIPHER');
}
