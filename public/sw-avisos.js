// DENIA — notificações no celular. Só recebe e mostra avisos: não guarda páginas (o site está sempre atualizado).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k); // limpa o que a versão antiga do site guardou
  await self.clients.claim();
})()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { texto: e.data ? e.data.text() : "" }; }
  const titulo = d.titulo || "DENIA";
  e.waitUntil(self.registration.showNotification(titulo, {
    body: d.texto || "Toque para ver.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || undefined,
    renotify: Boolean(d.tag),
    requireInteraction: Boolean(d.urgente),
    data: { url: d.url || "/app#/problemas", org: d.org || null }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || "/app#/problemas", self.location.origin);
  const org = e.notification.data && e.notification.data.org;
  if (org) alvo.searchParams.set("empresa", String(org));
  e.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of abertas) {
      if (new URL(c.url).origin === alvo.origin) { await c.focus(); try { await c.navigate(alvo.href); } catch { c.postMessage({ abrir: alvo.href }); } return; }
    }
    await self.clients.openWindow(alvo.href);
  })());
});
