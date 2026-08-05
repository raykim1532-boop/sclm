// /api/mail-inbox — 메일을 전달하면 할 일이 만들어진다.
//
// 실제 메일은 지저분하다: 제목엔 "FW: RE:" 가 겹겹이 붙고, 본문 아래엔 원문 헤더와
// 인용문이 통째로 딸려 온다. 그 상태로 그대로 넣으면 목록이 못 읽게 되므로
// **다듬는 규칙**이 이 기능의 핵심이고, 그래서 규칙을 서버에 두고 여기서 검증한다.
// (MIME 파싱은 도메인이 있어야 띄울 수 있는 워커 몫이라 테스트가 안 된다.)
import { API, check, section, mockDB, mockRequest, mockFetch } from './_helpers.mjs';

const {
  onRequestPost, cleanSubject, parseDirectives, normPriority, normDate,
  bodyToLog, addressOf, senderAllowed, buildTodo, storeAttachments, takeDirectiveLine,
} = await import(API + 'mail-inbox.js');
const { buildInboxReceiptBody } = await import(API + 'push/_mail.js');

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const ME = 'raykim@example.com';
const ENV = { MAIL_INBOX_SECRET: 'INBOXSEC', MAIL_TO: ME };

/* R2 모의 — put 한 것을 그대로 들고 있는다 */
function mockR2() {
  const store = new Map();
  return { store, put: async (k, v, o) => { store.set(k, { body: v, opts: o }); } };
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function post(docs, mail, extraEnv, headers) {
  const env = Object.assign({ DB: mockDB(docs) }, ENV, extraEnv || {});
  return onRequestPost({
    env,
    request: Object.assign(mockRequest(headers || { 'X-Inbox-Secret': 'INBOXSEC' }), {
      async json() { return mail; },
    }),
  });
}
const todos = (docs) => JSON.parse(docs.main).todos;
const last = (docs) => todos(docs)[todos(docs).length - 1];

section('제목 다듬기 — 전달·회신 접두사');
{
  check('FW: 를 뗀다', cleanSubject('FW: 정산 자료 요청') === '정산 자료 요청');
  check('여러 겹도 전부 뗀다', cleanSubject('FW: RE: FW: 정산 자료 요청') === '정산 자료 요청');
  check('한국어 접두사', cleanSubject('회신: 답장: 계약서 검토') === '계약서 검토');
  check('대소문자 무관', cleanSubject('fwd: re: 견적') === '견적');
  check('대괄호 표기', cleanSubject('[전달] 공문 발송의 건') === '공문 발송의 건');
  check('접두사가 없으면 그대로', cleanSubject('그냥 제목') === '그냥 제목');
  check('여러 공백은 하나로', cleanSubject('  FW:   정산   자료  ') === '정산 자료');
  check('빈 제목도 안전', cleanSubject('') === '' && cleanSubject(null) === '');
  // 'RE' 로 시작하는 멀쩡한 단어를 잘라먹으면 안 된다
  check('콜론이 없으면 안 뗀다', cleanSubject('REPORT 제출') === 'REPORT 제출');
}

section('제목 지시어 — #중분류 !우선순위 ~마감일');
{
  const d = parseDirectives('쿠팡 정산 자료 준비 #쿠팡 !중요 ~8/10', '2026-08-05');
  check('업무내용만 남는다', d.text === '쿠팡 정산 자료 준비');
  check('중분류', d.channel === '쿠팡');
  check('우선순위', d.priority === '중요');
  check('마감일', d.dueDate === '2026-08-10');

  const none = parseDirectives('그냥 업무', '2026-08-05');
  check('지시어가 없어도 동작', none.text === '그냥 업무' && !none.channel && !none.dueDate);

  const mid = parseDirectives('#엔터식스 공문 발송 ~2026-09-01', '2026-08-05');
  check('앞에 붙어도 인식', mid.channel === '엔터식스' && mid.text === '공문 발송');
  check('전체 날짜 형식', mid.dueDate === '2026-09-01');

  const dup = parseDirectives('a #하나 b #둘', '2026-08-05');
  check('중분류는 첫 번째만', dup.channel === '하나');
  check('나머지 지시어도 본문에서 제거', dup.text === 'a b');

  check('모르는 우선순위는 버린다', parseDirectives('x !아무거나', '2026-08-05').priority === '');
  check('이상한 날짜는 버린다', parseDirectives('x ~99/99', '2026-08-05').dueDate === '');
}

section('우선순위 정규화 (앱과 같은 세 값)');
{
  check('긴급', normPriority('긴급') === '긴급' && normPriority('urgent') === '긴급');
  check('중요', normPriority('중요') === '중요' && normPriority('High') === '중요');
  check('보통', normPriority('보통') === '보통');
  check('빈 값', normPriority('') === '' && normPriority(null) === '');
  check('모르는 값은 빈 값', normPriority('아주아주') === '');
}

section('날짜 해석');
{
  check('YYYY-MM-DD', normDate('2026-08-10', '2026-08-05') === '2026-08-10');
  check('YYYY/M/D', normDate('2026/8/9', '2026-08-05') === '2026-08-09');
  check('M/D 는 올해', normDate('8/10', '2026-08-05') === '2026-08-10');
  check('오늘이면 오늘', normDate('8/5', '2026-08-05') === '2026-08-05');
  // 12월에 "1/5"는 다음 달을 뜻한다 — 올해로 넣으면 이미 지난 날짜가 된다
  check('이미 지난 M/D 는 내년', normDate('1/5', '2026-12-20') === '2027-01-05');
  check('없는 날짜는 버린다', normDate('2/30', '2026-01-01') === '');
  check('빈 값', normDate('', '2026-08-05') === '' && normDate(null, '2026-08-05') === '');
}

section('본문 — 전달 원문은 잘라낸다');
{
  const outlookKo = '내일까지 검토 부탁드립니다.\n\n보낸 사람: 홍길동 <a@b.com>\n보낸 날짜: 2026년 8월 5일\n제목: 원본';
  check('한국어 아웃룩 구분선에서 자른다', bodyToLog(outlookKo) === '내일까지 검토 부탁드립니다.');

  const orig = '확인 요청드립니다.\n\n-----Original Message-----\nFrom: someone';
  check('영문 구분선', bodyToLog(orig) === '확인 요청드립니다.');

  const underline = '급합니다\n________________________________\nFrom: x';
  check('밑줄 구분선', bodyToLog(underline) === '급합니다');

  const gmail = '넵 처리하겠습니다\n\nOn Tue, Aug 5, 2026 at 10:00 AM 홍길동 wrote:\n> 원문';
  check('지메일 인용', bodyToLog(gmail) === '넵 처리하겠습니다');

  check('인용부호 줄은 버린다', bodyToLog('본문\n> 인용1\n> 인용2') === '본문');
  check('여러 줄은 한 줄로', bodyToLog('한 줄\n두 줄\n\n세 줄') === '한 줄 두 줄 세 줄');
  check('빈 본문도 안전', bodyToLog('') === '' && bodyToLog(null) === '');

  const long = bodyToLog('가'.repeat(500));
  check('너무 길면 자른다', long.length === 300 && long.endsWith('…'));
}

section('본문 첫 줄 지시어');
{
  const a = takeDirectiveLine('#쿠팡 !중요 ~8/10\n실제 본문입니다.');
  check('지시어 줄을 떼어낸다', a.line === '#쿠팡 !중요 ~8/10');
  check('나머지 본문은 남는다', a.rest.trim() === '실제 본문입니다.');

  const blank = takeDirectiveLine('\n\n  #쿠팡\n본문');
  check('앞의 빈 줄은 건너뛴다', blank.line === '#쿠팡');
  check('그 줄만 빠진다', blank.rest.indexOf('#쿠팡') === -1 && blank.rest.indexOf('본문') > -1);

  // ⚠️ 아무 줄이나 훑으면 본문의 # · ! 를 지시어로 오인한다
  const mixed = takeDirectiveLine('#쿠팡 정산 자료 부탁드립니다\n둘째 줄');
  check('지시어 아닌 말이 섞이면 손대지 않는다', mixed.line === '');
  check('본문도 그대로', mixed.rest.indexOf('#쿠팡 정산') > -1);

  check('평범한 본문은 그대로', takeDirectiveLine('안녕하세요\n확인 부탁드립니다').line === '');
  check('느낌표로 끝나는 문장에 안 걸린다', takeDirectiveLine('급합니다!\n본문').line === '');
  check('빈 본문 안전', takeDirectiveLine('').line === '' && takeDirectiveLine(null).line === '');
  check('지시어만 있고 본문이 없어도 안전', takeDirectiveLine('#쿠팡').rest.trim() === '');
}

section('지시어는 제목·본문 어디에 적어도 된다');
{
  const state = { todos: [], channels: [], projects: [] };

  const fromBody = buildTodo({ subject: 'FW: 계약서 검토' }, state, '2026-08-05', '#엔터식스 !긴급 ~8/20');
  check('본문 줄에서 중분류', fromBody.channel === '엔터식스');
  check('본문 줄에서 우선순위', fromBody.priority === '긴급');
  check('본문 줄에서 마감일', fromBody.dueDate === '2026-08-20');
  check('업무내용은 제목 그대로', fromBody.text === '계약서 검토');

  // 제목까지 고쳐 적었다면 그쪽이 더 분명한 의도다
  const both = buildTodo({ subject: '검토 #쿠팡' }, state, '2026-08-05', '#엔터식스 ~8/20');
  check('겹치면 제목이 이긴다', both.channel === '쿠팡');
  check('제목에 없는 것은 본문에서 채운다', both.dueDate === '2026-08-20');

  check('둘 다 없으면 빈 값', buildTodo({ subject: '그냥 제목' }, state, '2026-08-05', '').channel === '');
}

section('발신자 확인');
{
  check('이름이 붙은 주소에서 뽑는다', addressOf('김성철 <Ray@Example.com>') === 'ray@example.com');
  check('맨 주소도 처리', addressOf('a@b.com') === 'a@b.com');

  check('허용된 발신자', senderAllowed({ MAIL_TO: ME }, `김성철 <${ME}>`) === true);
  check('대소문자 무관', senderAllowed({ MAIL_TO: ME }, 'RAYKIM@EXAMPLE.COM') === true);
  check('다른 사람은 거절', senderAllowed({ MAIL_TO: ME }, 'stranger@evil.com') === false);
  check('여러 명 허용 가능', senderAllowed({ MAIL_ALLOW_FROM: 'a@b.com, ' + ME }, ME) === true);
  check('ALLOW_FROM 이 MAIL_TO 보다 우선', senderAllowed({ MAIL_ALLOW_FROM: 'a@b.com', MAIL_TO: ME }, ME) === false);

  // ⚠️ 설정을 깜빡한 채 열려 있는 것보다 아무것도 안 되는 편이 낫다
  check('설정이 없으면 아무도 통과 못 한다', senderAllowed({}, ME) === false);
  check('빈 발신자도 거절', senderAllowed({ MAIL_TO: ME }, '') === false);
}

section('할 일 만들기');
{
  const state = { todos: [{ id: 'a', no: 7 }], channels: [], projects: [] };
  const t = buildTodo({ subject: 'FW: 계약서 검토 #엔터식스 ~8/20', from: `김 <${ME}>` }, state, '2026-08-05');

  check('번호는 이어서', t.no === 8);
  check('등록일은 오늘', t.registeredDate === '2026-08-05');
  check('제목이 업무내용', t.text === '계약서 검토');
  check('중분류 반영', t.channel === '엔터식스');
  check('마감일 반영', t.dueDate === '2026-08-20');
  check('상태는 대기', t.status === '대기' && t.done === false);
  check('출처를 남긴다', t.fromMail === ME);
  // 대분류는 메일만 보고 맞히면 정리가 어긋난다 — 사람이 정한다
  check('대분류는 비워 둔다', t.projectId === null);
  // 임의 마감일은 거짓 정보다
  check('지시어가 없으면 마감일도 빈다', buildTodo({ subject: '제목만' }, state, '2026-08-05').dueDate === '');
  check('제목이 없으면 표시라도 남긴다', buildTodo({ subject: '' }, state, '2026-08-05').text === '(제목 없는 메일)');
  check('첫 할 일이면 1번', buildTodo({ subject: 'x' }, { todos: [] }, '2026-08-05').no === 1);
}

section('첨부 저장 — /api/files 와 같은 키 형식');
{
  const FILES = mockR2();
  const out = await storeAttachments({ FILES }, [
    { filename: '공문.pdf', mimeType: 'application/pdf', content: b64('PDF내용') },
    { filename: '견적서.xlsx', mimeType: 'application/vnd.ms-excel', content: b64('XLS') },
  ]);
  check('두 개 저장', out.length === 2 && FILES.store.size === 2);
  // 앱의 다운로드·삭제가 이 형식을 검사한다(validKey)
  check('키 형식이 맞다', /^[0-9a-z]+\/[0-9a-z]+\.pdf$/.test(out[0].key));
  check('원래 파일명 보존', out[0].name === '공문.pdf');
  check('다운로드 주소', out[0].url === '/api/files/' + out[0].key);
  check('크기 기록', out[0].size === Buffer.byteLength('PDF내용', 'utf8'));
  check('MIME 타입 보존', FILES.store.get(out[0].key).opts.httpMetadata.contentType === 'application/pdf');
  check('파일명을 메타로 남긴다', FILES.store.get(out[0].key).opts.customMetadata.name === '공문.pdf');

  const evil = await storeAttachments({ FILES: mockR2() }, [{ filename: '../../etc/passwd', content: b64('x') }]);
  check('경로 조작은 파일명에서 제거', evil[0].name.indexOf('/') === -1);

  check('R2 가 없으면 빈 배열', (await storeAttachments({}, [{ filename: 'a', content: b64('x') }])).length === 0);
  check('첨부가 없어도 안전', (await storeAttachments({ FILES: mockR2() }, null)).length === 0);
  check('5개까지만', (await storeAttachments({ FILES: mockR2() },
    Array.from({ length: 9 }, (_, i) => ({ filename: 'f' + i, content: b64('x') })))).length === 5);
}

section('엔드포인트 — 등록');
{
  const docs = { main: JSON.stringify({ todos: [], channels: [], projects: [] }) };
  const FILES = mockR2();
  const calls = mockFetch([{ match: 'api.resend.com', method: 'POST', reply: { id: 'r1' } }]);
  const r = await post(docs, {
    from: `김성철 <${ME}>`,
    subject: 'FW: 마리오아울렛 정산 자료 요청 #마리오아울렛 !중요',
    text: '8월 10일까지 회신 부탁드립니다.\n\n보낸 사람: 담당자 <x@y.com>\n제목: 원본',
    attachments: [{ filename: '요청서.pdf', mimeType: 'application/pdf', content: b64('PDF') }],
  }, { FILES, RESEND_API_KEY: 'K' });
  const b = await r.json();
  const t = last(docs);

  check('등록 성공', b.ok === true && b.no === 1);
  check('업무내용', t.text === '마리오아울렛 정산 자료 요청');
  check('중분류', t.channel === '마리오아울렛');
  check('우선순위', t.priority === '중요');
  check('본문이 로그로 남는다', t.logs[0].text === '8월 10일까지 회신 부탁드립니다.');
  check('로그 날짜는 오늘', t.logs[0].at === TODAY);
  check('첨부가 붙는다', t.files.length === 1 && t.files[0].name === '요청서.pdf');
  check('R2 에 실제로 담겼다', FILES.store.size === 1);
  check('새 중분류가 목록에 등록됨', JSON.parse(docs.main).channels.indexOf('마리오아울렛') > -1);

  const mail = calls.filter((c) => c.url.includes('resend')).map((c) => JSON.parse(c.opts.body))[0];
  check('확인 메일이 나간다', b.notified.ok === true && !!mail);
  check('확인 메일 제목', mail.subject.includes('등록됨'));
  check('비어 있는 칸을 짚어 준다', mail.html.includes('대분류') && mail.html.includes('마감일'));
  check('바로 여는 링크', mail.html.includes('?todo=' + t.id));
}

section('엔드포인트 — 거절');
{
  const docs = { main: JSON.stringify({ todos: [], channels: [], projects: [] }) };
  check('시크릿이 틀리면 401', (await post(docs, { from: ME }, {}, { 'X-Inbox-Secret': 'WRONG' })).status === 401);
  check('시크릿이 없으면 401', (await post(docs, { from: ME }, {}, {})).status === 401);
  check('그때는 아무것도 안 만든다', todos(docs).length === 0);

  const r = await post(docs, { from: 'stranger@evil.com', subject: '악성' });
  const b = await r.json();
  check('모르는 발신자는 건너뛴다', b.skipped === 'sender_not_allowed');
  check('내용은 버린다', todos(docs).length === 0);
  check('누가 보냈는지는 남긴다', b.from === 'stranger@evil.com');
}

section('엔드포인트 — 기존 데이터를 건드리지 않는다');
{
  const docs = { main: JSON.stringify({
    todos: [{ id: 'old', no: 3, text: '기존 업무', status: '진행중' }],
    events: [{ id: 'e1' }], projects: [{ id: 'p1', name: '정산' }],
    channels: ['쿠팡'], subMaster: ['하프클럽'],
  }) };
  await post(docs, { from: ME, subject: '새 업무 #쿠팡' }, { RESEND_API_KEY: '' });
  const s = JSON.parse(docs.main);

  check('기존 할 일 그대로', s.todos[0].text === '기존 업무' && s.todos[0].status === '진행중');
  check('번호가 이어진다', s.todos[1].no === 4);
  check('일정·대분류 그대로', s.events.length === 1 && s.projects.length === 1);
  check('이미 있는 중분류는 중복 추가 안 함', s.channels.filter((c) => c === '쿠팡').length === 1);
  check('소분류 목록 보존', s.subMaster.length === 1);
}

section('확인 메일 본문');
{
  const full = buildInboxReceiptBody(
    { id: 'x1', text: '정산 자료 준비', channel: '쿠팡', priority: '중요', dueDate: '2026-08-10', projectId: 'p1', registeredDate: TODAY },
    [{ name: '요청서.pdf' }]);
  check('첨부를 알려 준다', full.html.includes('첨부 1개') && full.html.includes('요청서.pdf'));
  check('다 채워졌으면 경고가 없다', !full.html.includes('비어 있습니다'));

  const bare = buildInboxReceiptBody({ id: 'x2', text: '제목만 있는 건', registeredDate: TODAY }, []);
  check('빈 칸을 짚는다', bare.html.includes('대분류 · 마감일') && bare.html.includes('비어 있습니다'));
  check('지시어 사용법을 알려 준다', bare.html.includes('#거래처') && bare.html.includes('~8/10'));
  check('평문본도 만든다', bare.text.includes('제목만 있는 건'));
  check('이스케이프', buildInboxReceiptBody({ id: 'x', text: '<b>x</b>' }, []).html.includes('&lt;b&gt;'));
}
