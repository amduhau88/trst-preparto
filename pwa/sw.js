/* Service worker — cachea el shell para que la app ABRA sin señal.
 *
 * Es lo que diferencia "funciona mientras la pestaña siga abierta" de
 * "el operario cierra la app en el corral, la vuelve a abrir y sigue trabajando".
 *
 * Subir CACHE cuando cambie index.html / app.js, si no la tablet
 * sigue sirviendo la version vieja desde el cache.
 */
const CACHE = 'preparto-v5';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './manifest.json',
  './img/aed.png',
  './img/aed@2x.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Nunca cachear las llamadas a Apps Script: son datos, no shell.
  // Si se cachearan, la tablet leeria listas viejas y creeria haber sincronizado.
  // Tampoco la libreria de Google: una copia vieja rompe el login en silencio.
  if (req.url.includes('script.google.com') ||
      req.url.includes('googleusercontent.com') ||
      req.url.includes('accounts.google.com') ||
      req.url.includes('gstatic.com')) return;

  // Cache-first: el shell no cambia y asi abre instantaneo y sin red.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && new URL(req.url).origin === location.origin) {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copia));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
