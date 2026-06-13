// 앱 셸 캐시 — 오프라인 기동/홈 화면 추가용. 데이터(Drive/sql.js CDN)는 항상 네트워크.
const CACHE = "pf-shell-v2";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./config.js", "./manifest.json", "./icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 같은 출처(앱 셸)만 캐시 우선. 외부(googleapis, cdn)는 그대로 네트워크.
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
