/* Daybook — service worker.

   Two jobs: make the board installable as a home-screen app, and keep it
   readable with no connection. Reading works offline; writing does not, and
   the app says so rather than pretending a change was saved. */

const VERSION = "v1";
const SHELL = `tasks-shell-${VERSION}`;
const DATA = `tasks-data-${VERSION}`;

// Only the page itself. The stylesheet and script are requested with an ?v=
// stamp that changes whenever they do, so precaching the bare URL would cache
// a copy nothing ever asks for — they get picked up on the next page load,
// once this worker is in control.
const SHELL_URLS = ["/"];

// GETs worth keeping a copy of. Everything else under /api/ — the session
// check, login, logout, report downloads — must always hit the server.
const CACHEABLE_API = /^\/api\/(tasks|report|months)(\?|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individually, so one 404 can't fail the whole install.
      .then((cache) => Promise.all(SHELL_URLS.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Signing out drops the cached board, so the next person to open the app on
// this device sees a login screen and nothing else.
self.addEventListener("message", (event) => {
  if (event.data === "clear-cache") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

/** Re-issue a cached response with a marker the page can read. */
async function tagAsCached(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Daybook-Cache", "hit");
  return new Response(await response.blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function networkFirst(request, cacheName, { ignoreSearch = false } = {}) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    // A 401 is a real answer, not an outage — pass it through so the login
    // gate appears instead of stale data.
    if (fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  } catch (err) {
    const exact = await cache.match(request);
    if (exact) return tagAsCached(exact);
    if (ignoreSearch) {
      const near = await cache.match(request, { ignoreSearch: true });
      if (near) return tagAsCached(near);
    }
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) {
    // Refresh in the background; the URLs carry an ?v= stamp, so a changed
    // file is a different key and lands here on its first request anyway.
    fetch(request)
      .then((fresh) => fresh.ok && cache.put(request, fresh.clone()))
      .catch(() => {});
    return hit;
  }
  const fresh = await fetch(request);
  if (fresh.ok) cache.put(request, fresh.clone()).catch(() => {});
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // The typeface, so an offline board still looks like itself.
  if (!sameOrigin) {
    if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
      event.respondWith(cacheFirst(request, SHELL));
    }
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (CACHEABLE_API.test(url.pathname + url.search)) {
      // The board falls back across date windows — offline, last week's cells
      // beat an empty screen. A report must not, or it would show the wrong
      // month under the right heading.
      const ignoreSearch = url.pathname === "/api/tasks";
      event.respondWith(networkFirst(request, DATA, { ignoreSearch }));
    }
    return;
  }

  if (url.pathname.startsWith("/static/")) {
    event.respondWith(cacheFirst(request, SHELL));
  }
});
