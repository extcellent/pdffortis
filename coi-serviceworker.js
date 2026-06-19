self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", function(event) {
  const url = event.request.url;
  
  // Supabase und andere Auth-Requests direkt durchlassen
  if (url.includes('supabase.co') || url.includes('googleapis.com/identitytoolkit')) {
    return; // Kein respondWith → Browser handled es nativ
  }

  event.respondWith(
    fetch(event.request.clone()).then(function(response) {
      if (!response || response.status === 0 || !response.body) return response;
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
      newHeaders.set("Cross-Origin-Embedder-Policy", "credentialless");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }).catch(() => fetch(event.request.clone()))
  );
});
