// Lets the app open with no connection. App files: network first (so updates show up
// right away), falling back to the cached copy. vendor/ libraries: cache first.
// Microsoft sign-in and OneDrive requests are never touched.
const CACHE = "folio-v1";
const SHELL = [
  "./", "index.html", "app.css", "manifest.webmanifest",
  "js/app.js", "js/auth.js", "js/config.js", "js/editor.js", "js/graph.js", "js/library.js", "js/store.js", "js/tree.js",
  "vendor/editor.js", "vendor/msal.js", "icons/icon-192.png", "icons/icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/vendor/")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetchAndCache(e.request)));
    return;
  }
  e.respondWith(
    fetchAndCache(e.request).catch(() =>
      caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error()))
    )
  );
});

async function fetchAndCache(req) {
  const res = await fetch(req);
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}
