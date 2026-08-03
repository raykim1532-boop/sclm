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
const APP_URL = 'https://sclm.pages.dev';

/* 메일에서 누르면 그 항목이 바로 열리는 주소. 앱의 openFromUrl() 이 받는다. */
const todoLink = (t) => APP_URL + '/?todo=' + encodeURIComponent((t && t.id) || '');
const eventLink = (e) => APP_URL + '/?event=' + encodeURIComponent((e && e.id) || '');
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
/* s: computeSummary 결과. done: { 할일id → 완료 링크 } (없으면 ✓ 칸을 안 그린다).
   ⚠️ 링크 생성은 서명(비동기·env 필요)이라 여기서 만들지 않고 **받아서 쓴다** — 그래야
      본문 생성이 순수 함수로 남아 테스트에서 그대로 부를 수 있다. */
export function buildMailBody(s, done) {
  const doneUrl = (id) => (done && done[id]) || '';
  const sec = (title, rows) => {
    if (!rows.length) return '';
    return `<h3 style="margin:22px 0 8px;font-size:14px;color:#37352f">${esc(title)} <span style="color:#9b9a97;font-weight:400">${rows.length}건</span></h3>`
      + '<table style="width:100%;border-collapse:collapse;font-size:13px">'
      + rows.map((r) => `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#9b9a97;white-space:nowrap;width:64px">${esc(r.when)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${r.link
            ? `<a href="${esc(r.link)}" style="color:#37352f;text-decoration:none">${esc(r.text)}</a>`
            : esc(r.text)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#9b9a97;white-space:nowrap">${esc(r.tag)}</td>
          ${r.done ? `<td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap;width:74px;text-align:right"><a href="${esc(r.done)}" title="완료 처리" style="display:inline-block;padding:7px 12px;border:1px solid #1a73e8;border-radius:6px;color:#1a73e8;text-decoration:none;font-weight:700;font-size:12px;line-height:1">✓ 완료</a></td>` : ''}
        </tr>`).join('')
      + '</table>';
  };

  const daysLate = (due) => Math.max(0, Math.round((new Date(s.today) - new Date(due)) / 864e5));
  const tag = (t) => [t.channel, t.subChannel].filter(Boolean).join(' · ');

  const overdue = (s.overdueList || []).map((t) => ({ when: daysLate(t.dueDate) + '일', text: shortText(t), tag: tag(t), link: todoLink(t), done: doneUrl(t.id) }));
  const today = (s.todayList || []).map((t) => ({ when: '오늘', text: shortText(t), tag: tag(t), link: todoLink(t), done: doneUrl(t.id) }));
  const soon = (s.upcomingList || []).map((t) => ({ when: mmdd(t.dueDate), text: shortText(t), tag: tag(t), link: todoLink(t), done: doneUrl(t.id) }));
  const events = (s.eventList || []).map((e) => ({ when: evAt(e), text: String(e.title || ''), tag: e.roCalName || '', link: eventLink(e) }));

  const counts = [
    s.overdue ? `지연 ${s.overdue}` : '',
    s.dueToday ? `오늘 ${s.dueToday}` : '',
    s.upcoming ? `임박 ${s.upcoming}` : '',
    s.events ? `일정 ${s.events}` : '',
  ].filter(Boolean).join(' · ');

  // 같은 분류에서 반복해서 밀리는 게 보이면 한 줄 알린다 — 한 건씩 보면 안 보이는 경향이다
  const stuck = (s.stuckList || []).slice(0, 3);
  const stuckHtml = stuck.length
    ? `<div style="margin:18px 0 0;padding:10px 12px;border-radius:8px;background:#fff4e5;border:1px solid #ffd8a8;font-size:13px">
        <b>⚠ 계속 밀리는 분류</b><br>
        ${stuck.map((x) => `${esc(x.name)} — 지연 ${x.overdue}건 / 전체 ${x.total} · 평균 ${x.avgLate}일 밀림`).join('<br>')}
      </div>`
    : '';

  const html = `<div style="font-family:-apple-system,'Malgun Gothic','Segoe UI',sans-serif;max-width:680px;color:#37352f">
    <div style="font-size:12px;color:#9b9a97">${esc(s.today)}</div>
    <h2 style="margin:4px 0 0;font-size:18px">오늘의 할 일과 일정</h2>
    <div style="margin:6px 0 0;font-size:13px;color:#9b9a97">${esc(counts || '알릴 것이 없어요')}</div>
    ${stuckHtml}
    ${sec('⏰ 지연', overdue)}
    ${sec('📅 오늘 마감', today)}
    ${sec('🔜 임박', soon)}
    ${sec('🗓 오늘 일정', events)}
    <p style="margin:26px 0 0;font-size:12px;color:#9b9a97">
      ${done ? '오른쪽 <b style="color:#1a73e8">✓</b> 를 누르면 앱을 열지 않고 바로 완료 처리됩니다(확인 화면 한 번 거침).<br>' : ''}
      <a href="https://sclm.pages.dev" style="color:#1a73e8">SCLM 열기</a> · 이 메일은 매일 아침 자동으로 발송됩니다.
    </p>
  </div>`;

  // 텍스트본도 함께 보낸다 — 일부 클라이언트가 평문만 보여 주고, 스팸 점수에도 유리하다
  const line = (r) => `- ${r.when}  ${r.text}${r.tag ? '  [' + r.tag + ']' : ''}`;
  const tsec = (title, rows) => (rows.length ? `\n${title} (${rows.length}건)\n` + rows.map(line).join('\n') + '\n' : '');
  const stuckText = stuck.length ? '\n[계속 밀리는 분류]\n' + stuck.map((x) => `- ${x.name}  지연 ${x.overdue}건 / 전체 ${x.total} · 평균 ${x.avgLate}일 밀림`).join('\n') + '\n' : '';
  const text = `${s.today}  오늘의 할 일과 일정\n${counts || '알릴 것이 없어요'}\n` + stuckText
    + tsec('[지연]', overdue) + tsec('[오늘 마감]', today) + tsec('[임박]', soon) + tsec('[오늘 일정]', events)
    + '\nhttps://sclm.pages.dev';

  return { subject: `[SCLM] ${mmdd(s.today)} ${counts || '오늘 알릴 것 없음'}`, html, text };
}

/* 금요일 주간 요약 메일 본문 (순수 함수).
   아침 브리핑이 "오늘 뭘 하나"라면 이건 "이번 주에 뭘 했고 다음 주에 뭐가 오나"다. */
export function buildWeeklyMailBody(w, hasBackup) {
  const tag = (t) => [t.channel, t.subChannel].filter(Boolean).join(' · ');
  const daysLate = (due) => Math.max(0, Math.round((new Date(w.today) - new Date(due)) / 864e5));

  const sec = (title, rows) => {
    if (!rows.length) return `<h3 style="margin:22px 0 8px;font-size:14px">${esc(title)} <span style="color:#9b9a97;font-weight:400">없음</span></h3>`;
    return `<h3 style="margin:22px 0 8px;font-size:14px;color:#37352f">${esc(title)} <span style="color:#9b9a97;font-weight:400">${rows.length}건</span></h3>`
      + '<table style="width:100%;border-collapse:collapse;font-size:13px">'
      + rows.map((r) => `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#9b9a97;white-space:nowrap;width:64px">${esc(r.when)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee"><a href="${esc(r.link)}" style="color:#37352f;text-decoration:none">${esc(r.text)}</a></td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#9b9a97;white-space:nowrap">${esc(r.tag)}</td>
        </tr>`).join('')
      + '</table>';
  };

  const done = (w.doneList || []).map((t) => ({ when: mmdd(t.completedDate), text: shortText(t), tag: tag(t), link: todoLink(t) }));
  const next = (w.nextList || []).map((t) => ({ when: mmdd(t.dueDate), text: shortText(t), tag: tag(t), link: todoLink(t) }));
  const late = (w.lateList || []).map((t) => ({ when: daysLate(t.dueDate) + '일', text: shortText(t), tag: tag(t), link: todoLink(t) }));

  const html = `<div style="font-family:-apple-system,'Malgun Gothic','Segoe UI',sans-serif;max-width:680px;color:#37352f">
    <div style="font-size:12px;color:#9b9a97">${esc(w.week.start)} ~ ${esc(w.week.end)}</div>
    <h2 style="margin:4px 0 0;font-size:18px">주간 리포트</h2>
    <div style="margin:6px 0 0;font-size:13px;color:#9b9a97">완료 ${w.done} · 다음 주 마감 ${w.next} · 아직 지연 ${w.late}</div>
    ${sec('✅ 이번 주 완료', done)}
    ${sec('🔜 다음 주 마감 예정', next)}
    ${sec('⏰ 아직 지연', late)}
    <p style="margin:26px 0 0;font-size:12px;color:#9b9a97">
      ${hasBackup ? '이 메일에 <b>이번 주 백업</b>(JSON·CSV)이 첨부돼 있습니다. 지우지 말고 두면 메일함이 그대로 예비 보관소가 됩니다.<br>' : ''}
      <a href="${APP_URL}" style="color:#1a73e8">SCLM 열기</a> · 매주 금요일 아침에 보냅니다.
    </p>
  </div>`;

  const line = (r) => `- ${r.when}  ${r.text}${r.tag ? ' [' + r.tag + ']' : ''}`;
  const tsec = (title, rows) => `\n${title} (${rows.length}건)\n` + (rows.length ? rows.map(line).join('\n') : '- (없음)') + '\n';
  const text = `주간 리포트  ${w.week.start} ~ ${w.week.end}\n완료 ${w.done} · 다음 주 마감 ${w.next} · 아직 지연 ${w.late}\n`
    + tsec('[이번 주 완료]', done) + tsec('[다음 주 마감 예정]', next) + tsec('[아직 지연]', late)
    + '\n' + APP_URL;

  return { subject: `[SCLM] 주간 리포트 ${mmdd(w.week.start)}~${mmdd(w.week.end)} · 완료 ${w.done} · 지연 ${w.late}`, html, text };
}

/* 매월 1일 아침에 보내는 지난달 결산 (순수 함수).
   주간이 "이번 주에 뭘 했나"라면 이건 "지난달을 어떻게 보냈나"다. */
export function buildMonthlyMailBody(m) {
  const label = m.month.key.replace('-', '년 ') + '월';
  const tag = (t) => [t.channel, t.subChannel].filter(Boolean).join(' · ');

  const stat = (label2, value, sub) => `
    <td style="padding:10px 12px;border:1px solid #eee;border-radius:8px;vertical-align:top">
      <div style="font-size:11px;color:#9b9a97">${esc(label2)}</div>
      <div style="font-size:19px;font-weight:700;margin-top:2px">${esc(value)}</div>
      <div style="font-size:11px;color:#9b9a97">${esc(sub || '')}</div>
    </td>`;

  const rank = (title, rows) => {
    if (!rows.length) return '';
    const max = rows[0].count || 1;
    return `<h3 style="margin:22px 0 8px;font-size:14px">${esc(title)}</h3>`
      + '<table style="width:100%;border-collapse:collapse;font-size:13px">'
      + rows.map((r) => `<tr>
          <td style="padding:5px 8px;width:38%">${esc(r.name)}</td>
          <td style="padding:5px 8px">
            <div style="height:8px;border-radius:4px;background:#1a73e8;width:${Math.round(r.count / max * 100)}%;min-width:4px"></div>
          </td>
          <td style="padding:5px 8px;width:48px;text-align:right;color:#9b9a97">${r.count}건</td>
        </tr>`).join('')
      + '</table>';
  };

  const list = (title, rows, when) => {
    if (!rows.length) return `<h3 style="margin:22px 0 8px;font-size:14px">${esc(title)} <span style="color:#9b9a97;font-weight:400">없음</span></h3>`;
    return `<h3 style="margin:22px 0 8px;font-size:14px">${esc(title)} <span style="color:#9b9a97;font-weight:400">${rows.length}건</span></h3>`
      + '<table style="width:100%;border-collapse:collapse;font-size:13px">'
      + rows.map((t) => `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#9b9a97;white-space:nowrap;width:64px">${esc(when(t))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee"><a href="${esc(todoLink(t))}" style="color:#37352f;text-decoration:none">${esc(shortText(t))}</a></td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#9b9a97;white-space:nowrap">${esc(tag(t))}</td>
        </tr>`).join('')
      + '</table>';
  };

  const html = `<div style="font-family:-apple-system,'Malgun Gothic','Segoe UI',sans-serif;max-width:680px;color:#37352f">
    <div style="font-size:12px;color:#9b9a97">${esc(m.month.start)} ~ ${esc(m.month.end)}</div>
    <h2 style="margin:4px 0 14px;font-size:18px">${esc(label)} 결산</h2>
    <table style="width:100%;border-collapse:separate;border-spacing:6px 0"><tr>
      ${stat('완료', m.done + '건', '')}
      ${stat('기한 준수', m.onTimeRate == null ? '—' : m.onTimeRate + '%', m.onTimeBase ? m.onTimeBase + '건 기준' : '마감일 있는 건 없음')}
      ${stat('평균 소요', m.avgLead == null ? '—' : m.avgLead + '일', '등록 → 완료')}
      ${stat('넘어온 일', m.carried + '건', '지난달 마감, 아직 미완료')}
    </tr></table>
    ${rank('대분류별 완료', m.byProject || [])}
    ${rank('중분류별 완료', m.byChannel || [])}
    ${list('⏰ 이번 달로 넘어온 일', m.carriedList || [], (t) => mmdd(t.dueDate))}
    ${list('✅ 지난달 완료', m.doneList || [], (t) => mmdd(t.completedDate))}
    <p style="margin:26px 0 0;font-size:12px;color:#9b9a97">
      <a href="${APP_URL}" style="color:#1a73e8">SCLM 열기</a> · 매월 1일 아침에 보냅니다.
    </p>
  </div>`;

  // ⚠️ 삼항연산자를 + 사이에 끼워 넣지 말 것 — + 가 먼저 묶여 본문이 통째로 날아간다.
  const lline = (t, when) => `- ${when}  ${shortText(t)}${tag(t) ? ' [' + tag(t) + ']' : ''}`;
  const tsecRank = (title, rows) => (rows.length ? `\n[${title}]\n` + rows.map((r) => `- ${r.name}  ${r.count}건`).join('\n') + '\n' : '');
  const tsecList = (title, rows, when) => `\n[${title}]\n`
    + (rows.length ? rows.map((t) => lline(t, when(t))).join('\n') : '- (없음)') + '\n';
  const text = [
    `${label} 결산  ${m.month.start} ~ ${m.month.end}`,
    `완료 ${m.done} · 기한 준수 ${m.onTimeRate == null ? '—' : m.onTimeRate + '%'} · 평균 소요 ${m.avgLead == null ? '—' : m.avgLead + '일'} · 넘어온 일 ${m.carried}`,
  ].join('\n')
    + tsecRank('대분류별 완료', m.byProject || [])
    + tsecRank('중분류별 완료', m.byChannel || [])
    + tsecList('이번 달로 넘어온 일', m.carriedList || [], (t) => mmdd(t.dueDate))
    + tsecList('지난달 완료', m.doneList || [], (t) => mmdd(t.completedDate))
    + '\n' + APP_URL;

  return { subject: `[SCLM] ${label} 결산 · 완료 ${m.done} · 넘어온 일 ${m.carried}`, html, text };
}

export async function sendMonthlyMail(env, monthly) {
  if (!mailConfigured(env)) return { skipped: 'not_configured' };
  const { subject, html, text } = buildMonthlyMailBody(monthly);
  try {
    const r = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || DEFAULT_FROM, to: [env.MAIL_TO], subject, html, text }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: String(body.message || body.error || '').slice(0, 200) };
    return { ok: true, id: body.id || '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/* ---- 고장 감시 ----
   조용히 망가지는 게 이 시스템의 가장 큰 위험이다. 크론이 안 돌면 알림이 안 오는데,
   "알림이 안 온다"와 "오늘은 알릴 게 없다"가 겉보기에 똑같아서 며칠씩 모르고 지나간다
   (실제로 GitHub Actions 가 9시간씩 지각하던 것도 이틀 뒤에야 알았다).
   ⚠️ **문제가 있을 때만** 보낸다. 매일 "이상 없음"을 보내면 읽지 않게 되고,
      그러면 진짜 이상이 왔을 때도 안 읽는다. */
export function buildAlertMailBody(issues, todayIso) {
  const rows = (issues || []).map((x) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;vertical-align:top">${esc(x.icon || '⚠️')}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">
        <b>${esc(x.title)}</b><br><span style="color:#9b9a97;font-size:12px">${esc(x.detail || '')}</span>
      </td>
    </tr>`).join('');

  const html = `<div style="font-family:-apple-system,'Malgun Gothic','Segoe UI',sans-serif;max-width:640px;color:#37352f">
    <div style="font-size:12px;color:#9b9a97">${esc(todayIso || '')}</div>
    <h2 style="margin:4px 0 4px;font-size:18px">⚠️ SCLM 점검이 필요합니다</h2>
    <div style="margin:0 0 14px;font-size:13px;color:#9b9a97">아래 ${(issues || []).length}건은 자동으로 복구되지 않을 수 있습니다.</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">${rows}</table>
    <p style="margin:24px 0 0;font-size:12px;color:#9b9a97">
      이 메일은 <b>문제가 감지된 날에만</b> 발송됩니다. 아무 일 없으면 오지 않습니다.<br>
      <a href="${APP_URL}" style="color:#1a73e8">SCLM 열기</a>
    </p>
  </div>`;

  const text = `SCLM 점검 필요 (${(issues || []).length}건)  ${todayIso || ''}\n\n`
    + (issues || []).map((x) => `- ${x.title}\n  ${x.detail || ''}`).join('\n') + '\n\n' + APP_URL;

  return { subject: `[SCLM] ⚠️ 점검 필요 ${(issues || []).length}건`, html, text };
}

export async function sendAlertMail(env, issues, todayIso) {
  if (!mailConfigured(env)) return { skipped: 'not_configured' };
  if (!issues || !issues.length) return { skipped: 'no_issues' };
  const { subject, html, text } = buildAlertMailBody(issues, todayIso);
  try {
    const r = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || DEFAULT_FROM, to: [env.MAIL_TO], subject, html, text }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: String(body.message || body.error || '').slice(0, 200) };
    return { ok: true, id: body.id || '', count: issues.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/* ---- 주간 백업 첨부 ----
   왜 — 지금 백업은 전부 Cloudflare D1 안에만 있다. 계정이 잠기거나 사라지면 백업도 같이
   사라진다. 주간 메일에 붙여 두면 **회사 메일함이 그대로 오프사이트 백업**이 된다.
   JSON 은 복원용(앱의 가져오기가 그대로 받는다), CSV 는 눈으로 보고 엑셀에서 여는 용도. */

const b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

export function buildTodosCsv(state) {
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const pname = (id) => (projects.find((p) => p && p.id === id) || {}).name || '';
  const head = ['등록일', '업무내용', '대분류', '중분류', '소분류', '담당자', '우선순위', '상태', '마감일', '완료일'];
  const rows = (Array.isArray(state.todos) ? state.todos : []).map((t) => [
    t.registeredDate || '', t.text || '', pname(t.projectId), t.channel || '', t.subChannel || '',
    t.assignee || '', t.priority || '', t.status || (t.done ? '완료' : '대기'), t.dueDate || '', t.completedDate || '',
  ]);
  // ⚠️ BOM 을 붙여야 엑셀이 한글을 깨뜨리지 않는다
  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}

/* Resend 첨부 형식: [{ filename, content: base64 }] */
export function buildBackupAttachments(state, todayIso) {
  const stamp = todayIso || '';
  return [
    { filename: `sclm-백업-${stamp}.json`, content: b64(JSON.stringify(state)) },
    { filename: `sclm-업무목록-${stamp}.csv`, content: b64(buildTodosCsv(state)) },
  ];
}

async function readMainState(env) {
  try {
    const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
    return row && row.data ? JSON.parse(row.data) : null;
  } catch (e) { return null; }
}

/* 주간 리포트 발송 — 금요일에만 부른다(판정은 호출부). */
export async function sendWeeklyMail(env, weekly) {
  if (!mailConfigured(env)) return { skipped: 'not_configured' };

  // 백업 첨부는 부수 기능이다. 만들다 실패해도 주간 리포트 자체는 나가야 한다.
  let attachments = [];
  try {
    const state = await readMainState(env);
    if (state) attachments = buildBackupAttachments(state, weekly && weekly.today);
  } catch (e) { attachments = []; }

  const { subject, html, text } = buildWeeklyMailBody(weekly, attachments.length > 0);

  try {
    const payload = { from: env.MAIL_FROM || DEFAULT_FROM, to: [env.MAIL_TO], subject, html, text };
    if (attachments.length) payload.attachments = attachments;
    const r = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: String(body.message || body.error || '').slice(0, 200) };
    return { ok: true, id: body.id || '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

/* 할 일마다 '완료 처리' 서명 링크를 만든다. 서명 실패는 치명적이지 않으므로
   그 경우 ✓ 칸 없이 예전과 똑같은 메일이 나가게 둔다. */
async function buildDoneLinks(env, summary) {
  const out = {};
  if (!env || !env.APP_PASSWORD) return out;
  const ids = []
    .concat(summary.overdueList || [], summary.todayList || [], summary.upcomingList || [])
    .map((t) => t && t.id).filter(Boolean);
  try {
    const { actionUrl } = await import('../mail-action.js');
    for (const id of ids) out[id] = await actionUrl(env, 'done', id);
  } catch (e) { return {}; }
  return out;
}

/* 실제 발송. 설정이 없으면 조용히 건너뛴다(다른 채널을 막지 않는다). */
export async function sendBriefMail(env, summary) {
  if (!mailConfigured(env)) return { skipped: 'not_configured' };
  const { subject, html, text } = buildMailBody(summary, await buildDoneLinks(env, summary));
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
