// 구글 시트(업무 트래커) 연동 유틸. 파일명이 _로 시작하면 라우팅되지 않는다(Pages Functions 규칙).
// 캘린더 유틸(_util.js)의 토큰 발급/구글 문서 저장 로직을 그대로 재사용한다.
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

// 시트 컬럼 정의: 헤더명 <-> todo 필드. '대분류'는 프로젝트 "이름"으로 저장(내부 id 아님).
export const COLUMNS = [
  { key: 'no', header: 'No' },
  { key: 'registeredDate', header: '등록일' },
  { key: 'project', header: '대분류' },
  { key: 'channel', header: '세부채널' },
  { key: 'priority', header: '우선순위' },
  { key: 'text', header: '업무내용' },
  { key: 'assignee', header: '담당자' },
  { key: 'dueDate', header: '마감일' },
  { key: 'status', header: '진행상태' },
  { key: 'needsCheck', header: '점검필요' },
  { key: 'completedDate', header: '완료일' },
  { key: 'progress', header: '진행사항' },
  { key: 'remarks', header: '비고' },
];
export const ID_HEADER = 'SCLM_ID'; // 앱이 각 행에 심는 숨김 키 열

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

// A1부터 전체 덮어쓰기(문자열 그대로 저장 → RAW).
export async function writeGrid(token, spreadsheetId, title, values) {
  const range = encodeURIComponent(`${q(title)}!A1`);
  return sfetch(token, `${SHEETS}/${spreadsheetId}/values/${range}?valueInputOption=RAW`, 'PUT', { values });
}

// 남는 하단 행 비우기
export async function clearRange(token, spreadsheetId, a1) {
  const range = encodeURIComponent(a1);
  return sfetch(token, `${SHEETS}/${spreadsheetId}/values/${range}:clear`, 'POST', {});
}
