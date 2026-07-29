/*
 * 브라우저(단일 HTML 파일)에서 실행할 때 쓰는 window.api 구현.
 * Electron의 preload.js와 똑같은 이름/모양의 메서드를 제공해서 app.js는 수정 없이 그대로 동작한다.
 * - 기본 저장소: localStorage (설치/설정 없이 바로 동작)
 * - "동기화 파일" 기능: File System Access API로 실제 로컬 파일(예: OneDrive 폴더 안의 파일)에
 *   직접 읽고 쓴다. 파일 핸들은 IndexedDB에 저장해 다음에 열었을 때도 이어서 연결한다.
 * - File System Access API를 지원하지 않는 브라우저(파이어폭스 등)에서는 동기화 기능만 비활성화되고,
 *   나머지 기능은 localStorage로 정상 동작한다.
 */
(function () {
  'use strict';

  const LS_KEY = 'myscheduler:data:v1';
  const DB_NAME = 'myscheduler-db';
  const STORE_NAME = 'handles';
  const HANDLE_KEY = 'syncFileHandle';

  const supportsFS = typeof window.showSaveFilePicker === 'function' && typeof window.showOpenFilePicker === 'function';
  let linkedHandle = null;
  let triedRestore = false;

  function defaultData() {
    return {
      settings: { theme: 'light', accent: '#1a73e8' },
      projects: [{ id: 'default', name: '일반', color: '#1a73e8' }],
      events: [],
      todos: [],
      channels: [],
      channelProjects: {},   // 중분류 → 소속 대분류(projectId)
      subChannels: {},       // 중분류 → 연결된 소분류 목록
      subMaster: [],         // 소분류 공용 목록(여러 중분류가 공유)
      tasks: []
    };
  }

  function mergeWithDefaults(parsed) {
    const d = defaultData();
    const merged = { ...d, ...parsed, settings: { ...d.settings, ...((parsed && parsed.settings) || {}) } };
    if (!Array.isArray(parsed && parsed.channels)) merged.channels = uniqueChannels(merged.todos);
    return merged;
  }

  function readLocalStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('로컬 저장소 읽기 실패', e);
      return null;
    }
  }

  function writeLocalStorage(data) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('로컬 저장소 쓰기 실패', e);
    }
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function tryRestoreHandle() {
    if (!supportsFS || triedRestore) return;
    triedRestore = true;
    try {
      const h = await idbGet(HANDLE_KEY);
      if (h) linkedHandle = h;
    } catch (e) {
      console.error('동기화 파일 정보 복원 실패', e);
    }
  }

  async function ensurePermission(handle) {
    const opts = { mode: 'readwrite' };
    try {
      if ((await handle.queryPermission(opts)) === 'granted') return true;
      if ((await handle.requestPermission(opts)) === 'granted') return true;
    } catch (e) {
      console.error('파일 권한 확인 실패', e);
    }
    return false;
  }

  async function readFromHandle(handle) {
    const file = await handle.getFile();
    const text = await file.text();
    return text && text.trim() ? JSON.parse(text) : null;
  }

  async function writeToHandle(handle, data) {
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  async function connectHandle(handle) {
    const ok = await ensurePermission(handle);
    if (!ok) return { ok: false, error: '파일 접근 권한이 필요해요.' };

    let existing = null;
    try {
      existing = await readFromHandle(handle);
    } catch (e) {
      console.error('동기화 파일 읽기 실패', e);
    }

    let dataToUse;
    if (existing) {
      dataToUse = mergeWithDefaults(existing);
    } else {
      const ls = readLocalStorage();
      dataToUse = ls ? mergeWithDefaults(ls) : defaultData();
      try {
        await writeToHandle(handle, dataToUse);
      } catch (e) {
        return { ok: false, error: '동기화 파일에 쓰지 못했어요: ' + String(e.message || e) };
      }
    }

    linkedHandle = handle;
    try {
      await idbSet(HANDLE_KEY, handle);
    } catch (e) {
      console.error('파일 핸들 저장 실패', e);
    }
    writeLocalStorage(dataToUse);
    return { ok: true, data: dataToUse, dir: handle.name };
  }

  window.api = {
    loadData: async () => {
      await tryRestoreHandle();
      if (linkedHandle) {
        try {
          const ok = await ensurePermission(linkedHandle);
          if (ok) {
            const parsed = await readFromHandle(linkedHandle);
            if (parsed) {
              const merged = mergeWithDefaults(parsed);
              writeLocalStorage(merged);
              return merged;
            }
          }
        } catch (e) {
          console.error('동기화 파일 읽기 실패, 로컬 저장소로 대체합니다', e);
        }
      }
      const ls = readLocalStorage();
      if (ls) return mergeWithDefaults(ls);
      const d = defaultData();
      writeLocalStorage(d);
      return d;
    },

    saveData: async (data) => {
      writeLocalStorage(data);
      if (linkedHandle) {
        try {
          const ok = await ensurePermission(linkedHandle);
          if (ok) await writeToHandle(linkedHandle, data);
        } catch (e) {
          console.error('동기화 파일 저장 실패', e);
        }
      }
      return true;
    },

    exportBackup: async (data) => {
      try {
        const filename = `scheduler-backup-${new Date().toISOString().slice(0, 10)}.json`;
        if (supportsFS) {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
          });
          await writeToHandle(handle, data);
          return { ok: true };
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        return { ok: true };
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false };
        console.error(e);
        return { ok: false, error: String(e.message || e) };
      }
    },

    importBackup: async () => {
      try {
        let text;
        if (supportsFS) {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
          });
          const file = await handle.getFile();
          text = await file.text();
        } else {
          text = await new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = () => {
              const file = input.files && input.files[0];
              if (!file) return reject(new Error('파일이 선택되지 않았어요'));
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = () => reject(reader.error);
              reader.readAsText(file);
            };
            input.click();
          });
        }
        const merged = mergeWithDefaults(JSON.parse(text));
        writeLocalStorage(merged);
        if (linkedHandle) {
          try {
            await writeToHandle(linkedHandle, merged);
          } catch (_) {}
        }
        return { ok: true, data: merged };
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false };
        return { ok: false, error: String(e.message || e) };
      }
    },

    getSyncInfo: async () => {
      if (!supportsFS) return { dir: null, isDefault: true, unsupported: true };
      await tryRestoreHandle();
      if (linkedHandle) return { dir: linkedHandle.name, isDefault: false };
      return { dir: null, isDefault: true };
    },

    startNewSyncFile: async () => {
      if (!supportsFS) return { ok: false, error: '이 브라우저는 지원하지 않아요. 크롬/엣지를 사용해주세요.' };
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'scheduler-data.json',
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
        });
        return await connectHandle(handle);
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false };
        return { ok: false, error: String(e.message || e) };
      }
    },

    openExistingSyncFile: async () => {
      if (!supportsFS) return { ok: false, error: '이 브라우저는 지원하지 않아요. 크롬/엣지를 사용해주세요.' };
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
        });
        return await connectHandle(handle);
      } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false };
        return { ok: false, error: String(e.message || e) };
      }
    },

    useLocalOnly: async () => {
      linkedHandle = null;
      try {
        await idbDelete(HANDLE_KEY);
      } catch (_) {}
      const ls = readLocalStorage();
      return { ok: true, data: ls ? mergeWithDefaults(ls) : defaultData() };
    }
  };
})();

