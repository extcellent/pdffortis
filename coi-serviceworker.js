self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", function(event) {
  if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;
  event.respondWith(
    fetch(event.request).then(function(response) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
      newHeaders.set("Cross-Origin-Embedder-Policy", "credentialless");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    })
  );
});
