/* Sahne Setlist - service worker (v3)
 * ---------------------------------------------------------------------------
 * ÖNEMLİ: Uygulama kabuğu (html/css/js) için AĞ-ÖNCELİKLİ strateji kullanılır.
 * Böylece internet varken her zaman en güncel sürüm gelir (eski v1 sürümü
 * güncellemeleri önbellekte takıp cihaza ulaştırmıyordu). İnternet yoksa
 * önbellekten sunulur -> çevrimdışı yine çalışır.
 * Kayıtlı şarkılar zaten localStorage'da olduğu için çevrimdışı görüntülenir.
 */
const CACHE = 'setlist-shell-v49';
const SHELL = [
  '/',
  '/index.html',
  '/fonts.css?v=49',
  '/style.css?v=49',
  '/app.js?v=49',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // API çağrıları: her zaman ağdan
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'Çevrimdışı: internet gerekli.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Uygulama kabuğu (aynı origin): AĞ-ÖNCELİKLİ, başarısız olursa önbellek
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request).then((cached) => cached || caches.match('/index.html'))
        )
    );
    return;
  }

  // Diğer (origin dışı): önbellek varsa ver, yoksa ağ
  e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)));
});
