// 서명 링크 공용 헬퍼. 파일명이 _로 시작해 라우팅되지 않는다.
//
// 왜 필요한가 — 메일에서 누르는 링크는 **로그인 없이** 동작해야 한다(메일 앱은 앱 토큰을
// 모른다). 그래서 링크 자체에 위조 불가능한 서명을 실어 보내고, 서버가 그것만 믿는다.
// 키는 APP_PASSWORD 를 쓴다. 비밀번호 자체는 절대 링크에 실리지 않고 서명만 나간다.
//
// ⚠️ 만료를 반드시 넣을 것. 메일은 회사 메일함에 몇 년씩 남으므로, 만료가 없으면
//    오래된 메일을 잘못 눌러 지난 업무의 상태가 바뀐다.

const enc = new TextEncoder();

/* 서명 대상 문자열 — 순서가 바뀌면 서명도 달라져야 하므로 구분자를 넣어 잇는다. */
export const signPayload = (parts) => parts.map((p) => String(p == null ? '' : p)).join('|');

function b64url(buf) {
  let s = '';
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signParts(secret, parts) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(signPayload(parts))));
}

/* 서명 비교는 길이만 보고 빠져나가지 않도록 상수 시간으로 한다. */
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifyParts(secret, parts, sig) {
  if (!secret || !sig) return false;
  return safeEqual(await signParts(secret, parts), sig);
}
