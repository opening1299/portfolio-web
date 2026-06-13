// 웹 OAuth 클라이언트 (유형: 웹 애플리케이션). secret 없음 — 공개돼도 안전.
// 승인된 JavaScript 원본: https://opening1299.github.io  (+ 로컬 테스트 시 http://localhost:8000)
export const GOOGLE_CLIENT_ID =
  "343335437387-rm7p9ktbaj6ml7e6eidbc5im5t48eb8t.apps.googleusercontent.com";

// 데스크톱과 동일한 비민감 스코프 → 같은 프로젝트의 appDataFolder 백업 공유
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

// sql.js(WASM) — 브라우저에서 SQLite 읽기
export const SQLJS_BASE = "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/";
