// 구글 시트(업무 트래커) 읽기 유틸. 파일명이 _로 시작하면 라우팅되지 않는다(Pages Functions 규칙).
// ⚠️ 읽기 전용: 시트에 쓰지 않는다(수식·구조 보존). 캘린더 유틸(_util.js)의 토큰 로직을 재사용한다.
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// 구글 시트 URL → { spreadsheetId, gid }
export function parseSheetUrl(url) {
  const id = (String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/) || [])[1] || '';
  const gm = String(url || '').match(/[#&?]gid=(\d+)/);
  return { spreadsheetId: id, gid: gm ? Number(gm[1]) : 0 };
}

async function sfetch(token, url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    const e = new Error(`${method} sheets → ${r.status} ${t.slice(0, 160)}`);
    e.status = r.status;
    throw e;
  }
  return r.status === 204 ? {} : r.json();
}

// A1 표기용 탭 이름 인용(작은따옴표 이스케이프)
const q = (title) => `'${String(title).replace(/'/g, "''")}'`;

// gid로 탭 제목 조회
export async function getSheetTitle(token, spreadsheetId, gid) {
  const j = await sfetch(token, `${SHEETS}/${spreadsheetId}?fields=sheets(properties(sheetId,title))`);
  const list = j.sheets || [];
  const found = list.find((s) => s.properties && s.properties.sheetId === Number(gid));
  return (found && found.properties.title) || (list[0] && list[0].properties.title) || 'Sheet1';
}

// 탭 전체 값(2차원 배열) 읽기. 날짜 등은 표시 문자열 그대로.
export async function readGrid(token, spreadsheetId, title) {
  const range = encodeURIComponent(q(title));
  const j = await sfetch(token, `${SHEETS}/${spreadsheetId}/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  return j.values || [];
}
