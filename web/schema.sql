-- 단일 사용자용: 앱 전체 상태(JSON)를 한 행에 통째로 보관
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
