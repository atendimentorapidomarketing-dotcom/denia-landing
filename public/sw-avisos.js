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
  e.waitUntil((async () => {
    // Lembrete de compromisso = alarme: vibra forte, faz som, fica na tela até tocar; com a DENIA aberta, toca o alarme.
    if (d.alarme) for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) c.postMessage({ alarme: d });
    await self.registration.showNotification(titulo, {
      body: d.texto || "Toque para ver.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: d.tag || undefined,
      renotify: Boolean(d.tag),
      silent: false,
      requireInteraction: Boolean(d.urgente || d.alarme),
      vibrate: d.alarme ? [900, 250, 900, 250, 900, 250, 900, 250, 1500, 400, 900, 250, 900] : [200, 100, 200],
      ...(d.alarme ? { actions: [{ action: "abrir", title: "Ver na agenda" }, { action: "ok", title: "Parar" }] } : {}),
      data: { url: d.url || "/app#/problemas", org: d.org || null }
    });
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  if (e.action === "ok") { e.waitUntil(self.clients.matchAll({ type: "window" }).then(cs => cs.forEach(c => c.postMessage({ pararAlarme: true })))); return; }
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
