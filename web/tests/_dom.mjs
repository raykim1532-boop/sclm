/* 화면 동작 테스트용 하네스.
   src/shell.html 의 마크업을 linkedom 으로 띄우고 그 안에서 src/app.js 를 통째로 실행한다.
   그래서 renderTodos()·openTodoModal() 같은 **실제 함수를 실제 DOM 위에서** 부를 수 있다.
   순수 함수 테스트로는 못 잡는 것 — 버튼 배선, 이벤트 전파, DOM 갱신 — 을 여기서 본다.

   ⚠️ shell.html 의 <script> 는 전부 걷어낸다. FullCalendar 임베드 번들이 30만 자라
      파싱만 오래 걸리고 테스트에 쓸 일이 없다. 필요한 전역은 아래에서 가짜로 넣어 준다. */
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const SHELL = new URL('../../src/shell.html', import.meta.url);
const APP = new URL('../../src/app.js', import.meta.url);

/* FullCalendar 가짜 구현 — 라이브러리를 검증하려는 게 아니라 **우리 배선**을 본다.
   진짜 번들은 30만 자에 ResizeObserver 같은 브라우저 API를 요구해 linkedom 에선 못 돌린다.
   대신 앱이 넘긴 옵션을 붙잡아 두고, 테스트가 콜백을 직접 발사할 수 있게 한다.
     · cal.opts                    앱이 넘긴 설정 전체
     · cal.events()                events 콜백이 만들어 준 항목 배열(= 매핑 결과)
     · cal.fire('dateClick', …)    날짜·일정 클릭 등 콜백 호출
     · cal.renders / cal.refetches render()·refetchEvents() 호출 횟수
   메인 캘린더 + 할 일 미니 캘린더가 각각 만들어지므로 생성 순서대로 배열에 모은다. */
function makeFullCalendarStub(calendars) {
  function Calendar(el, opts) {
    const rec = {
      el, opts, renders: 0, refetches: 0,
      events() {                                  // (info, success) => success([...])
        let out = [];
        if (typeof opts.events === 'function') opts.events({}, (arr) => { out = arr; });
        else if (Array.isArray(opts.events)) out = opts.events;
        return out;
      },
      fire(name, arg) {
        const fn = opts[name];
        if (typeof fn !== 'function') throw new Error('콜백이 없음: ' + name);
        return fn(arg);
      },
      render() { this.renders++; },
      refetchEvents() { this.refetches++; },
      destroy() {}, setOption() {}, changeView() {}, gotoDate() {},
      getDate: () => new Date(),
    };
    calendars.push(rec);
    return rec;
  }
  return { Calendar };
}

/* app.js 안에서 이름으로 꺼내 쓸 것들. 여기 없는 함수는 테스트에서 못 부른다(추가하면 된다). */
const EXPORTS = [
  'openTodoModal', 'closeModal', 'showModal',
  'renderTodos', 'renderDashAnalytics', 'renderVaultList',
  'logRowHtml', 'logRowsHtml', 'todoLogs', 'todoLogLatest', 'todoProgressCell',
  'dueBadgeHtml', 'dueMoveCount', 'pushDueHistory', 'todoDueHistory',
  'computeTaxoTop', 'taxoRowHtml', 'escapeHtml', 'todayStr', 'toast',
  'filterTodos', 'buildTodosCsv', 'renderKanban', 'openWeeklyReport', 'openMonthlyReport',
  'bulkAssign', 'refreshBulkSelects', 'todoSortValue', 'renderAll', 'weekRange',
  // 캘린더 배선
  'setupCalendar', 'buildCalendarEvents', 'refreshCalendarEvents', 'openEventModal',
  'isGoogleImported', 'projectColor',
];

/* linkedom 의 <select>.value 는 읽기 전용이라 앱 코드(`sel.value = ...`)가 막힌다.
   브라우저와 같게 "값이 맞는 option 을 selected 로" 동작하도록 setter 를 붙여 준다.
   ⚠️ 이건 테스트 환경의 한계를 메우는 것이지 앱 동작을 바꾸는 게 아니다. */
function patchSelectValue(document) {
  const proto = Object.getPrototypeOf(document.createElement('select'));
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (!desc || desc.set) return;
  Object.defineProperty(proto, 'value', {
    configurable: true,
    get() {
      const opts = [...this.querySelectorAll('option')];
      const hit = opts.find((o) => o.hasAttribute('selected')) || opts[0];
      return hit ? (hit.getAttribute('value') !== null ? hit.getAttribute('value') : hit.textContent) : '';
    },
    set(v) {
      [...this.querySelectorAll('option')].forEach((o) => {
        const ov = o.getAttribute('value') !== null ? o.getAttribute('value') : o.textContent;
        if (ov === String(v)) o.setAttribute('selected', ''); else o.removeAttribute('selected');
      });
    },
  });
}

export function bootApp(opts = {}) {
  let html = readFileSync(SHELL, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const { document, window } = parseHTML(html);
  patchSelectValue(document);

  const store = Object.assign({}, opts.localStorage);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  // 저장은 서버로 내보내지 않고 전부 여기에 모은다
  const saves = [];
  const api = {
    saveData: async (d) => { saves.push(JSON.parse(JSON.stringify(d))); return opts.saveOk === false ? false : true; },
    loadData: async () => opts.loadData || {},
    exportBackup() {}, importBackup() {}, getSyncInfo: async () => ({}),
  };
  window.api = api;
  window.CloudSync = opts.CloudSync || null;

  const src = readFileSync(APP, 'utf8');
  const fn = new Function(
    'window', 'document', 'localStorage', 'location', 'navigator', 'fetch', 'console', 'FullCalendar', 'confirm', 'prompt', 'alert',
    src + '\n;return {' + EXPORTS.map((k) => `${k}: typeof ${k} === 'function' ? ${k} : undefined`).join(',') +
    ', getState: () => state, setState: (v) => { state = v; },'
    + ' getVaultEntries: () => vaultEntries, setVaultEntries: (v) => { vaultEntries = v; },'
    + ' setVaultKey: (v) => { vaultKey = v; }, setVaultSalt: (v) => { vaultSalt = v; },'
    + ' setProjectView: (v) => { currentProjectViewId = v; } };'
  );

  const calendars = [];
  const app = fn(
    window, document, localStorage,
    { protocol: 'https:', href: 'https://sclm.pages.dev/', reload() {} },
    { clipboard: { writeText: async () => {} }, serviceWorker: undefined },
    async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
    { log() {}, warn() {}, error() {} },
    makeFullCalendarStub(calendars),
    opts.confirm || (() => true),
    opts.prompt || (() => null),
    () => {}
  );

  return { app, document, window, saves, store, localStorage, calendars };
}

/* DOM 조회 도우미 */
export const $ = (doc, sel) => doc.querySelector(sel);
export const $$ = (doc, sel) => [...doc.querySelectorAll(sel)];

/* linkedom 의 click() 은 핸들러를 부르지만, onclick 프로퍼티만 붙은 요소도 있어 둘 다 처리한다 */
export function click(el) {
  if (!el) throw new Error('클릭할 요소가 없음');
  if (typeof el.click === 'function') el.click();
  else if (typeof el.onclick === 'function') el.onclick({ target: el, stopPropagation() {}, preventDefault() {} });
}

/* 비동기 핸들러가 끝나길 기다린다 */
export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
