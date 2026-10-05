const CACHE='denia-v19-shell';
const SHELL=['/','/app','/login','/cadastro','/styles.css','/app.css','/auth.css','/script.js','/app.js','/pwa.js','/manifest.webmanifest','/icon-192.png','/icon-512.png','/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL).catch(()=>{})));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
 const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.origin!==location.origin)return;
 if(u.pathname.startsWith('/api/')){e.respondWith(fetch(r));return}
 e.respondWith(fetch(r).then(x=>{if(x&&x.ok){const c=x.clone();caches.open(CACHE).then(k=>k.put(r,c)).catch(()=>{})}return x}).catch(()=>caches.match(r).then(h=>h||caches.match('/'))))
});
