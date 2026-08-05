// SCLM 메일 수신 워커 — 전달된 메일을 할 일로 만든다.
//
// Cloudflare Email Routing 이 지정한 주소로 온 메일을 이 워커에 넘긴다.
// 여기서는 **MIME 파싱만** 하고, 무엇을 할 일로 만들지는 전부 Pages 쪽
// `/api/mail-inbox` 가 정한다.
//
// 왜 이렇게 나눴나 — 이 워커는 도메인과 Email Routing 이 있어야 띄울 수 있어서
// 로컬 테스트가 안 된다. 업무 규칙을 Pages 로 몰아 두면 `mail-inbox.test.mjs` 에서
// 전부 검증할 수 있고, 여기 남는 건 "봉투를 뜯어 넘긴다" 뿐이라 틀릴 여지가 적다.
//
// 배포:
//   cd web/email-inbox && npm install && npx wrangler deploy
//   npx wrangler secret put CRON_SECRET      (Pages 쪽과 같은 값)
// 그다음 대시보드에서 Email Routing 규칙을 이 워커로 연결한다.
import PostalMime from 'postal-mime';

const MAX_FILES = 5;
const MAX_BYTES = 25 * 1024 * 1024;

/* ArrayBuffer → base64. 한 번에 String.fromCharCode(...arr) 하면 큰 첨부에서
   인자 개수 상한에 걸려 터지므로 조각내서 이어 붙인다. */
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function contentToBuffer(content) {
  if (content instanceof ArrayBuffer) return content;
  if (ArrayBuffer.isView(content)) return content.buffer;
  // postal-mime 이 문자열로 주는 경우(base64 로 이미 인코딩된 것)
  return null;
}

export default {
  async email(message, env, ctx) {
    const target = env.TARGET_URL;
    if (!target || !env.CRON_SECRET) {
      // 설정이 안 됐으면 메일을 삼키지 말고 그대로 보관함으로 넘긴다
      return message.forward(env.FALLBACK_TO || env.MAIL_TO || '');
    }

    let parsed;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (e) {
      return message.setReject('메일을 읽지 못했습니다');
    }

    const attachments = [];
    for (const a of (parsed.attachments || []).slice(0, MAX_FILES)) {
      // 본문에 박힌 이미지(서명 로고 등)는 첨부로 치지 않는다 — 매번 로고가 붙는다
      if (a.disposition === 'inline') continue;
      const buf = contentToBuffer(a.content);
      if (buf) {
        if (buf.byteLength > MAX_BYTES) continue;
        attachments.push({ filename: a.filename || 'file', mimeType: a.mimeType || '', content: toB64(buf) });
      } else if (typeof a.content === 'string' && a.content.length < MAX_BYTES) {
        attachments.push({ filename: a.filename || 'file', mimeType: a.mimeType || '', content: a.content });
      }
    }

    const payload = {
      // 봉투의 from 이 가장 믿을 만하다(헤더는 위조가 쉽다). 허용 여부 판단은 Pages 몫.
      from: message.from || (parsed.from && parsed.from.address) || '',
      subject: parsed.subject || '',
      text: parsed.text || stripHtml(parsed.html || ''),
      attachments,
    };

    let res;
    try {
      res = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': env.CRON_SECRET },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // 서버에 못 닿았으면 메일을 잃지 않도록 보관함으로 넘긴다
      return message.forward(env.FALLBACK_TO || env.MAIL_TO || '');
    }

    if (!res.ok) return message.forward(env.FALLBACK_TO || env.MAIL_TO || '');
  },
};

/* 평문이 없는 메일을 위한 최소한의 태그 제거 (본문 로그용이라 완벽할 필요는 없다) */
function stripHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ');
}
