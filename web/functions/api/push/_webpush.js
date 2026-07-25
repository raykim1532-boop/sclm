// Web Push (RFC 8291 aes128gcm + VAPID) — WebCrypto only, works in Workers & Node 20+.
// 전송 로직 한 곳. subscribe/test/run-daily 및 별도 Cron 워커에서 공용으로 사용.

// VAPID 공개키(공개값). 개인키(JWK)는 env.VAPID_PRIVATE_KEY(secret)로 주입.
export const VAPID_PUBLIC = 'BAAEnE9TX5dzdS79zuw2AJcANU-HQmCZWDb7paanIbjdIKSmwT0IwONF3RYSNAcHQ8EYrSgYuCB9CZLwOi_kDmU';

const enc = new TextEncoder();

export function b64urlToBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(bytes) {
  let bin = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concat(...arrs) {
  let len = 0; arrs.forEach((a) => (len += a.length));
  const out = new Uint8Array(len); let o = 0;
  arrs.forEach((a) => { out.set(a, o); o += a.length; });
  return out;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8
  );
  return new Uint8Array(bits);
}

// ---- VAPID JWT (ES256) ----
export async function importVapidPrivateKey(jwkStr) {
  let raw = jwkStr;
  if (typeof raw === 'string' && raw.trim()[0] !== '{') {
    // base64(JSON) 형태 허용 — 셸에서 따옴표 없이 붙여넣기 쉽게
    try { raw = new TextDecoder().decode(b64urlToBytes(raw.trim())); } catch (e) {}
  }
  const jwk = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
}
export async function vapidAuthHeader(endpoint, privKey, subject) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject || 'mailto:raykim1532@gmail.com'
  })));
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privKey, enc.encode(signingInput)
  );
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${VAPID_PUBLIC}`;
}

// ---- 페이로드 암호화 (aes128gcm) ----
export async function encryptPayload(p256dhB64, authB64, plaintext) {
  const uaPublic = b64urlToBytes(p256dhB64);       // 65 bytes
  const authSecret = b64urlToBytes(authB64);       // 16 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 서버(발신) 임시 ECDH 키쌍
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info"||0x00||ua||as, 32)
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhBits, keyInfo, 32);

  // CEK / NONCE (RFC 8188, salt=salt16)
  const cek = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // 단일 레코드: plaintext || 0x02 (마지막 레코드 구분자)
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  // aes128gcm 헤더: salt(16) || rs(4, BE) || idlen(1) || keyid(as_public 65) || ciphertext
  const rs = new Uint8Array([0, 0, 0x10, 0x00]); // 4096
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ct);
}

// ---- 전송 ----
export async function sendPush(env, sub, payloadObj) {
  const privKey = await importVapidPrivateKey(env.VAPID_PRIVATE_KEY);
  const subject = env.VAPID_SUBJECT || 'mailto:raykim1532@gmail.com';
  const auth = await vapidAuthHeader(sub.endpoint, privKey, subject);
  const body = await encryptPayload(sub.p256dh, sub.auth, enc.encode(JSON.stringify(payloadObj)));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400'
    },
    body
  });
  return r;
}
