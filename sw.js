// アプリの骨組みだけをキャッシュする（API通信はキャッシュしない）。
// 更新を配布するときは VERSION を上げる。
const VERSION = 'v1.0.2';
const CACHE = `subtitles-${VERSION}`;
const SHELL = ['./', './index.html', './app.js', './pcm-worklet.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // Gemini API などはそのまま通す
  // ネットワーク優先、失敗時にキャッシュ（更新をすぐ反映しつつオフラインでも起動できる）
  event.respondWith(
    fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(event.request))
  );
});
