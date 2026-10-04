
const enc=new TextEncoder();
const J=(d,s=200,h={})=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json;charset=utf-8',...h}});
const hx=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
function rnd(n=32){const b=new Uint8Array(n);crypto.getRandomValues(b);return hx(b)}
async function sha(s){return hx(await crypto.subtle.digest('SHA-256',enc.encode(s)))}
async function hpw(p,saltHex=null){const salt=saltHex?new Uint8Array(saltHex.match(/.{1,2}/g).map(x=>parseInt(x,16))):crypto.getRandomValues(new Uint8Array(16));const k=await crypto.subtle.importKey('raw',enc.encode(p),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:30000},k,256);return{salt:hx(salt),hash:hx(bits)}}
async function schema(env){for(const s of [
`CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'OWNER',created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS organization_config(organization_id TEXT PRIMARY KEY,training_json TEXT DEFAULT '{}',settings_json TEXT DEFAULT '{}',updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS standalone_training(organization_id TEXT NOT NULL,section TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',updated_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,section))`,
`CREATE TABLE IF NOT EXISTS standalone_professionals(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL,phone TEXT DEFAULT '',specialty TEXT DEFAULT '',notes TEXT DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS standalone_conversations(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL,phone TEXT DEFAULT '',ai_paused INTEGER NOT NULL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS standalone_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,direction TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`
])await env.DB.prepare(s).run()}
const cookie=(r,n)=>(r.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(n+'='))?.slice(n.length+1)||null;
async function user(req,env){const t=cookie(req,'denia_session');if(!t)return null;return env.DB.prepare(`SELECT u.id,u.name,u.email,u.role,u.organization_id,o.name organization_name FROM sessions s JOIN users u ON u.id=s.user_id JOIN organizations o ON o.id=u.organization_id WHERE s.token_hash=? AND s.expires_at>datetime('now')`).bind(await sha(t)).first()}
async function session(uid,env){const t=rnd(32);await env.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now','+30 days'))`).bind(await sha(t),uid).run();return t}
async function body(r){try{return await r.json()}catch{return{}}}

async function engineFetchV11(env, path, init = {}) {
  const base = String(env?.DENIA_ENGINE_URL || "").replace(/\/+$/,"");
  const token = String(env?.DENIA_PLATFORM_SERVICE_TOKEN || "");
  if (!base) throw new Error("DENIA_ENGINE_URL não configurada na Platform.");
  if (!/^https?:\/\//i.test(base)) throw new Error("DENIA_ENGINE_URL inválida. Use a URL completa https://... do Worker que responde o WhatsApp.");
  if (!token) throw new Error("DENIA_PLATFORM_SERVICE_TOKEN não configurado na Platform.");

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type","application/json");

  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),10000);
  let r;
  try {
    r = await fetch(base + path, {...init, headers, signal:controller.signal, redirect:"follow"});
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`Timeout consultando a Engine em ${path}. Confira se DENIA_ENGINE_URL aponta para o Worker do WhatsApp.`);
    throw new Error(`Falha de rede consultando a Engine: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await r.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {
    throw new Error(`A Engine retornou conteúdo não-JSON em ${path}. Confirme que DENIA_ENGINE_URL aponta para o Worker da DENIA Engine, não para a landing.`);
  }

  if (!r.ok) {
    const e = new Error(data?.erro || data?.error || data?.detail || `Engine respondeu HTTP ${r.status}`);
    e.status = r.status; e.data = data; throw e;
  }
  return data;
}

export default{async fetch(req,env){
 const url=new URL(req.url);
 try{
  if(!env.DB)return J({error:'D1 binding DB não configurado.'},500);
  await schema(env);
  if(url.pathname==='/api/health'){
    const c=await env.DB.prepare(`SELECT COUNT(*) c FROM users`).first();
    return J({ok:true,d1:true,database:'denia-saas',users:Number(c?.c||0),version:'1.0.0'});
  }
  if(url.pathname==='/health'){
    const c=await env.DB.prepare(`SELECT COUNT(*) c FROM users`).first();
    return new Response(`DENIA Platform V10\nD1: OK\nDatabase: denia-saas\nUsers: ${Number(c?.c||0)}\n`,{headers:{'content-type':'text/plain;charset=utf-8'}});
  }
  if(url.pathname==='/api/auth/bootstrap'&&req.method==='POST'){const c=await env.DB.prepare(`SELECT COUNT(*) c FROM users`).first();if(+c.c>0)return J({error:'O acesso principal já foi criado.'},409);const d=await body(req),name=String(d.name||'').trim(),email=String(d.email||'').trim().toLowerCase(),password=String(d.password||'');if(!name||!email||password.length<10)return J({error:'Preencha os campos corretamente. A senha precisa ter pelo menos 10 caracteres.'},400);const oid=crypto.randomUUID(),uid=crypto.randomUUID(),h=await hpw(password);await env.DB.prepare(`INSERT INTO organizations(id,name) VALUES(?,?)`).bind(oid,'DENIA Operação Principal').run();await env.DB.prepare(`INSERT INTO users(id,organization_id,name,email,password_hash,password_salt,role) VALUES(?,?,?,?,?,?,?)`).bind(uid,oid,name,email,h.hash,h.salt,'SUPER_ADMIN').run();await env.DB.prepare(`INSERT INTO organization_config(organization_id,settings_json) VALUES(?,?)`).bind(oid,JSON.stringify({phone:'+55 21 97546-9162'})).run();const t=await session(uid,env);return J({ok:true},200,{'set-cookie':`denia_session=${t}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`})}
  if(url.pathname==='/api/auth/login'&&req.method==='POST'){const d=await body(req),e=String(d.email||'').trim().toLowerCase(),p=String(d.password||'');const u=await env.DB.prepare(`SELECT * FROM users WHERE email=?`).bind(e).first();if(!u)return J({error:'E-mail ou senha inválidos.'},401);const h=await hpw(p,u.password_salt);if(h.hash!==u.password_hash)return J({error:'E-mail ou senha inválidos.'},401);const t=await session(u.id,env);return J({ok:true},200,{'set-cookie':`denia_session=${t}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`})}
  if(url.pathname==='/api/auth/logout'&&req.method==='POST'){const t=cookie(req,'denia_session');if(t)await env.DB.prepare(`DELETE FROM sessions WHERE token_hash=?`).bind(await sha(t)).run();return J({ok:true},200,{'set-cookie':'denia_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'})}
  if(url.pathname.startsWith('/api/')){const u=await user(req,env);if(!u)return J({error:'Não autenticado.'},401);
    if(url.pathname==='/api/me')return J({user:{id:u.id,name:u.name,email:u.email,role:u.role},organization:{id:u.organization_id,name:u.organization_name}});
    if(url.pathname==='/api/config'&&req.method==='GET'){const c=await env.DB.prepare(`SELECT * FROM organization_config WHERE organization_id=?`).bind(u.organization_id).first();return J({training:JSON.parse(c?.training_json||'{}'),settings:JSON.parse(c?.settings_json||'{}')})}
    if(url.pathname==='/api/config/training'&&req.method==='POST'){const d=await body(req),cur=await env.DB.prepare(`SELECT settings_json FROM organization_config WHERE organization_id=?`).bind(u.organization_id).first();await env.DB.prepare(`INSERT INTO organization_config(organization_id,training_json,settings_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(organization_id) DO UPDATE SET training_json=excluded.training_json,updated_at=CURRENT_TIMESTAMP`).bind(u.organization_id,JSON.stringify(d),cur?.settings_json||'{}').run();return J({ok:true})}
    if(url.pathname==='/api/config/settings'&&req.method==='POST'){const d=await body(req),name=String(d.organization||u.organization_name).trim();await env.DB.prepare(`UPDATE organizations SET name=? WHERE id=?`).bind(name,u.organization_id).run();const cur=await env.DB.prepare(`SELECT training_json FROM organization_config WHERE organization_id=?`).bind(u.organization_id).first();await env.DB.prepare(`INSERT INTO organization_config(organization_id,training_json,settings_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(organization_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=CURRENT_TIMESTAMP`).bind(u.organization_id,cur?.training_json||'{}',JSON.stringify(d)).run();return J({ok:true})}
    if(url.pathname==='/api/engine/diagnostic'&&req.method==='GET'){
      const base=String(env?.DENIA_ENGINE_URL||'').replace(/\/+$/,'');
      const token=String(env?.DENIA_PLATFORM_SERVICE_TOKEN||'');
      try{
        const status=await engineFetchV11(env,'/platform/status');
        return J({ok:true,engine_url:base,token_configured:Boolean(token),engine:status});
      }catch(e){
        return J({ok:false,engine_url:base,token_configured:Boolean(token),error:e.message},e.status||502);
      }
    }
    if(url.pathname==='/api/engine/status'&&req.method==='GET'){
      try{return J(await engineFetchV11(env,'/platform/status'))}
      catch(e){return J({sucesso:false,error:e.message,connected:false},e.status||502)}
    }
    if(url.pathname==='/api/engine/conversations'&&req.method==='GET'){
      try{return J(await engineFetchV11(env,'/platform/conversations?limit=150'))}
      catch(e){return J({sucesso:false,error:e.message},e.status||502)}
    }
    const convMatch=url.pathname.match(/^\/api\/engine\/conversations\/(\d+)$/);
    if(convMatch&&req.method==='GET'){
      try{return J(await engineFetchV11(env,`/platform/conversations/${convMatch[1]}`))}
      catch(e){return J({sucesso:false,error:e.message},e.status||502)}
    }
    const sendMatch=url.pathname.match(/^\/api\/engine\/conversations\/(\d+)\/send$/);
    if(sendMatch&&req.method==='POST'){
      try{return J(await engineFetchV11(env,`/platform/conversations/${sendMatch[1]}/send`,{method:'POST',body:JSON.stringify(await body(req))}))}
      catch(e){return J({sucesso:false,error:e.message},e.status||502)}
    }
    const takeMatch=url.pathname.match(/^\/api\/engine\/conversations\/(\d+)\/takeover$/);
    if(takeMatch&&req.method==='POST'){
      try{return J(await engineFetchV11(env,`/platform/conversations/${takeMatch[1]}/takeover`,{method:'POST'}))}
      catch(e){return J({sucesso:false,error:e.message},e.status||502)}
    }
    const relMatch=url.pathname.match(/^\/api\/engine\/conversations\/(\d+)\/release$/);
    if(relMatch&&req.method==='POST'){
      try{return J(await engineFetchV11(env,`/platform/conversations/${relMatch[1]}/release`,{method:'POST'}))}
      catch(e){return J({sucesso:false,error:e.message},e.status||502)}
    }
    if(url.pathname==='/api/engine/training'&&req.method==='GET'){
      try{return J(await engineFetchV11(env,'/platform/training'))}
      catch(e){return J({sucesso:false,error:e.message},e.status||502)}
    }
    if(url.pathname==='/api/engine/training'&&req.method==='POST'){
      try{return J(await engineFetchV11(env,'/platform/training',{method:'POST',body:JSON.stringify(await body(req))}))}
      catch(e){return J({sucesso:false,error:e.message},e.status||502)}
    }
    if(url.pathname==='/api/engine/professionals'&&req.method==='GET'){
      try{return J(await engineFetchV11(env,'/platform/professionals'))}
      catch(e){return J({sucesso:false,error:e.message},e.status||502)}
    }


    // ----- DENIA V13 STANDALONE -----
    if(url.pathname==='/api/standalone/summary'&&req.method==='GET'){
      const pc=await env.DB.prepare(`SELECT COUNT(*) c FROM standalone_professionals WHERE organization_id=? AND active=1`).bind(u.organization_id).first();
      const cc=await env.DB.prepare(`SELECT COUNT(*) c FROM standalone_conversations WHERE organization_id=?`).bind(u.organization_id).first();
      return J({professionals:Number(pc?.c||0),conversations:Number(cc?.c||0)});
    }

    if(url.pathname==='/api/standalone/training'&&req.method==='GET'){
      const r=await env.DB.prepare(`SELECT section,content,updated_at FROM standalone_training WHERE organization_id=?`).bind(u.organization_id).all();
      const training={}; for(const row of (r?.results||[])) training[row.section]=row.content;
      return J({training});
    }
    if(url.pathname==='/api/standalone/training'&&req.method==='POST'){
      const d=await body(req),section=String(d.section||'').trim(),content=String(d.content||'');
      if(!section)return J({error:'Seção inválida.'},400);
      await env.DB.prepare(`INSERT INTO standalone_training(organization_id,section,content,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(organization_id,section) DO UPDATE SET content=excluded.content,updated_at=CURRENT_TIMESTAMP`).bind(u.organization_id,section,content).run();
      return J({ok:true});
    }

    if(url.pathname==='/api/standalone/professionals'&&req.method==='GET'){
      const r=await env.DB.prepare(`SELECT * FROM standalone_professionals WHERE organization_id=? AND active=1 ORDER BY name`).bind(u.organization_id).all();
      return J({professionals:r?.results||[]});
    }
    if(url.pathname==='/api/standalone/professionals'&&req.method==='POST'){
      const d=await body(req),name=String(d.name||'').trim();
      if(!name)return J({error:'Informe o nome.'},400);
      const id=crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO standalone_professionals(id,organization_id,name,phone,specialty,notes) VALUES(?,?,?,?,?,?)`)
        .bind(id,u.organization_id,name,String(d.phone||''),String(d.specialty||''),String(d.notes||'')).run();
      return J({ok:true,id});
    }
    const proDel=url.pathname.match(/^\/api\/standalone\/professionals\/([^/]+)$/);
    if(proDel&&req.method==='DELETE'){
      await env.DB.prepare(`UPDATE standalone_professionals SET active=0 WHERE id=? AND organization_id=?`).bind(proDel[1],u.organization_id).run();
      return J({ok:true});
    }

    if(url.pathname==='/api/standalone/conversations'&&req.method==='GET'){
      const r=await env.DB.prepare(`SELECT * FROM standalone_conversations WHERE organization_id=? ORDER BY datetime(updated_at) DESC`).bind(u.organization_id).all();
      return J({conversations:r?.results||[]});
    }
    if(url.pathname==='/api/standalone/conversations'&&req.method==='POST'){
      const d=await body(req),name=String(d.name||'Cliente de teste').trim(),id=crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO standalone_conversations(id,organization_id,name,phone) VALUES(?,?,?,?)`).bind(id,u.organization_id,name,String(d.phone||'')).run();
      await env.DB.prepare(`INSERT INTO standalone_messages(id,conversation_id,direction,content) VALUES(?,?,?,?)`).bind(crypto.randomUUID(),id,'in','Olá! Esta é uma conversa de teste da plataforma.').run();
      return J({ok:true,id});
    }
    if(url.pathname==='/api/standalone/conversations/clear'&&req.method==='POST'){
      const ids=await env.DB.prepare(`SELECT id FROM standalone_conversations WHERE organization_id=?`).bind(u.organization_id).all();
      for(const c of (ids?.results||[])) await env.DB.prepare(`DELETE FROM standalone_messages WHERE conversation_id=?`).bind(c.id).run();
      await env.DB.prepare(`DELETE FROM standalone_conversations WHERE organization_id=?`).bind(u.organization_id).run();
      return J({ok:true});
    }
    const conv=url.pathname.match(/^\/api\/standalone\/conversations\/([^/]+)$/);
    if(conv&&req.method==='GET'){
      const c=await env.DB.prepare(`SELECT * FROM standalone_conversations WHERE id=? AND organization_id=?`).bind(conv[1],u.organization_id).first();
      if(!c)return J({error:'Conversa não encontrada.'},404);
      const m=await env.DB.prepare(`SELECT * FROM standalone_messages WHERE conversation_id=? ORDER BY datetime(created_at),rowid`).bind(conv[1]).all();
      return J({conversation:c,messages:m?.results||[]});
    }
    const convSend=url.pathname.match(/^\/api\/standalone\/conversations\/([^/]+)\/messages$/);
    if(convSend&&req.method==='POST'){
      const d=await body(req),content=String(d.content||'').trim();
      if(!content)return J({error:'Mensagem vazia.'},400);
      const c=await env.DB.prepare(`SELECT id FROM standalone_conversations WHERE id=? AND organization_id=?`).bind(convSend[1],u.organization_id).first();
      if(!c)return J({error:'Conversa não encontrada.'},404);
      await env.DB.prepare(`INSERT INTO standalone_messages(id,conversation_id,direction,content) VALUES(?,?,?,?)`).bind(crypto.randomUUID(),convSend[1],'out',content).run();
      await env.DB.prepare(`UPDATE standalone_conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(convSend[1]).run();
      return J({ok:true});
    }
    const convPause=url.pathname.match(/^\/api\/standalone\/conversations\/([^/]+)\/pause$/);
    if(convPause&&req.method==='POST'){
      const d=await body(req),paused=d.paused?1:0;
      await env.DB.prepare(`UPDATE standalone_conversations SET ai_paused=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`).bind(paused,convPause[1],u.organization_id).run();
      return J({ok:true,paused:Boolean(paused)});
    }

    return J({error:'Endpoint não encontrado.'},404)
  }
  if(url.pathname==='/en')return env.ASSETS.fetch(new URL('/index-en.html',url));
  if(url.pathname==='/es')return env.ASSETS.fetch(new URL('/index-es.html',url));
  if(url.pathname==='/login')return env.ASSETS.fetch(new URL('/login.html',url));
  if(url.pathname==='/en/login')return env.ASSETS.fetch(new URL('/login-en.html',url));
  if(url.pathname==='/es/login')return env.ASSETS.fetch(new URL('/login-es.html',url));
  if(url.pathname==='/cadastro')return env.ASSETS.fetch(new URL('/cadastro.html',url));
  if(url.pathname==='/en/signup')return env.ASSETS.fetch(new URL('/cadastro-en.html',url));
  if(url.pathname==='/es/registro')return env.ASSETS.fetch(new URL('/cadastro-es.html',url));
  if(url.pathname==='/app'||url.pathname.startsWith('/app/')){const u=await user(req,env);if(!u)return Response.redirect(new URL('/login',url),302);return env.ASSETS.fetch(new URL('/app.html',url))}
  if(url.pathname==='/en/app'){const u=await user(req,env);if(!u)return Response.redirect(new URL('/en/login',url),302);return env.ASSETS.fetch(new URL('/app-en.html',url))}
  if(url.pathname==='/es/app'){const u=await user(req,env);if(!u)return Response.redirect(new URL('/es/login',url),302);return env.ASSETS.fetch(new URL('/app-es.html',url))}
  return env.ASSETS.fetch(req);
 }catch(e){console.error(e);return J({error:'Erro interno da plataforma.',detail:String(e?.message||e)},500)}
}}
