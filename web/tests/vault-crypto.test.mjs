// 금고 암호화 — src/app.js 에 실제로 들어있는 함수를 추출해 검증한다.
// (브라우저용 조각이라 import가 불가능하므로 소스에서 떼어내 실행)
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const html = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const grab = (re) => { const m = html.match(re); if (!m) throw new Error('함수 추출 실패: ' + re); return m[0]; };

const src = [
  grab(/const VAULT_ITER = \d+;/),
  grab(/function vB64e\([\s\S]*?\n}/),
  grab(/function vB64d\([\s\S]*?\n}/),
  grab(/async function vaultDeriveKey\([\s\S]*?\n}/),
  grab(/function vaultGeneratePassword\([\s\S]*?\n}/),
].join('\n');

const api = new Function('crypto', 'TextEncoder', 'TextDecoder', src +
  '; return { VAULT_ITER, vB64e, vB64d, vaultDeriveKey, vaultGeneratePassword };'
)(globalThis.crypto, TextEncoder, TextDecoder);

// 앱의 vaultSave/잠금해제와 동일한 절차를 재현
async function seal(entries, password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const key = await api.vaultDeriveKey(password, salt, api.VAULT_ITER);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(entries)));
  return { v: 1, kdf: 'PBKDF2', iterations: api.VAULT_ITER, salt: api.vB64e(salt), iv: api.vB64e(iv), ct: api.vB64e(ct) };
}
async function open(blob, password) {
  const key = await api.vaultDeriveKey(password, api.vB64d(blob.salt), blob.iterations);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: api.vB64d(blob.iv) }, key, api.vB64d(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

const ENTRIES = [{ id: 'v1', site: '다우오피스', user: 'sungchul.kim', pass: 'p@ssw0rd-secret', url: 'gw.example.com' }];

section('암호화 왕복');
{
  const blob = await seal(ENTRIES, 'master1234');
  check('맞는 비밀번호 → 원문 복원', JSON.stringify(await open(blob, 'master1234')) === JSON.stringify(ENTRIES));
  let rejected = false;
  try { await open(blob, 'wrong-password'); } catch (e) { rejected = true; }
  check('틀린 비밀번호 → 복호화 거부', rejected);
  check('암호문에 평문 비밀번호 없음', !JSON.stringify(blob).includes('p@ssw0rd-secret'));
  check('암호문에 아이디도 노출되지 않음', !JSON.stringify(blob).includes('sungchul.kim'));
  check('반복 횟수 21만회 이상(PBKDF2)', blob.iterations >= 210000);
}

section('저장할 때마다 IV가 달라야 함');
{
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const a = await seal(ENTRIES, 'master1234', salt);
  const b = await seal(ENTRIES, 'master1234', salt);
  check('같은 내용·같은 salt라도 IV가 다름', a.iv !== b.iv);
  check('따라서 암호문도 다름', a.ct !== b.ct);
}

section('마스터 비밀번호 변경(전체 재암호화)');
{
  const before = await seal(ENTRIES, 'oldpass123');
  const entries = await open(before, 'oldpass123');       // 잠금 해제 상태의 메모리 항목
  const after = await seal(entries, 'newpass456');        // 새 키로 다시 저장
  check('새 비밀번호로 열림', JSON.stringify(await open(after, 'newpass456')) === JSON.stringify(ENTRIES));
  let oldRejected = false;
  try { await open(after, 'oldpass123'); } catch (e) { oldRejected = true; }
  check('옛 비밀번호로는 열리지 않음', oldRejected);
  check('salt도 새로 발급됨', before.salt !== after.salt);
}

section('비밀번호 생성기');
{
  const pws = Array.from({ length: 100 }, () => api.vaultGeneratePassword());
  check('길이 18자', pws.every((p) => p.length === 18));
  check('대/소/숫자/기호 모두 포함', pws.every((p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[!@#$%^&*\-_=+?]/.test(p)));
  check('혼동 문자(I,l,1,O,0) 제외', pws.every((p) => !/[Il1O0]/.test(p)));
  check('100개 전부 서로 다름', new Set(pws).size === 100);
}
