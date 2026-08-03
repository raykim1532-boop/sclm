// 아침 브리핑을 이메일로 보내는 모듈.
//
// 왜 Resend 인가 — Cloudflare Email Sending 은 **본인 소유 도메인**이 필요한데
// 이 프로젝트는 sclm.pages.dev 뿐이라 발신 도메인이 없다. Resend 무료 계정은
// 도메인 없이 `onboarding@resend.dev` 로 보낼 수 있고, 대신 **가입한 본인 주소로만**
// 발송된다. 본인만 받는 브리핑이라 그 제약이 오히려 딱 맞는다.
// ⚠️ 그래서 Resend 가입은 **받을 주소(회사 아웃룩)로** 해야 한다. 다른 주소로 가입하면
//    422/403 이 나고 메일이 안 간다.
//
// 필요한 시크릿(Pages sclm):
//   RESEND_API_KEY  — Resend 대시보드에서 발급
//   MAIL_TO         — 받을 주소(= Resend 가입 주소)
//   MAIL_FROM       — (선택) 기본값 'SCLM <onboarding@resend.dev>'

const SEND_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'SCLM <onboarding@resend.dev>';

export function mailConfigured(env) {
  return !!(env && env.RESEND_API_KEY && env.MAIL_TO);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mmdd = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.slice(5).replace('-', '/') : '');

/* 할 일 한 줄 (제목 앞의 [대괄호] 꼬리표는 떼고 보여 준다 — 푸시 본문과 같은 규칙) */
const shortText = (t) => String((t && t.text) || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();

/* 일정 시각 — 시간이 지정돼 있으면 HH:MM, 아니면 '종일' */
const evAt = (e) => (e && e.allDay === false && e.startTime ? String(e.startTime).slice(0, 5) : '종일');

/* computeSummary 결과 → 메일 본문 (순수 함수. 테스트에서 직접 부른다).
   푸시·카카오와 달리 길이 제한이 없으므로 **전부** 담는다 — 그게 메일로 받는 이유다. */
export function buildMailBody(s) {
  const sec = (title, rows) => {
    if (!rows.length) return '';
    return `<h3 style="margin:22px 0 8px;font-size:14px;color:#37352f">${esc(title)} <span style="color:#9b9a97;font-weight:400">${rows.length}건</span></h3>`
      + '<table style="width:100%;border-collapse:collapse;font-size:13px">'
      + rows.map((r) => `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#9b9a97;white-space:nowrap;width:64px">${esc(r.when)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(r.text)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#9b9a97;white-space:nowrap">${esc(r.tag)}</td>
        </tr>`).join('')
      + '</table>';
  };

  const daysLate = (due) => Math.max(0, Math.round((new Date(s.today) - new Date(due)) / 864e5));
  const tag = (t) => [t.channel, t.subChannel].filter(Boolean).join(' · ');

  const overdue = (s.overdueList || []).map((t) => ({ when: daysLate(t.dueDate) + '일', text: shortText(t), tag: tag(t) }));
  const today = (s.todayList || []).map((t) => ({ when: '오늘', text: shortText(t), tag: tag(t) }));
  const soon = (s.upcomingList || []).map((t) => ({ when: mmdd(t.dueDate), text: shortText(t), tag: tag(t) }));
  const events = (s.eventList || []).map((e) => ({ when: evAt(e), text: String(e.title || ''), tag: e.roCalName || '' }));

  const counts = [
    s.overdue ? `지연 ${s.overdue}` : '',
    s.dueToday ? `오늘 ${s.dueToday}` : '',
    s.upcoming ? `임박 ${s.upcoming}` : '',
    s.events ? `일정 ${s.events}` : '',
  ].filter(Boolean).join(' · ');

  const html = `<div style="font-family:-apple-system,'Malgun Gothic','Segoe UI',sans-serif;max-width:680px;color:#37352f">
    <div style="font-size:12px;color:#9b9a97">${esc(s.today)}</div>
    <h2 style="margin:4px 0 0;font-size:18px">오늘의 할 일과 일정</h2>
    <div style="margin:6px 0 0;font-size:13px;color:#9b9a97">${esc(counts || '알릴 것이 없어요')}</div>
    ${sec('⏰ 지연', overdue)}
    ${sec('📅 오늘 마감', today)}
    ${sec('🔜 임박', soon)}
    ${sec('🗓 오늘 일정', events)}
    <p style="margin:26px 0 0;font-size:12px;color:#9b9a97">
      <a href="https://sclm.pages.dev" style="color:#1a73e8">SCLM 열기</a> · 이 메일은 매일 아침 자동으로 발송됩니다.
    </p>
  </div>`;

  // 텍스트본도 함께 보낸다 — 일부 클라이언트가 평문만 보여 주고, 스팸 점수에도 유리하다
  const line = (r) => `- ${r.when}  ${r.text}${r.tag ? '  [' + r.tag + ']' : ''}`;
  const tsec = (title, rows) => (rows.length ? `\n${title} (${rows.length}건)\n` + rows.map(line).join('\n') + '\n' : '');
  const text = `${s.today}  오늘의 할 일과 일정\n${counts || '알릴 것이 없어요'}\n`
    + tsec('[지연]', overdue) + tsec('[오늘 마감]', today) + tsec('[임박]', soon) + tsec('[오늘 일정]', events)
    + '\nhttps://sclm.pages.dev';

  return { subject: `[SCLM] ${mmdd(s.today)} ${counts || '오늘 알릴 것 없음'}`, html, text };
}

/* 실제 발송. 설정이 없으면 조용히 건너뛴다(다른 채널을 막지 않는다). */
export async function sendBriefMail(env, summary) {
  if (!mailConfigured(env)) return { skipped: 'not_configured' };
  const { subject, html, text } = buildMailBody(summary);
  try {
    const r = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM || DEFAULT_FROM,
        to: [env.MAIL_TO],
        subject, html, text,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      // 가장 흔한 실패: Resend 가입 주소가 아닌 곳으로 보내려 함(도메인 미검증 계정 제약)
      return { ok: false, status: r.status, error: String(body.message || body.error || '').slice(0, 200) };
    }
    return { ok: true, id: body.id || '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}
