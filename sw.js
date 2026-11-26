/* 読み上げくん service worker: caches app files on this origin only. */
const CACHE = 'yomiage-v6';
// Big, never-changing data (voice, dictionary, OCR models) lives in its own cache so an app update does not
// download it again. A new version of such data must use a new folder name (e.g. vendor/ojt2/).
const ASSETS = 'yomiage-assets-1';
function isAsset(path) {
  return /\/vendor\/(ojt\d+|models|ort|tessdata)\//.test(path) || /\/vendor\/(paddleocr\.mjs|tesseract-core-simd-lstm\.wasm\.js)$/.test(path);
}
const CORE = [
  './',
  './index.html',
  './manifest.json',
  './使い方.txt',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './vendor/tesseract-core-simd-lstm.wasm.js',
  './vendor/paddleocr.mjs'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(CORE.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      var old = keys.filter(function (k) { return k !== CACHE && k !== ASSETS; });
      return Promise.all(old.map(function (k) {
        return caches.delete(k);
      })).then(function () { return old.length > 0; });
    }).then(function (upgraded) {
      return self.clients.claim().then(function () {
        if (!upgraded) return;
        // Pages opened with the previous (broken) version: reload them once into the new version.
        // Do not wait on navigate() here: fetches are held until activation finishes.
        setTimeout(function () {
          self.clients.matchAll({ type: 'window' }).then(function (list) {
            list.forEach(function (c) {
              try { c.navigate(c.url).catch(function () {}); } catch (e) {}
            });
          });
        }, 300);
      });
    })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  var isHtml = url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  if (isHtml) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(event.request, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(event.request).then(function (cached) {
          return cached || caches.match('./index.html');
        });
      })
    );
    return;
  }

  var target = isAsset(url.pathname) ? ASSETS : CACHE;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (res) {
        if (res && res.ok && res.status === 200) {
          var copy = res.clone();
          caches.open(target).then(function (c) { return c.put(event.request, copy); }).catch(function () {});
        }
        return res;
      });
    })
  );
});
