self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

// No-op fetch handler — kept as a stub. (It does NOT affect installability or push
// in modern browsers; it is here only so the worker has a fetch listener.)
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = {}; }
  event.waitUntil((async () => {
    // Suppress the notification when the user is already looking at the app.
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (cs.some((c) => c.focused)) return;
    await self.registration.showNotification(d.title || "Pi", {
      body: d.body || "",
      tag: d.tag || "pi",
      data: { url: d.url || "/" },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) { if ("focus" in c) { await c.focus(); return; } }
    await self.clients.openWindow(url);
  })());
});
