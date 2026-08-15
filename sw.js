/* יהודה שיפוצים — Service Worker
   מטרה: עבודה אופליין + עדכון אוטומטי.
   בכל שדרוג: העלה את מספר הגרסה כאן (CACHE) והאפליקציה תתעדכן לבד אצל כל המשתמשים.
*/
const CACHE = 'ys-cache-v17.3';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './version.json'];

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  const isDoc = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  const isVersion = url.pathname.endsWith('version.json');

  // Network-first for the app document + version file → always pulls the newest deploy
  if (isDoc || isVersion) {
    // Network-first with a real timeout: on slow mobile we still wait up to 6s
    // before falling back to cache, so a weak signal doesn't serve a stale app.
    e.respondWith((async () => {
      // \u05d4\u05e8\u05e9\u05ea \u05de\u05de\u05e9\u05d9\u05db\u05d4 \u05d1\u05e8\u05e7\u05e2 \u05d2\u05dd \u05d0\u05dd \u05e0\u05e4\u05dc\u05e0\u05d5 \u05dc\u05de\u05d8\u05de\u05d5\u05df \u2014 \u05db\u05da \u05d4\u05de\u05d8\u05de\u05d5\u05df \u05de\u05ea\u05e2\u05d3\u05db\u05df \u05dc\u05e4\u05e2\u05dd \u05d4\u05d1\u05d0\u05d4
      const net = fetch(req, { cache: 'no-store' }).then(r => {
        if (r && r.status === 200) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      });
      try {
        const timed = new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 12000));
        return await Promise.race([net, timed]);
      } catch (_) {
        net.catch(() => {});   // \u05de\u05de\u05e9\u05d9\u05da \u05d1\u05e8\u05e7\u05e2, \u05dc\u05dc\u05d0 \u05e9\u05d2\u05d9\u05d0\u05d4 \u05dc\u05d0 \u05de\u05d8\u05d5\u05e4\u05dc\u05ea
        const m = await caches.match(req);
        return m || (await caches.match('./index.html')) ||
               new Response('offline', { status: 503 });
      }
    })());
    return;
  }

  // Cache-first for everything else (icons, CDN libs) with background refresh
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(r => {
        if (r && r.status === 200 && url.origin === location.origin) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return r;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
