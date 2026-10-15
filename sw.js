// アプリ本体をキャッシュして、電波が弱くても起動できるようにする
const CACHE = 'hyakkin-map-v2';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 地図タイルと店舗検索は常にネットから取る
  if (e.request.method !== 'GET' || url.hostname.endsWith('openstreetmap.org') || url.pathname.includes('/api/')) return;
  // アプリ本体はネット優先、つながらなければキャッシュ
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
