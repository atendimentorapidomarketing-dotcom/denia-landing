
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
async function api(url,opts={}){const r=await fetch(url,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});if(r.status===401){location.href='/login';throw new Error('unauthorized')}const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Erro');return j}
$$('#nav button').forEach(b=>b.onclick=()=>{$$('#nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');$$('.page').forEach(p=>p.classList.remove('active'));$('#page-'+b.dataset.page).classList.add('active')});
$('#homeBtn').onclick=()=>{const p=location.pathname;location.href=p.startsWith('/en/')?'/en':p.startsWith('/es/')?'/es':'/'};
$('#logoutBtn').onclick=async()=>{await api('/api/auth/logout',{method:'POST'}).catch(()=>{});const p=location.pathname;location.href=p.startsWith('/en/')?'/en/login':p.startsWith('/es/')?'/es/login':'/login'};
$('#saveTraining').onclick=async()=>{await api('/api/config/training',{method:'POST',body:JSON.stringify({identity:$('#identity').value,rules:$('#rules').value})});alert('Treinamento salvo.')};
$('#saveConfig').onclick=async()=>{await api('/api/config/settings',{method:'POST',body:JSON.stringify({organization:$('#orgInput').value,phone:$('#phoneInput').value})});$('#orgName').textContent=$('#orgInput').value;alert('Configurações salvas.')};
(async()=>{try{const me=await api('/api/me');$('#userName').textContent=me.user.name+' · '+me.user.email;$('#orgName').textContent=me.organization.name;$('#orgInput').value=me.organization.name;const c=await api('/api/config');$('#identity').value=c.training?.identity||'';$('#rules').value=c.training?.rules||'';$('#phoneInput').value=c.settings?.phone||'+55 21 97546-9162';}catch(e){}})();
